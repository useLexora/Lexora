import type { AiModelCapability, AiModelModality, AiModelType } from '@haohaoxue/lexora-contracts'
import type { OnModuleInit } from '@nestjs/common'
import type { AiModelCapabilityDefault, Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import {
  AiModelCapabilitySchema,
  AiModelModalitySchema,
  AiModelTypeSchema,
} from '@haohaoxue/lexora-contracts'
import { Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'
import { PrismaService } from '../../../database/prisma.service'
import {
  toDomainCapability,
  toDomainModality,
  toDomainModelType,
  toPrismaCapability,
  toPrismaModality,
  toPrismaModelType,
} from '../ai.utils'
import generatedDefaults from '../generated/model-capability-defaults.generated.json'

const OptionalLimitSchema = z.number().int().positive().nullable()

const ModelCapabilityDefaultEntrySchema = z.object({
  modelId: z.string().trim().min(1),
  modelName: z.string().trim().min(1),
  modelType: AiModelTypeSchema,
  inputModalities: z.array(AiModelModalitySchema).min(1),
  outputModalities: z.array(AiModelModalitySchema).min(1),
  capabilities: z.array(AiModelCapabilitySchema),
  limits: z.object({
    contextWindow: OptionalLimitSchema,
    maxOutputTokens: OptionalLimitSchema,
  }).strict(),
}).strict()

const ModelCapabilityDefaultsSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  models: z.array(ModelCapabilityDefaultEntrySchema),
}).strict()

export type ModelCapabilityDefaultEntry = z.infer<typeof ModelCapabilityDefaultEntrySchema>
export type ModelCapabilityDefaults = z.infer<typeof ModelCapabilityDefaultsSchema>

export interface ModelCapabilityDefaultsSyncResult {
  defaultsVersion: string
  modelCount: number
}

export interface EffectiveModelCapabilityDefaults {
  modelId: string
  modelName: string
  modelType: AiModelType
  inputModalities: AiModelModality[]
  outputModalities: AiModelModality[]
  capabilities: AiModelCapability[]
  contextWindow: number | null
  maxOutputTokens: number | null
}

@Injectable()
export class AiModelCapabilityDefaultsService implements OnModuleInit {
  private readonly logger = new Logger(AiModelCapabilityDefaultsService.name)
  private currentDefaultsCache: EffectiveModelCapabilityDefaults[] | null = null

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.syncGeneratedDefaults().catch((error) => {
      this.logger.warn(`sync model capability defaults failed: ${getErrorMessage(error)}`)
    })
  }

  parseGeneratedDefaults(): ModelCapabilityDefaults {
    return ModelCapabilityDefaultsSchema.parse(generatedDefaults)
  }

  async syncGeneratedDefaults(): Promise<ModelCapabilityDefaultsSyncResult> {
    const defaults = this.parseGeneratedDefaults()
    const defaultsVersion = this.buildDefaultsVersion(defaults)

    if (await this.isDefaultsVersionCurrent(defaultsVersion, defaults.models.length)) {
      this.currentDefaultsCache = await this.loadCurrentDefaults()
      await this.backfillProviderModelsFromDefaults(this.currentDefaultsCache)
      return {
        defaultsVersion,
        modelCount: defaults.models.length,
      }
    }

    await this.prisma.$bypass.$transaction([
      ...defaults.models.map(model =>
        this.prisma.$bypass.aiModelCapabilityDefault.upsert({
          where: { modelId: model.modelId },
          update: this.toCapabilityDefaultWrite(model, defaultsVersion),
          create: {
            ...this.toCapabilityDefaultWrite(model, defaultsVersion),
            modelId: model.modelId,
          },
        }),
      ),
      this.prisma.$bypass.aiModelCapabilityDefault.deleteMany({
        where: {
          defaultsVersion: { not: defaultsVersion },
        },
      }),
    ])
    this.currentDefaultsCache = await this.loadCurrentDefaults()
    await this.backfillProviderModelsFromDefaults(this.currentDefaultsCache)

    return {
      defaultsVersion,
      modelCount: defaults.models.length,
    }
  }

  async getCurrentDefaults(): Promise<EffectiveModelCapabilityDefaults[]> {
    if (this.currentDefaultsCache) {
      return cloneEffectiveDefaults(this.currentDefaultsCache)
    }

    try {
      this.currentDefaultsCache = await this.loadCurrentDefaults()
    }
    catch (error) {
      this.logger.warn(`load model capability defaults failed: ${getErrorMessage(error)}`)
      return []
    }

    return cloneEffectiveDefaults(this.currentDefaultsCache)
  }

  private async isDefaultsVersionCurrent(defaultsVersion: string, modelCount: number): Promise<boolean> {
    const [currentCount, staleCount] = await Promise.all([
      this.prisma.aiModelCapabilityDefault.count({
        where: { defaultsVersion },
      }),
      this.prisma.aiModelCapabilityDefault.count({
        where: {
          defaultsVersion: { not: defaultsVersion },
        },
      }),
    ])

    return currentCount === modelCount && staleCount === 0
  }

  private async loadCurrentDefaults(): Promise<EffectiveModelCapabilityDefaults[]> {
    const defaults = await this.prisma.aiModelCapabilityDefault.findMany({
      orderBy: [
        { modelType: 'asc' },
        { modelId: 'asc' },
      ],
    })

    return defaults.map(toEffectiveDefaults)
  }

  private async backfillProviderModelsFromDefaults(defaults: EffectiveModelCapabilityDefaults[]): Promise<void> {
    const models = await this.prisma.aiProviderModel.findMany({
      where: { capabilityConfiguredAt: null },
      include: {
        provider: {
          select: {
            providerKey: true,
          },
        },
      },
    })
    const writes: Prisma.PrismaPromise<unknown>[] = []
    for (const model of models) {
      const matchedDefaults = this.matchProviderModelDefault({
        defaults,
        providerKey: model.provider.providerKey,
        modelId: model.modelId,
      })

      if (!matchedDefaults) {
        continue
      }
      if (isProviderModelCapabilityEqual(model, matchedDefaults)) {
        continue
      }

      writes.push(this.prisma.$bypass.aiProviderModel.update({
        where: { id: model.id },
        data: {
          modelType: toPrismaModelType(matchedDefaults.modelType),
          inputModalities: matchedDefaults.inputModalities.map(toPrismaModality),
          outputModalities: matchedDefaults.outputModalities.map(toPrismaModality),
          capabilities: matchedDefaults.capabilities.map(toPrismaCapability),
          contextWindow: matchedDefaults.contextWindow,
          maxOutputTokens: matchedDefaults.maxOutputTokens,
        },
      }))
    }

    if (writes.length > 0) {
      await this.prisma.$bypass.$transaction(writes)
    }
  }

  matchProviderModelDefault(input: {
    defaults: EffectiveModelCapabilityDefaults[]
    providerKey: string
    modelId: string
  }): EffectiveModelCapabilityDefaults | null {
    const normalizedModelId = input.modelId.trim()
    if (!normalizedModelId) {
      return null
    }

    const providerKeys = getProviderDefaultKeys(input.providerKey)
    const modelIdKeys = getModelDefaultIdKeys(normalizedModelId)

    for (const modelIdKey of modelIdKeys) {
      const exact = input.defaults.find(model => model.modelId.toLowerCase() === modelIdKey)
      if (exact) {
        return exact
      }

      for (const providerKey of providerKeys) {
        const providerQualified = input.defaults.find(model => model.modelId.toLowerCase() === `${providerKey}/${modelIdKey}`)
        if (providerQualified) {
          return providerQualified
        }
      }

      const suffixMatches = input.defaults.filter(model => model.modelId.toLowerCase().endsWith(`/${modelIdKey}`))
      for (const providerKey of providerKeys) {
        const providerMatched = suffixMatches.find(model => model.modelId.toLowerCase().startsWith(`${providerKey}/`))
        if (providerMatched) {
          return providerMatched
        }
      }

      if (suffixMatches.length === 1) {
        return suffixMatches[0]
      }
    }

    return null
  }

  private buildDefaultsVersion(defaults: ModelCapabilityDefaults): string {
    const hash = createHash('sha256')
      .update(JSON.stringify(defaults.models))
      .digest('hex')
      .slice(0, 16)

    return `${defaults.schemaVersion}:${hash}`
  }

  private toCapabilityDefaultWrite(model: ModelCapabilityDefaultEntry, defaultsVersion: string) {
    return {
      defaultsVersion,
      modelName: model.modelName,
      modelType: toPrismaModelType(model.modelType),
      inputModalities: model.inputModalities.map(toPrismaModality),
      outputModalities: model.outputModalities.map(toPrismaModality),
      capabilities: model.capabilities.map(toPrismaCapability),
      contextWindow: model.limits.contextWindow,
      maxOutputTokens: model.limits.maxOutputTokens,
    }
  }
}

function getProviderDefaultKeys(providerKey: string): string[] {
  const normalizedProviderKey = providerKey.trim().toLowerCase()
  return [...new Set([
    normalizedProviderKey,
    normalizedProviderKey.replace(/-compatible$/, ''),
  ].filter(Boolean))]
}

function getModelDefaultIdKeys(modelId: string): string[] {
  const normalizedModelId = modelId.trim().toLowerCase()
  const lastSegment = normalizedModelId.split('/').at(-1) ?? normalizedModelId
  const openAiAlias = lastSegment.match(/^gpt-\d+(?:\.\d+)?(?:-(?:chat|codex|mini|nano|pro))?/)?.[0]

  return [...new Set([
    normalizedModelId,
    openAiAlias,
    ...getClaudeModelDefaultIdKeys(normalizedModelId),
  ].filter((value): value is string => Boolean(value)))]
}

function getClaudeModelDefaultIdKeys(modelId: string): string[] {
  const keys: string[] = []
  const normalizedModelId = modelId.trim().toLowerCase()
  const addKey = (key: string) => {
    if (!keys.includes(key)) {
      keys.push(key)
    }
  }

  const familyMinorMatch = normalizedModelId.match(/(?:^|[^a-z0-9])claude-(opus|sonnet|haiku)-(\d{1,2})-(\d{1,2})(?:-20\d{6})?(?=$|[^a-z0-9])/)
  if (familyMinorMatch) {
    const family = familyMinorMatch[1]
    const major = familyMinorMatch[2]
    const minor = familyMinorMatch[3]
    addKey(`claude-${family}-${major}.${minor}`)
    addKey(`claude-${family}-${major}-${minor}`)
  }

  const versionMinorMatch = normalizedModelId.match(/(?:^|[^a-z0-9])claude-(\d{1,2})-(\d{1,2})-(opus|sonnet|haiku)(?:-20\d{6})?(?=$|[^a-z0-9])/)
  if (versionMinorMatch) {
    const major = versionMinorMatch[1]
    const minor = versionMinorMatch[2]
    const family = versionMinorMatch[3]
    addKey(`claude-${major}.${minor}-${family}`)
    addKey(`claude-${major}-${minor}-${family}`)
  }

  const canonicalMinorMatch = normalizedModelId.match(/(?:^|[^a-z0-9])(claude-(?:(?:opus|sonnet|haiku)-\d{1,2}\.\d{1,2}|\d{1,2}\.\d{1,2}-(?:opus|sonnet|haiku)))(?=$|[^a-z0-9])/)
  if (canonicalMinorMatch) {
    addKey(canonicalMinorMatch[1])
  }

  const familyMajorMatch = normalizedModelId.match(/(?:^|[^a-z0-9])claude-(opus|sonnet|haiku)-(\d{1,2})(?:-20\d{6})?(?!-\d)(?=$|[^a-z0-9])/)
  if (familyMajorMatch) {
    addKey(`claude-${familyMajorMatch[1]}-${familyMajorMatch[2]}`)
  }

  const versionMajorMatch = normalizedModelId.match(/(?:^|[^a-z0-9])claude-(\d{1,2})-(opus|sonnet|haiku)(?:-20\d{6})?(?!-\d)(?=$|[^a-z0-9])/)
  if (versionMajorMatch) {
    addKey(`claude-${versionMajorMatch[1]}-${versionMajorMatch[2]}`)
  }

  const canonicalMajorMatch = normalizedModelId.match(/(?:^|[^a-z0-9])(claude-(?:(?:opus|sonnet|haiku)-\d{1,2}|\d{1,2}-(?:opus|sonnet|haiku)))(?!-\d)(?=$|[^a-z0-9])/)
  if (canonicalMajorMatch) {
    addKey(canonicalMajorMatch[1])
  }

  return keys
}

function toEffectiveDefaults(model: AiModelCapabilityDefault): EffectiveModelCapabilityDefaults {
  return {
    modelId: model.modelId,
    modelName: model.modelName,
    modelType: toDomainModelType(model.modelType),
    inputModalities: model.inputModalities.map(toDomainModality),
    outputModalities: model.outputModalities.map(toDomainModality),
    capabilities: model.capabilities.map(toDomainCapability),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  }
}

function cloneEffectiveDefaults(defaults: EffectiveModelCapabilityDefaults[]): EffectiveModelCapabilityDefaults[] {
  return defaults.map(model => ({
    ...model,
    inputModalities: [...model.inputModalities],
    outputModalities: [...model.outputModalities],
    capabilities: [...model.capabilities],
  }))
}

function isProviderModelCapabilityEqual(
  model: {
    modelType: AiModelCapabilityDefault['modelType']
    inputModalities: AiModelCapabilityDefault['inputModalities']
    outputModalities: AiModelCapabilityDefault['outputModalities']
    capabilities: AiModelCapabilityDefault['capabilities']
    contextWindow: number | null
    maxOutputTokens: number | null
  },
  defaults: EffectiveModelCapabilityDefaults,
): boolean {
  return toDomainModelType(model.modelType) === defaults.modelType
    && isSameSet(model.inputModalities.map(toDomainModality), defaults.inputModalities)
    && isSameSet(model.outputModalities.map(toDomainModality), defaults.outputModalities)
    && isSameSet(model.capabilities.map(toDomainCapability), defaults.capabilities)
    && model.contextWindow === defaults.contextWindow
    && model.maxOutputTokens === defaults.maxOutputTokens
}

function isSameSet<T>(left: T[], right: T[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  const rightSet = new Set(right)
  return left.every(item => rightSet.has(item))
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'unknown error'
}

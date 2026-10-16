import type { AiProviderModelItem, AiProviderModels } from '@haohaoxue/lexora-contracts'
import type { AiProvider } from '@prisma/client'
import type {
  UpsertAiProviderModelDto,
  UpsertAiProviderModelsDto,
} from '../ai.dto'
import type { EffectiveModelCapabilityDefaults } from './capability-defaults.service'
import { AI_MODEL_MODALITY, AI_MODEL_TYPE } from '@haohaoxue/lexora-contracts'
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../../database/prisma.service'
import {
  getDefaultModelModalities,
  toPrismaCapability,
  toPrismaModality,
  toPrismaModelType,
  toProviderModelItem,
} from '../ai.utils'
import { AiProviderAdaptersService, inferProviderModelType } from '../providers/adapters.service'
import { AiModelCapabilityDefaultsService } from './capability-defaults.service'

type ProviderModelCandidate = Omit<AiProviderModelItem, 'enabled' | 'updatedAt'>

@Injectable()
export class AiProviderModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adaptersService: AiProviderAdaptersService,
    private readonly capabilityDefaultsService: AiModelCapabilityDefaultsService,
  ) {}

  async getPlatformModels(providerId: string): Promise<AiProviderModels> {
    const provider = await this.assertPlatformProvider(providerId)
    return {
      models: await this.getModels(provider),
    }
  }

  async getUserModels(userId: string, providerId: string): Promise<AiProviderModels> {
    const provider = await this.assertUserProvider(userId, providerId)
    return {
      models: await this.getModels(provider),
    }
  }

  async discoverPlatformProviderModels(providerId: string): Promise<AiProviderModels> {
    const provider = await this.assertPlatformProvider(providerId)
    return this.discoverProviderModels(provider)
  }

  async discoverUserProviderModels(
    userId: string,
    providerId: string,
  ): Promise<AiProviderModels> {
    const provider = await this.assertUserProvider(userId, providerId)
    return this.discoverProviderModels(provider)
  }

  async upsertPlatformModel(providerId: string, payload: UpsertAiProviderModelDto): Promise<AiProviderModelItem> {
    const provider = await this.assertPlatformProvider(providerId)
    return this.upsertModel(provider, payload)
  }

  async upsertUserModel(userId: string, providerId: string, payload: UpsertAiProviderModelDto): Promise<AiProviderModelItem> {
    const provider = await this.assertUserProvider(userId, providerId)
    return this.upsertModel(provider, payload)
  }

  async upsertPlatformModels(providerId: string, payload: UpsertAiProviderModelsDto): Promise<AiProviderModels> {
    const provider = await this.assertPlatformProvider(providerId)
    return this.upsertModels(provider, payload)
  }

  async upsertUserModels(userId: string, providerId: string, payload: UpsertAiProviderModelsDto): Promise<AiProviderModels> {
    const provider = await this.assertUserProvider(userId, providerId)
    return this.upsertModels(provider, payload)
  }

  private async getModels(provider: AiProvider) {
    const models = await this.prisma.aiProviderModel.findMany({
      where: { providerId: provider.id },
      orderBy: [
        { modelType: 'asc' },
        { modelName: 'asc' },
      ],
    })

    return models.map(toProviderModelItem)
  }

  private async discoverProviderModels(provider: AiProvider): Promise<AiProviderModels> {
    const providerModels = await this.adaptersService.fetchProviderModels(provider)
    const capabilityDefaults = await this.capabilityDefaultsService.getCurrentDefaults()
    const candidates = [...new Map(providerModels.map((model) => {
      const modelId = model.modelId.trim()
      const defaults = this.capabilityDefaultsService.matchProviderModelDefault({
        defaults: capabilityDefaults,
        providerKey: provider.providerKey,
        modelId,
      })
      const mergedModel = this.mergeDiscoveredModelWithDefaults(model, defaults)

      return [
        modelId,
        {
          providerId: provider.id,
          modelId,
          modelName: mergedModel.modelName,
          modelType: mergedModel.modelType,
          inputModalities: mergedModel.inputModalities,
          outputModalities: mergedModel.outputModalities,
          capabilities: mergedModel.capabilities,
          contextWindow: mergedModel.contextWindow,
          maxOutputTokens: mergedModel.maxOutputTokens,
        } satisfies ProviderModelCandidate,
      ]
    })).values()]

    return {
      models: await this.mergeStoredStatus(provider, candidates),
    }
  }

  private async mergeStoredStatus(provider: AiProvider, candidates: ProviderModelCandidate[]) {
    const storedModels = await this.prisma.aiProviderModel.findMany({
      where: {
        providerId: provider.id,
        modelId: { in: candidates.map(model => model.modelId) },
      },
    })
    const storedModelById = new Map(storedModels.map(model => [model.modelId, model]))

    return candidates.map((candidate) => {
      const storedModel = storedModelById.get(candidate.modelId)
      if (!storedModel) {
        return {
          ...candidate,
          enabled: false,
        }
      }

      return toProviderModelItem(storedModel)
    })
  }

  private mergeDiscoveredModelWithDefaults(
    model: Omit<ProviderModelCandidate, 'providerId'>,
    defaults: EffectiveModelCapabilityDefaults | null,
  ): Omit<ProviderModelCandidate, 'providerId'> {
    const modelType = defaults?.modelType ?? model.modelType
    const defaultModalities = getDefaultModelModalities(modelType)

    return {
      modelId: model.modelId.trim(),
      modelName: resolveDiscoveredModelName(model.modelId, model.modelName, defaults),
      modelType,
      inputModalities: model.inputModalities.length
        ? model.inputModalities
        : defaults?.inputModalities ?? defaultModalities.inputModalities,
      outputModalities: model.outputModalities.length
        ? model.outputModalities
        : defaults?.outputModalities ?? defaultModalities.outputModalities,
      capabilities: [...new Set([
        ...model.capabilities,
        ...(defaults?.capabilities ?? []),
      ])],
      contextWindow: model.contextWindow ?? defaults?.contextWindow ?? null,
      maxOutputTokens: model.maxOutputTokens ?? defaults?.maxOutputTokens ?? null,
    }
  }

  private async upsertModels(provider: AiProvider, payload: UpsertAiProviderModelsDto): Promise<AiProviderModels> {
    const capabilityDefaults = await this.capabilityDefaultsService.getCurrentDefaults()

    await this.prisma.$bypass.$transaction(
      payload.models.map(model => this.buildUpsertModelQuery(provider, model, capabilityDefaults)),
    )

    return {
      models: await this.getModels(provider),
    }
  }

  private async upsertModel(provider: AiProvider, payload: UpsertAiProviderModelDto) {
    const capabilityDefaults = await this.capabilityDefaultsService.getCurrentDefaults()
    const item = await this.buildUpsertModelQuery(provider, payload, capabilityDefaults)

    return toProviderModelItem(item)
  }

  private buildUpsertModelQuery(
    provider: AiProvider,
    payload: UpsertAiProviderModelDto,
    capabilityDefaults: EffectiveModelCapabilityDefaults[],
  ) {
    const modelId = payload.modelId.trim()
    const modelName = payload.modelName.trim()
    if (!modelId || !modelName) {
      throw new BadRequestException('模型 ID 和模型名称不能为空')
    }
    const defaults = this.capabilityDefaultsService.matchProviderModelDefault({
      defaults: capabilityDefaults,
      providerKey: provider.providerKey,
      modelId,
    })
    const modelType = payload.modelType ?? defaults?.modelType ?? inferProviderModelType(modelId)
    const defaultModalities = getDefaultModelModalities(modelType)
    const inputModalities = payload.inputModalities ?? defaults?.inputModalities ?? defaultModalities.inputModalities
    const outputModalities = payload.outputModalities ?? defaults?.outputModalities ?? defaultModalities.outputModalities
    const capabilities = payload.capabilities ?? defaults?.capabilities ?? []
    const contextWindow = payload.contextWindow !== undefined ? payload.contextWindow : defaults?.contextWindow ?? null
    const maxOutputTokens = payload.maxOutputTokens !== undefined ? payload.maxOutputTokens : defaults?.maxOutputTokens ?? null
    const enabled = payload.enabled ?? true
    const capabilityConfiguredAt = new Date()
    validateModelConfiguration({
      modelType,
      inputModalities,
      outputModalities,
      contextWindow,
      maxOutputTokens,
    })

    return this.prisma.$bypass.aiProviderModel.upsert({
      where: {
        providerId_modelId: {
          providerId: provider.id,
          modelId,
        },
      },
      update: {
        modelName,
        modelType: toPrismaModelType(modelType),
        inputModalities: inputModalities.map(toPrismaModality),
        outputModalities: outputModalities.map(toPrismaModality),
        capabilities: capabilities.map(toPrismaCapability),
        contextWindow,
        maxOutputTokens,
        capabilityConfiguredAt,
        enabled,
        deletedAt: null,
      },
      create: {
        providerId: provider.id,
        modelId,
        modelName,
        modelType: toPrismaModelType(modelType),
        inputModalities: inputModalities.map(toPrismaModality),
        outputModalities: outputModalities.map(toPrismaModality),
        capabilities: capabilities.map(toPrismaCapability),
        contextWindow,
        maxOutputTokens,
        capabilityConfiguredAt,
        enabled,
        deletedAt: null,
      },
    })
  }

  private async assertPlatformProvider(providerId: string) {
    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: providerId,
        scope: 'PLATFORM',
      },
    })

    if (!provider) {
      throw new NotFoundException('服务商不存在')
    }

    return provider
  }

  private async assertUserProvider(userId: string, providerId: string) {
    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: providerId,
        scope: 'USER',
        ownerUserId: userId,
      },
    })

    if (!provider) {
      throw new NotFoundException('服务商不存在')
    }

    return provider
  }
}

function validateModelConfiguration(input: {
  modelType: AiProviderModelItem['modelType']
  inputModalities: AiProviderModelItem['inputModalities']
  outputModalities: AiProviderModelItem['outputModalities']
  contextWindow: number | null
  maxOutputTokens: number | null
}) {
  if (input.inputModalities.length === 0) {
    throw new BadRequestException('输入模态至少选择一项')
  }
  if (input.outputModalities.length === 0) {
    throw new BadRequestException('输出模态至少选择一项')
  }
  if (input.contextWindow !== null && input.maxOutputTokens !== null && input.maxOutputTokens > input.contextWindow) {
    throw new BadRequestException('最大输出不能大于上下文窗口')
  }

  if (input.modelType === AI_MODEL_TYPE.CHAT) {
    assertContains(input.inputModalities, AI_MODEL_MODALITY.TEXT, '对话生成模型必须支持文本输入')
    assertContains(input.outputModalities, AI_MODEL_MODALITY.TEXT, '对话生成模型必须支持文本输出')
    return
  }
  if (input.modelType === AI_MODEL_TYPE.EMBEDDING) {
    assertContains(input.inputModalities, AI_MODEL_MODALITY.TEXT, '向量模型必须支持文本输入')
    assertContains(input.outputModalities, AI_MODEL_MODALITY.EMBEDDING, '向量模型必须输出向量')
    return
  }
  if (input.modelType === AI_MODEL_TYPE.RERANK) {
    assertContains(input.inputModalities, AI_MODEL_MODALITY.TEXT, '重排模型必须支持文本输入')
    assertContains(input.outputModalities, AI_MODEL_MODALITY.TEXT, '重排模型必须输出文本相关结果')
    return
  }
  if (input.modelType === AI_MODEL_TYPE.IMAGE) {
    assertContains(input.outputModalities, AI_MODEL_MODALITY.IMAGE, '图像模型必须输出图像')
    return
  }
  if (!input.inputModalities.includes(AI_MODEL_MODALITY.AUDIO) && !input.outputModalities.includes(AI_MODEL_MODALITY.AUDIO)) {
    throw new BadRequestException('音频模型必须支持音频输入或音频输出')
  }
}

function assertContains<T>(items: T[], expected: T, message: string) {
  if (!items.includes(expected)) {
    throw new BadRequestException(message)
  }
}

function resolveDiscoveredModelName(
  modelId: string,
  modelName: string,
  defaults: EffectiveModelCapabilityDefaults | null,
): string {
  const normalizedModelId = modelId.trim()
  const normalizedModelName = modelName.trim()
  if (defaults?.modelName && (!normalizedModelName || normalizedModelName === normalizedModelId)) {
    return defaults.modelName
  }

  return normalizedModelName || normalizedModelId
}

import type {
  AgentProfileConfig,
  AgentProfileSettings,
  AiModelRef,
  UpdateAgentProfileModelPolicyRequest,
} from '@haohaoxue/lexora-contracts'
import {
  AGENT_FIRST_PARTY_SKILL_DEFINITIONS,
  AGENT_LOCATION_SKILL_KEY,
  AGENT_MEMORY_SKILL_KEY,
  AGENT_MEMORY_SLOT_KEY,
  AGENT_TIME_SKILL_KEY,
  AGENT_WEB_SEARCH_SKILL_KEY,
  AgentLocationSkillConfigSchema,
  AgentProfileConfigSchema,
  AgentProfileSettingsSchema,
  AgentTimeSkillConfigSchema,
  AgentWebSearchSkillConfigSchema,
  AI_MODEL_INTENT_KEY,
} from '@haohaoxue/lexora-contracts'
import { Injectable, InternalServerErrorException } from '@nestjs/common'
import {
  Prisma,
  AgentMemoryLane as PrismaAgentMemoryLane,
  AgentMemoryScope as PrismaAgentMemoryScope,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { AiModelResolverService } from '../ai/models/resolver.service'

const agentProfileSelect = {
  id: true,
  ownerUserId: true,
  name: true,
  description: true,
  avatarUrl: true,
  currentConfig: true,
} satisfies Prisma.AgentProfileSelect

export type AgentProfileForGeneration = Prisma.AgentProfileGetPayload<{
  select: typeof agentProfileSelect
}>

type AgentProfileClient = Pick<Prisma.TransactionClient, 'agentProfile'>

const DEFAULT_AGENT_PROFILE_NAME = '小助手'

const DEFAULT_AGENT_PROFILE_CONFIG: AgentProfileConfig = AgentProfileConfigSchema.parse({
  schemaVersion: 1,
  instructions: {
    systemPrompt: '你是 Lexora 小助手。请根据用户问题、当前对话上下文和可用文档上下文，给出清晰、准确、可执行的回答。',
  },
  skillBindings: createDefaultFirstPartySkillBindings(),
  toolPolicy: {
    enabled: true,
  },
})

@Injectable()
export class AgentProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modelResolver: AiModelResolverService,
  ) {}

  async ensureDefaultAgentProfile(input: {
    ownerUserId: string
    tx?: Prisma.TransactionClient
  }): Promise<AgentProfileForGeneration> {
    const client = input.tx ?? this.prisma
    const existingProfile = await this.findDefaultProfile(client, input.ownerUserId)

    if (existingProfile) {
      return this.ensureDefaultProfileCapabilities(client, existingProfile)
    }

    await client.agentProfile.createMany({
      data: {
        ownerUserId: input.ownerUserId,
        isDefault: true,
        name: DEFAULT_AGENT_PROFILE_NAME,
        currentConfig: toJsonObject(DEFAULT_AGENT_PROFILE_CONFIG),
      },
      skipDuplicates: true,
    })

    const profile = await this.findDefaultProfile(client, input.ownerUserId)
    if (!profile) {
      throw new InternalServerErrorException('默认 AgentProfile 创建失败')
    }

    return profile
  }

  async getDefaultAgentProfileSettings(ownerUserId: string): Promise<AgentProfileSettings> {
    const profile = await this.ensureDefaultAgentProfile({ ownerUserId })
    const personalizedName = await this.resolvePersonalizedAgentProfileName(ownerUserId, profile.id)

    return toAgentProfileSettings(profile, personalizedName)
  }

  async updateDefaultAgentProfileModelPolicy(
    ownerUserId: string,
    payload: UpdateAgentProfileModelPolicyRequest,
  ): Promise<AgentProfileSettings> {
    const profile = await this.ensureDefaultAgentProfile({ ownerUserId })
    const modelRef = payload.modelRef
      ? await this.resolveSelectableModelRef(ownerUserId, payload.modelRef)
      : null
    const currentConfig = AgentProfileConfigSchema.parse(profile.currentConfig)
    const nextConfig = AgentProfileConfigSchema.parse({
      ...currentConfig,
      modelPolicy: createNextModelPolicy(currentConfig, modelRef),
    })

    const updatedProfile = await this.prisma.agentProfile.update({
      where: {
        id: profile.id,
      },
      data: {
        currentConfig: toJsonObject(nextConfig),
      },
      select: agentProfileSelect,
    })

    const personalizedName = await this.resolvePersonalizedAgentProfileName(ownerUserId, updatedProfile.id)

    return toAgentProfileSettings(updatedProfile, personalizedName)
  }

  async resolvePersonalizedAgentProfileNames(
    ownerUserId: string,
    agentProfileIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, string>> {
    const uniqueProfileIds = [...new Set(agentProfileIds.map(id => id.trim()).filter(Boolean))]
    if (uniqueProfileIds.length === 0) {
      return new Map()
    }

    const client = tx ?? this.prisma
    const now = new Date()
    const memories = await client.agentMemory.findMany({
      where: {
        ownerUserId,
        scope: PrismaAgentMemoryScope.USER_AGENT,
        lane: PrismaAgentMemoryLane.AGENT_PERSONALIZATION,
        agentProfileId: {
          in: uniqueProfileIds,
        },
        slotKey: AGENT_MEMORY_SLOT_KEY.AGENT_NAME,
        status: 'ACTIVE',
        deletedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
      select: {
        agentProfileId: true,
        slotValue: true,
        content: true,
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    })

    const nameByProfileId = new Map<string, string>()
    for (const memory of memories) {
      if (!memory.agentProfileId || nameByProfileId.has(memory.agentProfileId)) {
        continue
      }

      const name = normalizePersonalizedAgentProfileName(memory)
      if (name) {
        nameByProfileId.set(memory.agentProfileId, name)
      }
    }

    return nameByProfileId
  }

  private findDefaultProfile(client: AgentProfileClient, ownerUserId: string): Promise<AgentProfileForGeneration | null> {
    return client.agentProfile.findFirst({
      where: {
        ownerUserId,
        isDefault: true,
        deletedAt: null,
      },
      select: agentProfileSelect,
      orderBy: {
        createdAt: 'asc',
      },
    })
  }

  private async ensureDefaultProfileCapabilities(
    client: AgentProfileClient,
    profile: AgentProfileForGeneration,
  ): Promise<AgentProfileForGeneration> {
    const currentConfig = AgentProfileConfigSchema.parse(profile.currentConfig)
    const nextConfig = ensureDefaultFirstPartySkillBindings(currentConfig)

    if (JSON.stringify(currentConfig) === JSON.stringify(nextConfig)) {
      return profile
    }

    return client.agentProfile.update({
      where: {
        id: profile.id,
      },
      data: {
        currentConfig: toJsonObject(nextConfig),
      },
      select: agentProfileSelect,
    })
  }

  private async resolveSelectableModelRef(
    ownerUserId: string,
    modelRef: Pick<AiModelRef, 'providerId' | 'modelId'>,
  ): Promise<Pick<AiModelRef, 'providerId' | 'modelId'>> {
    const target = await this.modelResolver.resolveModelTarget({
      actorUserId: ownerUserId,
      intentKey: AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT,
      requestedModelRef: modelRef,
    })

    return {
      providerId: target.providerId,
      modelId: target.modelId,
    }
  }

  private async resolvePersonalizedAgentProfileName(
    ownerUserId: string,
    agentProfileId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string | null> {
    return (await this.resolvePersonalizedAgentProfileNames(ownerUserId, [agentProfileId], tx)).get(agentProfileId) ?? null
  }
}

function toJsonObject(value: object): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject
}

function createNextModelPolicy(
  config: AgentProfileConfig,
  modelRef: Pick<AiModelRef, 'providerId' | 'modelId'> | null,
): AgentProfileConfig['modelPolicy'] {
  const restModelPolicy = { ...config.modelPolicy }
  delete restModelPolicy.providerId
  delete restModelPolicy.modelId

  if (!modelRef) {
    return {
      ...restModelPolicy,
      selectionMode: 'user_default',
    }
  }

  return {
    ...restModelPolicy,
    selectionMode: 'fixed_model',
    providerId: modelRef.providerId,
    modelId: modelRef.modelId,
  }
}

function createDefaultFirstPartySkillBindings(): AgentProfileConfig['skillBindings'] {
  return AGENT_FIRST_PARTY_SKILL_DEFINITIONS
    .filter(definition => definition.defaultInstalled && definition.defaultEnabled)
    .map((definition, index) => ({
      key: definition.key,
      enabled: true,
      priority: index,
      config: getDefaultFirstPartySkillBindingConfig(definition.key),
    }))
}

function ensureDefaultFirstPartySkillBindings(config: AgentProfileConfig): AgentProfileConfig {
  const existingSkillBindings = config.skillBindings.filter(binding => !isLegacyAutoInstalledLocationBinding(binding))
  const bindingByKey = new Map(existingSkillBindings.map(binding => [binding.key, binding]))
  const firstPartyDefinitionByKey = new Map(AGENT_FIRST_PARTY_SKILL_DEFINITIONS.map(definition => [definition.key, definition]))
  let nextPriority = existingSkillBindings.reduce((max, binding) => Math.max(max, binding.priority), -1) + 1

  const skillBindings = existingSkillBindings.map((binding) => {
    const definition = firstPartyDefinitionByKey.get(binding.key)
    if (!definition) {
      return binding
    }

    const normalizedBinding = {
      ...binding,
      config: normalizeDefaultFirstPartySkillBindingConfig(binding.key, binding.config),
    }

    if (!definition.canDisable && definition.defaultEnabled && !binding.enabled) {
      return {
        ...normalizedBinding,
        enabled: true,
      }
    }

    return normalizedBinding
  })

  for (const definition of AGENT_FIRST_PARTY_SKILL_DEFINITIONS) {
    if (
      bindingByKey.has(definition.key)
      || !definition.defaultInstalled
      || !definition.defaultEnabled
    ) {
      continue
    }

    skillBindings.push({
      key: definition.key,
      enabled: true,
      priority: nextPriority,
      config: getDefaultFirstPartySkillBindingConfig(definition.key),
    })
    nextPriority += 1
  }

  return AgentProfileConfigSchema.parse({
    ...config,
    skillBindings,
  })
}

function isLegacyAutoInstalledLocationBinding(binding: AgentProfileConfig['skillBindings'][number]): boolean {
  return binding.key === AGENT_LOCATION_SKILL_KEY
    && !AgentLocationSkillConfigSchema.safeParse(binding.config).success
}

function getDefaultFirstPartySkillBindingConfig(skillKey: string): AgentProfileConfig['skillBindings'][number]['config'] {
  if (skillKey === AGENT_TIME_SKILL_KEY) {
    return AgentTimeSkillConfigSchema.parse({})
  }

  if (skillKey === AGENT_WEB_SEARCH_SKILL_KEY) {
    return AgentWebSearchSkillConfigSchema.parse({})
  }

  return {}
}

function normalizeDefaultFirstPartySkillBindingConfig(
  skillKey: string,
  config: AgentProfileConfig['skillBindings'][number]['config'],
): AgentProfileConfig['skillBindings'][number]['config'] {
  if (skillKey === AGENT_TIME_SKILL_KEY) {
    return AgentTimeSkillConfigSchema.parse(config)
  }

  if (skillKey === AGENT_WEB_SEARCH_SKILL_KEY) {
    return AgentWebSearchSkillConfigSchema.parse(config)
  }

  if (skillKey === AGENT_LOCATION_SKILL_KEY) {
    return AgentLocationSkillConfigSchema.parse(config)
  }

  if (skillKey === AGENT_MEMORY_SKILL_KEY) {
    return {}
  }

  return config
}

export function resolveAgentProfileFixedModelRef(
  profile: Pick<AgentProfileForGeneration, 'currentConfig'>,
): Pick<AiModelRef, 'providerId' | 'modelId'> | null {
  const config = AgentProfileConfigSchema.parse(profile.currentConfig)
  if (
    config.modelPolicy.selectionMode !== 'fixed_model'
    || !config.modelPolicy.providerId
    || !config.modelPolicy.modelId
  ) {
    return null
  }

  return {
    providerId: config.modelPolicy.providerId,
    modelId: config.modelPolicy.modelId,
  }
}

function toAgentProfileSettings(profile: AgentProfileForGeneration, personalizedName: string | null = null): AgentProfileSettings {
  return AgentProfileSettingsSchema.parse({
    profileId: profile.id,
    name: personalizedName ?? profile.name,
    description: profile.description,
    avatarUrl: profile.avatarUrl,
    modelRef: resolveAgentProfileFixedModelRef(profile),
  })
}

function normalizePersonalizedAgentProfileName(memory: Pick<Prisma.AgentMemoryGetPayload<{
  select: {
    slotValue: true
    content: true
  }
}>, 'slotValue' | 'content'>): string | null {
  const name = (memory.slotValue ?? memory.content).replace(/\s+/g, ' ').trim()
  return name || null
}

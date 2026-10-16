import type {
  ActivateAgentSkillRequest,
  ActivateAgentSkillResponse,
  AgentProfileConfig,
  AgentProfileSnapshot,
  AgentRuntimeSkillCatalogItem,
  AgentRuntimeSkillContext,
  AgentRuntimeSkillCredentials,
  AgentSkillBinding,
  AgentSkillBindingConfig,
  AgentSkillCard,
  AgentSkillDefinition,
  ListAgentSkillsResponse,
  MutateAgentSkillResponse,
  UpdateAgentSkillConfigResponse,
} from '@haohaoxue/lexora-contracts'
import type { CryptoConfig } from '../../config/auth.config'
import {
  ActivateAgentSkillResponseSchema,
  AGENT_AMAP_MCP_SKILL_KEY,
  AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
  AGENT_FIRST_PARTY_SKILL_DEFINITIONS,
  AGENT_LOCATION_SKILL_KEY,
  AGENT_MEMORY_SKILL_KEY,
  AGENT_SKILL_INSTALL_MODE,
  AGENT_TIME_SKILL_KEY,
  AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG,
  AGENT_TRANSLATOR_OUTPUT_MODE,
  AGENT_TRANSLATOR_SKILL_KEY,
  AGENT_WEB_SEARCH_SKILL_KEY,
  AgentAmapMcpSkillCardConfigSchema,
  AgentAmapMcpSkillConfigSchema,
  AgentAmapMcpSkillCredentialConfigSchema,
  AgentLocationSkillConfigSchema,
  AgentProfileConfigSchema,
  AgentProfileSnapshotSchema,
  AgentRuntimeSkillContextSchema,
  AgentRuntimeSkillCredentialsSchema,
  AgentSkillBindingConfigSchema,
  AgentTimeSkillConfigSchema,
  AgentTranslatorSkillConfigSchema,
  AgentWebSearchSkillConfigSchema,
  ListAgentSkillsResponseSchema,
  MutateAgentSkillResponseSchema,
  UpdateAgentSkillConfigResponseSchema,
} from '@haohaoxue/lexora-contracts'
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  ChatMessageGenerationStatus,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { decryptAes256Gcm, encryptAes256Gcm } from '../../utils/crypto'
import { AgentProfilesService } from './agent-profiles.service'

const skillDefinitionByKey = new Map(AGENT_FIRST_PARTY_SKILL_DEFINITIONS.map(skill => [skill.key, skill]))

interface SkillConfigHandler {
  defaultConfig: () => AgentSkillBindingConfig
  normalize: (config: unknown) => AgentSkillBindingConfig
  renderInstructions?: (
    definition: (typeof AGENT_FIRST_PARTY_SKILL_DEFINITIONS)[number],
    binding: AgentSkillBinding,
  ) => string
}

const skillConfigHandlerByKey = {
  [AGENT_MEMORY_SKILL_KEY]: {
    defaultConfig: () => ({}),
    normalize: () => ({}),
  },
  [AGENT_LOCATION_SKILL_KEY]: {
    defaultConfig: () => AgentLocationSkillConfigSchema.parse({}),
    normalize: normalizeLocationSkillConfig,
  },
  [AGENT_TIME_SKILL_KEY]: {
    defaultConfig: () => AgentTimeSkillConfigSchema.parse({}),
    normalize: normalizeTimeSkillConfig,
  },
  [AGENT_TRANSLATOR_SKILL_KEY]: {
    defaultConfig: () => AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG,
    normalize: normalizeTranslatorSkillConfig,
    renderInstructions: renderTranslatorRuntimeInstructions,
  },
  [AGENT_DOCUMENT_ASSISTANT_SKILL_KEY]: {
    defaultConfig: () => ({}),
    normalize: () => ({}),
  },
  [AGENT_WEB_SEARCH_SKILL_KEY]: {
    defaultConfig: () => AgentWebSearchSkillConfigSchema.parse({}),
    normalize: normalizeWebSearchSkillConfig,
    renderInstructions: renderWebSearchRuntimeInstructions,
  },
  [AGENT_AMAP_MCP_SKILL_KEY]: {
    defaultConfig: () => AgentAmapMcpSkillConfigSchema.parse({}),
    normalize: normalizeAmapMcpSkillConfig,
  },
} satisfies Record<string, SkillConfigHandler>

export function listSkillConfigHandlerKeys(): readonly string[] {
  return Object.keys(skillConfigHandlerByKey)
}

type ResolvedSkillDefinition = Pick<
  AgentSkillDefinition,
  'key' | 'installMode' | 'defaultInstalled' | 'defaultEnabled' | 'canDisable' | 'canUninstall' | 'configurable'
> & {
  canInstall: boolean
}

@Injectable()
export class AgentSkillsService {
  private readonly encryptionKey: string

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: AgentProfilesService,
    configService: ConfigService,
  ) {
    this.encryptionKey = configService.getOrThrow<CryptoConfig>('crypto').encryptionKey
  }

  async listDefaultAgentSkills(ownerUserId: string): Promise<ListAgentSkillsResponse> {
    const [profile, configuredCredentialSkillKeys] = await Promise.all([
      this.profiles.ensureDefaultAgentProfile({ ownerUserId }),
      this.listConfiguredCredentialSkillKeys(ownerUserId),
    ])
    const config = AgentProfileConfigSchema.parse(profile.currentConfig)
    const bindingByKey = new Map(config.skillBindings.map(binding => [binding.key, binding]))
    const skillCards = AGENT_FIRST_PARTY_SKILL_DEFINITIONS.map(definition =>
      toSkillCard(
        definition,
        bindingByKey.get(definition.key),
        configuredCredentialSkillKeys,
      ),
    )

    return ListAgentSkillsResponseSchema.parse({
      skills: skillCards,
      mySkills: skillCards.filter(skill => skill.installed),
    })
  }

  async installDefaultAgentSkill(ownerUserId: string, skillKey: string): Promise<MutateAgentSkillResponse> {
    const normalizedSkillKey = normalizeSkillKey(skillKey)
    const [profile, skillDefinition] = await Promise.all([
      this.profiles.ensureDefaultAgentProfile({ ownerUserId }),
      this.resolveSkillDefinition(normalizedSkillKey),
    ])

    if (!skillDefinition) {
      throw new NotFoundException('技能不存在或尚未发布')
    }

    if (!skillDefinition.canInstall) {
      throw new ConflictException('该技能无需安装')
    }

    if (isCredentialRequiredSkill(normalizedSkillKey)) {
      throw new ConflictException('该技能需要先配置凭证')
    }

    await this.prisma.$transaction(async (tx) => {
      const currentProfile = await tx.agentProfile.findFirst({
        where: {
          id: profile.id,
          ownerUserId,
          deletedAt: null,
        },
        select: {
          currentConfig: true,
        },
      })

      if (!currentProfile) {
        throw new NotFoundException('默认 AgentProfile 不存在')
      }

      const currentConfig = AgentProfileConfigSchema.parse(currentProfile.currentConfig)
      const nextConfig = installSkillBinding(currentConfig, skillDefinition)

      await tx.agentProfile.update({
        where: {
          id: profile.id,
        },
        data: {
          currentConfig: toJsonObject(nextConfig),
        },
      })
    })

    const response = await this.listDefaultAgentSkills(ownerUserId)
    const skill = response.skills.find(item => item.key === normalizedSkillKey)
    if (!skill) {
      throw new NotFoundException('技能不存在')
    }

    return MutateAgentSkillResponseSchema.parse({ skill })
  }

  async enableDefaultAgentSkill(ownerUserId: string, skillKey: string): Promise<MutateAgentSkillResponse> {
    return this.updateDefaultAgentSkillEnabled(ownerUserId, skillKey, true)
  }

  async disableDefaultAgentSkill(ownerUserId: string, skillKey: string): Promise<MutateAgentSkillResponse> {
    return this.updateDefaultAgentSkillEnabled(ownerUserId, skillKey, false)
  }

  async uninstallDefaultAgentSkill(ownerUserId: string, skillKey: string): Promise<MutateAgentSkillResponse> {
    const normalizedSkillKey = normalizeSkillKey(skillKey)
    const [profile, skillDefinition] = await Promise.all([
      this.profiles.ensureDefaultAgentProfile({ ownerUserId }),
      this.resolveSkillDefinition(normalizedSkillKey),
    ])

    if (!skillDefinition) {
      throw new NotFoundException('技能不存在或尚未发布')
    }

    if (!skillDefinition.canUninstall) {
      throw new ConflictException('该技能不可移除')
    }

    await this.prisma.$transaction(async (tx) => {
      const currentProfile = await tx.agentProfile.findFirst({
        where: {
          id: profile.id,
          ownerUserId,
          deletedAt: null,
        },
        select: {
          currentConfig: true,
        },
      })

      if (!currentProfile) {
        throw new NotFoundException('默认 AgentProfile 不存在')
      }

      const currentConfig = AgentProfileConfigSchema.parse(currentProfile.currentConfig)
      const nextConfig = removeSkillBinding(currentConfig, normalizedSkillKey)

      await tx.agentProfile.update({
        where: {
          id: profile.id,
        },
        data: {
          currentConfig: toJsonObject(nextConfig),
        },
      })

      await tx.agentSkillCredential.deleteMany({
        where: {
          ownerUserId,
          skillKey: normalizedSkillKey,
        },
      })
    })

    const response = await this.listDefaultAgentSkills(ownerUserId)
    const skill = response.skills.find(item => item.key === normalizedSkillKey)
    if (!skill) {
      throw new NotFoundException('技能不存在')
    }

    return MutateAgentSkillResponseSchema.parse({ skill })
  }

  private async updateDefaultAgentSkillEnabled(
    ownerUserId: string,
    skillKey: string,
    enabled: boolean,
  ): Promise<MutateAgentSkillResponse> {
    const normalizedSkillKey = normalizeSkillKey(skillKey)
    const [profile, skillDefinition] = await Promise.all([
      this.profiles.ensureDefaultAgentProfile({ ownerUserId }),
      this.resolveSkillDefinition(normalizedSkillKey),
    ])

    if (!skillDefinition) {
      throw new NotFoundException('技能不存在或尚未发布')
    }

    if (!enabled && !skillDefinition.canDisable) {
      throw new ConflictException('该技能不可关闭')
    }

    await this.prisma.$transaction(async (tx) => {
      const currentProfile = await tx.agentProfile.findFirst({
        where: {
          id: profile.id,
          ownerUserId,
          deletedAt: null,
        },
        select: {
          currentConfig: true,
        },
      })

      if (!currentProfile) {
        throw new NotFoundException('默认 AgentProfile 不存在')
      }

      const currentConfig = AgentProfileConfigSchema.parse(currentProfile.currentConfig)
      const nextConfig = setSkillBindingEnabled(currentConfig, skillDefinition, enabled)

      await tx.agentProfile.update({
        where: {
          id: profile.id,
        },
        data: {
          currentConfig: toJsonObject(nextConfig),
        },
      })
    })

    const response = await this.listDefaultAgentSkills(ownerUserId)
    const skill = response.skills.find(item => item.key === normalizedSkillKey)
    if (!skill) {
      throw new NotFoundException('技能不存在')
    }

    return MutateAgentSkillResponseSchema.parse({ skill })
  }

  async updateDefaultAgentSkillConfig(
    ownerUserId: string,
    skillKey: string,
    config: AgentSkillBindingConfig,
  ): Promise<UpdateAgentSkillConfigResponse> {
    const normalizedSkillKey = normalizeSkillKey(skillKey)
    const [profile, skillDefinition] = await Promise.all([
      this.profiles.ensureDefaultAgentProfile({ ownerUserId }),
      this.resolveSkillDefinition(normalizedSkillKey),
    ])

    if (!skillDefinition) {
      throw new NotFoundException('技能不存在或尚未发布')
    }

    const normalizedConfig = normalizeSkillBindingConfig(normalizedSkillKey, config)
    const credentialMutation = extractSkillCredentialMutation(normalizedSkillKey, config)

    await this.prisma.$transaction(async (tx) => {
      const [currentProfile, existingCredential] = await Promise.all([
        tx.agentProfile.findFirst({
          where: {
            id: profile.id,
            ownerUserId,
            deletedAt: null,
          },
          select: {
            currentConfig: true,
          },
        }),
        tx.agentSkillCredential.findUnique({
          where: {
            ownerUserId_skillKey: {
              ownerUserId,
              skillKey: normalizedSkillKey,
            },
          },
          select: {
            id: true,
          },
        }),
      ])

      if (!currentProfile) {
        throw new NotFoundException('默认 AgentProfile 不存在')
      }

      const currentConfig = AgentProfileConfigSchema.parse(currentProfile.currentConfig)
      const hasBinding = currentConfig.skillBindings.some(binding => binding.key === skillDefinition.key)
      if (
        !hasBinding
        && isCredentialRequiredSkill(normalizedSkillKey)
        && credentialMutation?.kind !== 'set'
        && !existingCredential
      ) {
        throw new ConflictException('该技能需要先配置凭证')
      }

      const nextConfig = updateSkillBindingConfig(currentConfig, skillDefinition, normalizedConfig)

      if (credentialMutation?.kind === 'set') {
        const credentialEncrypted = this.encryptCredentialPayload(credentialMutation.payload)
        await tx.agentSkillCredential.upsert({
          where: {
            ownerUserId_skillKey: {
              ownerUserId,
              skillKey: normalizedSkillKey,
            },
          },
          create: {
            ownerUserId,
            skillKey: normalizedSkillKey,
            credentialEncrypted,
          },
          update: {
            credentialEncrypted,
          },
        })
      }
      else if (credentialMutation?.kind === 'delete') {
        await tx.agentSkillCredential.deleteMany({
          where: {
            ownerUserId,
            skillKey: normalizedSkillKey,
          },
        })
      }

      await tx.agentProfile.update({
        where: {
          id: profile.id,
        },
        data: {
          currentConfig: toJsonObject(nextConfig),
        },
      })
    })

    const response = await this.listDefaultAgentSkills(ownerUserId)
    const skill = response.skills.find(item => item.key === normalizedSkillKey)
    if (!skill) {
      throw new NotFoundException('技能不存在')
    }

    return UpdateAgentSkillConfigResponseSchema.parse({ skill })
  }

  async resolveRuntimeSkillContext(input: {
    actorUserId: string
    agentProfile: AgentProfileSnapshot
  }): Promise<AgentRuntimeSkillContext> {
    const agentProfile = AgentProfileSnapshotSchema.parse(input.agentProfile)
    const config = AgentProfileConfigSchema.parse(agentProfile.currentConfig)
    if (!config.toolPolicy.enabled || input.actorUserId !== agentProfile.ownerUserId) {
      return AgentRuntimeSkillContextSchema.parse({})
    }

    const configuredCredentialSkillKeys = await this.listConfiguredCredentialSkillKeys(input.actorUserId)
    const enabledBindings = resolveRuntimeEnabledSkillBindings(config, configuredCredentialSkillKeys)
    const availableSkills = enabledBindings
      .slice()
      .sort((left, right) => left.priority - right.priority)
      .map((binding): AgentRuntimeSkillCatalogItem | null => {
        const definition = skillDefinitionByKey.get(binding.key)
        return definition ? toRuntimeCatalogItem(definition) : null
      })
      .filter((item): item is AgentRuntimeSkillCatalogItem => Boolean(item))

    return AgentRuntimeSkillContextSchema.parse({ availableSkills })
  }

  async resolveRuntimeSkillCredentials(input: {
    actorUserId: string
    agentProfile: AgentProfileSnapshot
  }): Promise<AgentRuntimeSkillCredentials> {
    const agentProfile = AgentProfileSnapshotSchema.parse(input.agentProfile)
    const config = AgentProfileConfigSchema.parse(agentProfile.currentConfig)
    if (!config.toolPolicy.enabled || input.actorUserId !== agentProfile.ownerUserId) {
      return AgentRuntimeSkillCredentialsSchema.parse([])
    }

    const configuredCredentialSkillKeys = await this.listConfiguredCredentialSkillKeys(input.actorUserId)
    const enabledSkillKeys = resolveRuntimeEnabledSkillBindings(config, configuredCredentialSkillKeys).map(binding => binding.key)
    if (enabledSkillKeys.length === 0) {
      return AgentRuntimeSkillCredentialsSchema.parse([])
    }

    const credentials = await this.prisma.agentSkillCredential.findMany({
      where: {
        ownerUserId: input.actorUserId,
        skillKey: {
          in: enabledSkillKeys,
        },
      },
      select: {
        skillKey: true,
        credentialEncrypted: true,
      },
    })

    return AgentRuntimeSkillCredentialsSchema.parse(credentials.map(credential => ({
      key: credential.skillKey,
      credential: this.decryptCredentialPayload(credential.credentialEncrypted),
    })))
  }

  async activateSkill(payload: ActivateAgentSkillRequest): Promise<ActivateAgentSkillResponse> {
    const snapshot = await this.resolveGenerationAgentProfileSnapshot(payload.actorUserId, payload.generationId)
    const skillKey = normalizeSkillKey(payload.skillKey)
    const credentialSkillKeys = await this.listConfiguredCredentialSkillKeys(payload.actorUserId)
    const binding = getEnabledSkillBinding(snapshot.currentConfig, skillKey, credentialSkillKeys)

    const definition = skillDefinitionByKey.get(skillKey)
    if (!definition) {
      throw new NotFoundException('技能不存在或不可用')
    }

    return ActivateAgentSkillResponseSchema.parse({
      skill: {
        ...toRuntimeCatalogItem(definition),
        instructions: renderSkillInstructions(definition, binding),
      },
    })
  }

  private async listConfiguredCredentialSkillKeys(ownerUserId: string): Promise<ReadonlySet<string>> {
    const credentials = await this.prisma.agentSkillCredential.findMany({
      where: {
        ownerUserId,
      },
      select: {
        skillKey: true,
      },
    })

    return new Set(credentials.map(credential => credential.skillKey))
  }

  private encryptCredentialPayload(payload: Record<string, unknown>): string {
    return encryptAes256Gcm(JSON.stringify(payload), this.encryptionKey)
  }

  private decryptCredentialPayload(credentialEncrypted: string): Record<string, unknown> {
    const payload: unknown = JSON.parse(decryptAes256Gcm(credentialEncrypted, this.encryptionKey))
    return isRecord(payload) ? payload : {}
  }

  private async resolveSkillDefinition(skillKey: string): Promise<ResolvedSkillDefinition | null> {
    const definition = skillDefinitionByKey.get(skillKey)
    if (definition) {
      return {
        key: definition.key,
        installMode: definition.installMode,
        defaultInstalled: definition.defaultInstalled,
        defaultEnabled: definition.defaultEnabled,
        canDisable: definition.canDisable,
        canUninstall: definition.canUninstall,
        configurable: definition.configurable,
        canInstall: definition.installMode === AGENT_SKILL_INSTALL_MODE.OPTIONAL,
      }
    }

    return null
  }

  private async resolveGenerationAgentProfileSnapshot(actorUserId: string, generationId: string): Promise<AgentProfileSnapshot> {
    const generation = await this.prisma.chatMessageGeneration.findFirst({
      where: {
        generationId,
        actorUserId,
        deletedAt: null,
        status: {
          in: [
            ChatMessageGenerationStatus.PENDING,
            ChatMessageGenerationStatus.RUNNING,
          ],
        },
      },
      select: {
        agentProfileSnapshot: true,
      },
    })

    if (!generation) {
      throw new ConflictException('聊天生成不存在或已结束')
    }

    return AgentProfileSnapshotSchema.parse(generation.agentProfileSnapshot)
  }
}

function toSkillCard(
  definition: (typeof AGENT_FIRST_PARTY_SKILL_DEFINITIONS)[number],
  binding: AgentSkillBinding | undefined,
  configuredCredentialSkillKeys: ReadonlySet<string>,
): AgentSkillCard {
  const installed = definition.defaultInstalled || Boolean(binding)
  const enabled = installed
    ? definition.canDisable
      ? binding?.enabled ?? definition.defaultEnabled
      : definition.defaultEnabled
    : false

  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    activationMode: definition.activationMode,
    riskLevel: definition.riskLevel,
    sourceType: definition.sourceType,
    connectorType: definition.connectorType,
    installMode: definition.installMode,
    defaultInstalled: definition.defaultInstalled,
    defaultEnabled: definition.defaultEnabled,
    configurable: definition.configurable,
    actions: definition.actions,
    connectors: definition.connectors,
    installed,
    enabled,
    canInstall: !installed && definition.installMode === AGENT_SKILL_INSTALL_MODE.OPTIONAL,
    canEnable: installed && !enabled,
    canDisable: installed && enabled && definition.canDisable,
    canUninstall: installed && definition.canUninstall,
    canConfigure: installed && definition.configurable,
    config: toSkillCardConfig(
      definition.key,
      normalizeSkillBindingConfig(definition.key, binding?.config ?? getDefaultSkillBindingConfig(definition.key)),
      configuredCredentialSkillKeys,
    ),
  }
}

function toRuntimeCatalogItem(
  definition: (typeof AGENT_FIRST_PARTY_SKILL_DEFINITIONS)[number],
): AgentRuntimeSkillCatalogItem {
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    activationMode: definition.activationMode,
    sourceType: definition.sourceType,
    connectorType: definition.connectorType,
    actions: definition.actions,
  }
}

function installSkillBinding(
  config: AgentProfileConfig,
  skill: ResolvedSkillDefinition,
): AgentProfileConfig {
  const existing = config.skillBindings.find(binding => binding.key === skill.key)
  const maxPriority = config.skillBindings.reduce((max, binding) => Math.max(max, binding.priority), -1)
  const normalizedConfig = normalizeSkillBindingConfig(skill.key, existing?.config ?? getDefaultSkillBindingConfig(skill.key))
  const skillBindings = existing
    ? config.skillBindings.map(binding =>
        binding.key === skill.key
          ? { ...binding, enabled: skill.defaultEnabled, config: normalizedConfig }
          : binding,
      )
    : [
        ...config.skillBindings,
        {
          key: skill.key,
          enabled: skill.defaultEnabled,
          priority: maxPriority + 1,
          config: normalizedConfig,
        },
      ]

  return AgentProfileConfigSchema.parse({
    ...config,
    toolPolicy: {
      ...config.toolPolicy,
      enabled: true,
    },
    skillBindings,
  })
}

function setSkillBindingEnabled(
  config: AgentProfileConfig,
  skill: ResolvedSkillDefinition,
  enabled: boolean,
): AgentProfileConfig {
  const existing = config.skillBindings.find(binding => binding.key === skill.key)
  if (!existing && skill.installMode === AGENT_SKILL_INSTALL_MODE.OPTIONAL) {
    throw new ConflictException('技能尚未安装')
  }

  if (!existing) {
    return installSkillBinding(config, { ...skill, defaultEnabled: enabled })
  }

  return AgentProfileConfigSchema.parse({
    ...config,
    toolPolicy: {
      ...config.toolPolicy,
      enabled: true,
    },
    skillBindings: config.skillBindings.map(binding =>
      binding.key === skill.key
        ? { ...binding, enabled, config: normalizeSkillBindingConfig(skill.key, binding.config) }
        : binding,
    ),
  })
}

function updateSkillBindingConfig(
  config: AgentProfileConfig,
  skill: ResolvedSkillDefinition,
  nextBindingConfig: AgentSkillBindingConfig,
): AgentProfileConfig {
  if (!skill.configurable) {
    throw new ConflictException('技能不支持配置')
  }

  const existing = config.skillBindings.find(binding => binding.key === skill.key)
  const normalizedConfig = normalizeSkillBindingConfig(skill.key, nextBindingConfig)
  const skillBindings = existing
    ? config.skillBindings.map(binding =>
        binding.key === skill.key
          ? { ...binding, config: normalizedConfig }
          : binding,
      )
    : [
        ...config.skillBindings,
        {
          key: skill.key,
          enabled: skill.defaultEnabled,
          priority: config.skillBindings.reduce((max, binding) => Math.max(max, binding.priority), -1) + 1,
          config: normalizedConfig,
        },
      ]

  return AgentProfileConfigSchema.parse({
    ...config,
    toolPolicy: {
      ...config.toolPolicy,
      enabled: true,
    },
    skillBindings,
  })
}

function removeSkillBinding(config: AgentProfileConfig, skillKey: string): AgentProfileConfig {
  return AgentProfileConfigSchema.parse({
    ...config,
    skillBindings: config.skillBindings.filter(binding => binding.key !== skillKey),
  })
}

function getEnabledSkillBinding(
  config: AgentProfileConfig,
  skillKey: string,
  configuredCredentialSkillKeys: ReadonlySet<string>,
): AgentSkillBinding {
  if (!config.toolPolicy.enabled) {
    throw new ConflictException('当前 AgentProfile 未启用工具')
  }

  const binding = resolveRuntimeEnabledSkillBindings(config, configuredCredentialSkillKeys).find(item => item.key === skillKey)
  if (!binding) {
    throw new NotFoundException('技能未启用')
  }

  return binding
}

function resolveRuntimeEnabledSkillBindings(
  config: AgentProfileConfig,
  configuredCredentialSkillKeys: ReadonlySet<string>,
): AgentSkillBinding[] {
  if (!config.toolPolicy.enabled) {
    return []
  }

  const skillBindings = config.skillBindings.map((binding) => {
    const definition = skillDefinitionByKey.get(binding.key)
    if (!definition) {
      return binding
    }

    return {
      ...binding,
      enabled: !definition.canDisable && definition.defaultEnabled ? true : binding.enabled,
      config: normalizeSkillBindingConfig(binding.key, binding.config),
    }
  })
  const existingSkillKeys = new Set(skillBindings.map(binding => binding.key))

  for (const definition of AGENT_FIRST_PARTY_SKILL_DEFINITIONS) {
    if (existingSkillKeys.has(definition.key)) {
      continue
    }

    if (!definition.defaultInstalled || !definition.defaultEnabled) {
      continue
    }

    skillBindings.push({
      key: definition.key,
      enabled: true,
      priority: 0,
      config: getDefaultSkillBindingConfig(definition.key),
    })
  }

  return AgentProfileConfigSchema.parse({
    ...config,
    skillBindings,
  }).skillBindings.filter(binding => binding.enabled && isRuntimeSkillBindingReady(binding, configuredCredentialSkillKeys))
}

function normalizeSkillBindingConfig(skillKey: string, config: unknown): AgentSkillBindingConfig {
  const handler = getSkillConfigHandler(skillKey)

  return handler
    ? handler.normalize(config)
    : AgentSkillBindingConfigSchema.parse(config)
}

function normalizeTranslatorSkillConfig(config: unknown): AgentSkillBindingConfig {
  const result = AgentTranslatorSkillConfigSchema.safeParse(config)
  if (result.success) {
    return result.data
  }

  if (!isRecord(config)) {
    return AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG
  }

  const cleanedResult = AgentTranslatorSkillConfigSchema.safeParse({
    preserveFormatting: config.preserveFormatting,
    outputMode: config.outputMode,
    formality: config.formality,
  })

  return cleanedResult.success ? cleanedResult.data : AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG
}

function normalizeTimeSkillConfig(config: unknown): AgentSkillBindingConfig {
  const result = AgentTimeSkillConfigSchema.safeParse(config)
  if (result.success) {
    return result.data
  }

  if (!isRecord(config)) {
    return AgentTimeSkillConfigSchema.parse({})
  }

  const cleanedResult = AgentTimeSkillConfigSchema.safeParse({
    timeZone: config.timeZone,
  })

  return cleanedResult.success ? cleanedResult.data : AgentTimeSkillConfigSchema.parse({})
}

function normalizeLocationSkillConfig(config: unknown): AgentSkillBindingConfig {
  const result = AgentLocationSkillConfigSchema.safeParse(config)
  if (result.success) {
    return result.data
  }

  if (!isRecord(config)) {
    return AgentLocationSkillConfigSchema.parse({})
  }

  const cleanedResult = AgentLocationSkillConfigSchema.safeParse({
    mode: config.mode,
    fixedLocation: config.fixedLocation,
  })

  return cleanedResult.success ? cleanedResult.data : AgentLocationSkillConfigSchema.parse({})
}

function normalizeWebSearchSkillConfig(config: unknown): AgentSkillBindingConfig {
  const result = AgentWebSearchSkillConfigSchema.safeParse(config)
  if (result.success) {
    return result.data
  }

  if (!isRecord(config)) {
    return AgentWebSearchSkillConfigSchema.parse({})
  }

  const cleanedResult = AgentWebSearchSkillConfigSchema.safeParse({
    providers: config.providers,
    maxResults: config.maxResults,
    searchContextSize: config.searchContextSize,
    allowedDomains: config.allowedDomains,
    blockedDomains: config.blockedDomains,
  })

  return cleanedResult.success ? cleanedResult.data : AgentWebSearchSkillConfigSchema.parse({})
}

function normalizeAmapMcpSkillConfig(_config: unknown): AgentSkillBindingConfig {
  return AgentAmapMcpSkillConfigSchema.parse({})
}

function toSkillCardConfig(
  skillKey: string,
  config: AgentSkillBindingConfig,
  configuredCredentialSkillKeys: ReadonlySet<string>,
): AgentSkillBindingConfig {
  if (skillKey === AGENT_AMAP_MCP_SKILL_KEY) {
    return AgentAmapMcpSkillCardConfigSchema.parse({
      apiKeyConfigured: configuredCredentialSkillKeys.has(skillKey),
    })
  }

  return config
}

function isRuntimeSkillBindingReady(
  binding: AgentSkillBinding,
  configuredCredentialSkillKeys: ReadonlySet<string>,
): boolean {
  return !isCredentialRequiredSkill(binding.key) || configuredCredentialSkillKeys.has(binding.key)
}

function isCredentialRequiredSkill(skillKey: string): boolean {
  return skillKey === AGENT_AMAP_MCP_SKILL_KEY
}

type SkillCredentialMutation
  = | {
    kind: 'set'
    payload: Record<string, unknown>
  }
  | {
    kind: 'delete'
  }

function extractSkillCredentialMutation(
  skillKey: string,
  config: AgentSkillBindingConfig,
): SkillCredentialMutation | null {
  if (skillKey !== AGENT_AMAP_MCP_SKILL_KEY) {
    return null
  }

  if (!isRecord(config) || !('apiKey' in config)) {
    return null
  }

  const result = AgentAmapMcpSkillCredentialConfigSchema.safeParse(config)
  const apiKey = result.success ? result.data.apiKey?.trim() : undefined
  return apiKey
    ? { kind: 'set', payload: { apiKey } }
    : { kind: 'delete' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getDefaultSkillBindingConfig(skillKey: string): AgentSkillBindingConfig {
  const handler = getSkillConfigHandler(skillKey)

  return handler ? handler.defaultConfig() : {}
}

function renderSkillInstructions(
  definition: (typeof AGENT_FIRST_PARTY_SKILL_DEFINITIONS)[number],
  binding: AgentSkillBinding,
): string {
  const handler = getSkillConfigHandler(definition.key)

  return handler?.renderInstructions?.(definition, binding) ?? definition.instructions
}

function renderTranslatorRuntimeInstructions(
  definition: (typeof AGENT_FIRST_PARTY_SKILL_DEFINITIONS)[number],
  binding: AgentSkillBinding,
): string {
  const config = AgentTranslatorSkillConfigSchema.parse(binding.config)

  return [
    definition.instructions,
    '',
    '<translator_runtime_config>',
    'sourceLanguage: auto',
    'targetLanguage: provided by current user invocation',
    'sameLanguageInput: translate naturally to the selected target language without asking for a separate policy.',
    `preserveFormatting: ${config.preserveFormatting ? 'true' : 'false'}`,
    `outputMode: ${formatTranslatorOutputMode(config.outputMode)}`,
    `formality: ${config.formality}`,
    '</translator_runtime_config>',
    '',
    'If the current user request does not explicitly name a target language, use the target language selected in the current invocation.',
  ].join('\n')
}

function renderWebSearchRuntimeInstructions(
  definition: (typeof AGENT_FIRST_PARTY_SKILL_DEFINITIONS)[number],
  binding: AgentSkillBinding,
): string {
  const config = AgentWebSearchSkillConfigSchema.parse(binding.config)

  return [
    definition.instructions,
    '',
    '<web_search_runtime_config>',
    `providers: ${config.providers.join(', ')}`,
    `maxResults: ${config.maxResults}`,
    `searchContextSize: ${config.searchContextSize}`,
    `allowedDomains: ${config.allowedDomains.length > 0 ? config.allowedDomains.join(', ') : 'any'}`,
    `blockedDomains: ${config.blockedDomains.length > 0 ? config.blockedDomains.join(', ') : 'none'}`,
    '</web_search_runtime_config>',
  ].join('\n')
}

function getSkillConfigHandler(skillKey: string): SkillConfigHandler | undefined {
  return skillConfigHandlerByKey[skillKey as keyof typeof skillConfigHandlerByKey]
}

function formatTranslatorOutputMode(mode: string): string {
  if (mode === AGENT_TRANSLATOR_OUTPUT_MODE.BILINGUAL) {
    return 'bilingual'
  }

  if (mode === AGENT_TRANSLATOR_OUTPUT_MODE.WITH_NOTES) {
    return 'translation with brief notes'
  }

  return 'translation only'
}

function normalizeSkillKey(value: string): string {
  return value.trim().toLowerCase()
}

function toJsonObject(value: object): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject
}

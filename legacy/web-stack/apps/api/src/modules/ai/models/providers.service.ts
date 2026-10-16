import type { AiProvider, AiProviderCredential } from '@haohaoxue/lexora-contracts'
import type { CreateAiProviderDto, UpdateAiProviderDto } from '../ai.dto'
import { randomUUID } from 'node:crypto'
import { AI_PROVIDER_ENDPOINT_MODE, AI_PROVIDER_SOURCE } from '@haohaoxue/lexora-contracts'
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../../database/prisma.service'
import {
  toPrismaAuthMode,
  toPrismaEndpointMode,
  toPrismaProviderSource,
  toPrismaScope,
  toProvider,
} from '../ai.utils'
import { AiProviderAdaptersService } from '../providers/adapters.service'
import { AiProviderPresetsService } from '../providers/presets.service'

const TRAILING_SLASHES_RE = /\/+$/
const PLATFORM_PROVIDER_OWNER_KEY = 'platform'

@Injectable()
export class AiProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presetsService: AiProviderPresetsService,
    private readonly adaptersService: AiProviderAdaptersService,
  ) {}

  async getPlatformProviders(): Promise<AiProvider[]> {
    await this.ensurePlatformPresetProviders()
    return this.getProviders({
      scope: 'PLATFORM',
    })
  }

  async getUserProviders(userId: string): Promise<AiProvider[]> {
    await this.ensurePresetProvidersForUser(userId)
    return this.getProviders({
      scope: 'USER',
      ownerUserId: userId,
    })
  }

  createPlatformProvider(actorUserId: string, payload: CreateAiProviderDto): Promise<AiProvider> {
    return this.createCompatibleProvider({
      scope: 'platform',
      actorUserId,
      ownerUserId: null,
      payload,
    })
  }

  createUserProvider(userId: string, payload: CreateAiProviderDto): Promise<AiProvider> {
    return this.createCompatibleProvider({
      scope: 'user',
      actorUserId: userId,
      ownerUserId: userId,
      payload,
    })
  }

  updatePlatformProvider(actorUserId: string, providerId: string, payload: UpdateAiProviderDto): Promise<AiProvider> {
    return this.updateProvider({
      actorUserId,
      providerId,
      where: {
        id: providerId,
        scope: 'PLATFORM',
      },
      payload,
    })
  }

  updateUserProvider(userId: string, providerId: string, payload: UpdateAiProviderDto): Promise<AiProvider> {
    return this.updateProvider({
      actorUserId: userId,
      providerId,
      where: {
        id: providerId,
        scope: 'USER',
        ownerUserId: userId,
      },
      payload,
    })
  }

  getPlatformProviderCredential(providerId: string): Promise<AiProviderCredential> {
    return this.getProviderCredential({
      id: providerId,
      scope: 'PLATFORM',
    })
  }

  getUserProviderCredential(userId: string, providerId: string): Promise<AiProviderCredential> {
    return this.getProviderCredential({
      id: providerId,
      scope: 'USER',
      ownerUserId: userId,
    })
  }

  async deletePlatformProvider(providerId: string): Promise<void> {
    await this.deleteProvider({
      id: providerId,
      scope: 'PLATFORM',
    })
  }

  async deleteUserProvider(userId: string, providerId: string): Promise<void> {
    await this.deleteProvider({
      id: providerId,
      scope: 'USER',
      ownerUserId: userId,
    })
  }

  ensurePlatformPresetProviders(): Promise<void> {
    return this.ensurePresetProviders({
      scope: 'platform',
      ownerUserId: null,
    })
  }

  ensureUserPresetProviders(userId: string): Promise<void> {
    return this.ensurePresetProviders({
      scope: 'user',
      ownerUserId: userId,
    })
  }

  private async ensurePresetProvidersForUser(userId: string): Promise<void> {
    await Promise.all([
      this.ensurePlatformPresetProviders(),
      this.ensureUserPresetProviders(userId),
    ])
  }

  private async getProviders(where: Prisma.AiProviderWhereInput) {
    const providers = await this.prisma.aiProvider.findMany({
      where,
      orderBy: [
        { source: 'asc' },
        { updatedAt: 'desc' },
      ],
      include: {
        _count: {
          select: { models: true },
        },
      },
    })

    return providers.map(toProvider)
  }

  private async getProviderCredential(where: Prisma.AiProviderWhereInput): Promise<AiProviderCredential> {
    const provider = await this.prisma.aiProvider.findFirst({
      where,
      select: {
        apiKeyEncrypted: true,
      },
    })

    if (!provider) {
      throw new NotFoundException('服务商不存在')
    }

    return {
      apiKey: this.adaptersService.decryptApiKey(provider.apiKeyEncrypted),
    }
  }

  private async ensurePresetProviders(params: {
    scope: 'platform' | 'user'
    ownerUserId: string | null
  }) {
    const ownerKey = this.buildOwnerKey(params.scope, params.ownerUserId)
    const presets = this.presetsService.getPresets()
    const existingProviders = await this.prisma.aiProvider.findMany({
      where: {
        ownerKey,
        identityKey: { in: presets.map(preset => preset.providerKey) },
      },
      select: { identityKey: true },
    })
    const existingIdentityKeys = new Set(existingProviders.map(provider => provider.identityKey))
    const missingPresets = presets.filter(preset => !existingIdentityKeys.has(preset.providerKey))

    if (missingPresets.length === 0) {
      return
    }

    await this.prisma.aiProvider.createMany({
      data: missingPresets.map(preset => ({
        scope: toPrismaScope(params.scope),
        ownerUserId: params.ownerUserId,
        ownerKey,
        identityKey: preset.providerKey,
        source: toPrismaProviderSource(AI_PROVIDER_SOURCE.PRESET),
        providerKey: preset.providerKey,
        providerName: preset.providerName,
        adapterKey: preset.adapterKey,
        endpointMode: toPrismaEndpointMode(preset.endpointMode),
        endpoint: preset.fixedEndpoint ?? null,
        authMode: toPrismaAuthMode(preset.authMode),
        apiKeyEncrypted: null,
        enabled: false,
        visibility: 'ALL_USERS',
      })),
      skipDuplicates: true,
    })
  }

  private async createCompatibleProvider(params: {
    scope: 'platform' | 'user'
    actorUserId: string
    ownerUserId: string | null
    payload: CreateAiProviderDto
  }) {
    const preset = this.presetsService.getPresetOrThrow(params.payload.providerKey)
    if (preset.endpointMode !== AI_PROVIDER_ENDPOINT_MODE.CUSTOM) {
      throw new BadRequestException('预设服务商会自动创建，不支持手动添加')
    }

    const providerName = params.payload.providerName?.trim()
    if (!providerName) {
      throw new BadRequestException('请填写服务商名称')
    }

    const endpoint = this.resolveEndpoint(preset.endpointMode, preset.fixedEndpoint ?? null, params.payload.endpoint, false)
    const rawApiKey = params.payload.apiKey
    const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : undefined
    const provider = await this.prisma.aiProvider.create({
      data: {
        scope: toPrismaScope(params.scope),
        ownerUserId: params.ownerUserId,
        ownerKey: this.buildOwnerKey(params.scope, params.ownerUserId),
        identityKey: randomUUID(),
        source: toPrismaProviderSource(AI_PROVIDER_SOURCE.COMPATIBLE),
        providerKey: preset.providerKey,
        providerName,
        adapterKey: preset.adapterKey,
        endpointMode: toPrismaEndpointMode(preset.endpointMode),
        endpoint,
        authMode: toPrismaAuthMode(preset.authMode),
        apiKeyEncrypted: apiKey ? this.adaptersService.encryptApiKey(apiKey) : null,
        enabled: false,
        visibility: 'ALL_USERS',
        updatedBy: params.actorUserId,
      },
      include: {
        _count: {
          select: { models: true },
        },
      },
    })

    return toProvider(provider)
  }

  private async updateProvider(params: {
    actorUserId: string
    providerId: string
    where: Prisma.AiProviderWhereInput
    payload: UpdateAiProviderDto
  }) {
    const current = await this.prisma.aiProvider.findFirst({
      where: params.where,
    })

    if (!current) {
      throw new NotFoundException('服务商不存在')
    }

    const rawApiKey = params.payload.apiKey
    const hasApiKeyPayload = typeof rawApiKey === 'string'
    const apiKey = hasApiKeyPayload ? rawApiKey.trim() : undefined
    const isCompatible = current.source === 'COMPATIBLE'
    const nextProviderKey = params.payload.providerKey?.trim()
    const isProviderChanged = Boolean(nextProviderKey && nextProviderKey !== current.providerKey)
    const preset = nextProviderKey
      ? this.resolveEditablePreset(current, nextProviderKey)
      : this.presetsService.getPresetOrThrow(current.providerKey)
    const data: Prisma.AiProviderUpdateInput = {
      updatedByUser: {
        connect: { id: params.actorUserId },
      },
    }

    if (typeof params.payload.providerName === 'string') {
      if (!isCompatible && params.payload.providerName.trim() !== current.providerName) {
        throw new BadRequestException('预设服务商名称不允许修改')
      }

      if (isCompatible) {
        const providerName = params.payload.providerName.trim()
        if (!providerName) {
          throw new BadRequestException('服务商名称不能为空')
        }
        data.providerName = providerName
      }
    }

    if (nextProviderKey) {
      data.providerKey = preset.providerKey
      data.adapterKey = preset.adapterKey
      data.endpointMode = toPrismaEndpointMode(preset.endpointMode)
      data.authMode = toPrismaAuthMode(preset.authMode)
    }

    if (typeof params.payload.endpoint === 'string') {
      if (!isCompatible) {
        throw new BadRequestException('预设服务商 API 地址不允许修改')
      }
      data.endpoint = this.resolveEndpoint(preset.endpointMode, preset.fixedEndpoint ?? null, params.payload.endpoint, false)
    }

    if (hasApiKeyPayload) {
      data.apiKeyEncrypted = apiKey ? this.adaptersService.encryptApiKey(apiKey) : null
    }
    else if (params.payload.clearApiKey) {
      data.apiKeyEncrypted = null
    }
    if (typeof params.payload.enabled === 'boolean') {
      if (params.payload.enabled && isProviderChanged) {
        throw new BadRequestException('切换服务商类型后，请先重新获取模型列表再启用服务商')
      }

      if (params.payload.enabled && !current.enabled) {
        const enabledModelCount = await this.prisma.aiProviderModel.count({
          where: {
            providerId: params.providerId,
            enabled: true,
          },
        })

        if (enabledModelCount === 0) {
          throw new BadRequestException('请先添加并启用模型后再启用服务商')
        }
      }

      data.enabled = params.payload.enabled
    }

    if (isProviderChanged) {
      data.enabled = false
    }

    const provider = await this.prisma.$bypass.$transaction(async (tx) => {
      if (isProviderChanged) {
        await tx.aiDefaultModelPolicy.deleteMany({
          where: { providerId: params.providerId },
        })
        await tx.aiPlatformEmbeddingModelPolicy.deleteMany({
          where: { providerId: params.providerId },
        })
        await tx.aiProviderModel.deleteMany({
          where: { providerId: params.providerId },
        })
      }

      return tx.aiProvider.update({
        where: { id: params.providerId },
        data,
        include: {
          _count: {
            select: { models: true },
          },
        },
      })
    })

    return toProvider(provider)
  }

  private async deleteProvider(where: Prisma.AiProviderWhereInput) {
    const provider = await this.prisma.aiProvider.findFirst({
      where,
      select: {
        id: true,
        source: true,
      },
    })

    if (!provider) {
      throw new NotFoundException('服务商不存在')
    }
    if (provider.source !== 'COMPATIBLE') {
      throw new BadRequestException('预设服务商不允许删除')
    }

    await this.prisma.aiProvider.delete({
      where: { id: provider.id },
    })
  }

  private resolveEditablePreset(current: { source: string, providerKey: string }, nextProviderKey: string) {
    if (current.source !== 'COMPATIBLE') {
      throw new BadRequestException('预设服务商不允许切换类型')
    }

    const preset = this.presetsService.getPresetOrThrow(nextProviderKey)
    if (preset.endpointMode !== AI_PROVIDER_ENDPOINT_MODE.CUSTOM) {
      throw new BadRequestException('仅 compatible 服务商允许作为自定义服务')
    }

    return preset
  }

  private buildOwnerKey(scope: 'platform' | 'user', ownerUserId: string | null) {
    if (scope === 'platform') {
      return PLATFORM_PROVIDER_OWNER_KEY
    }
    if (!ownerUserId) {
      throw new BadRequestException('用户服务商缺少 owner')
    }
    return `user:${ownerUserId}`
  }

  private resolveEndpoint(endpointMode: string, fixedEndpoint: string | null, endpoint: string | undefined, required: boolean) {
    if (endpointMode === AI_PROVIDER_ENDPOINT_MODE.FIXED) {
      return fixedEndpoint
    }

    const normalizedEndpoint = endpoint?.trim()
    if (!normalizedEndpoint) {
      if (required) {
        throw new BadRequestException('请填写 API 地址')
      }
      return null
    }

    return normalizedEndpoint.replace(TRAILING_SLASHES_RE, '')
  }
}

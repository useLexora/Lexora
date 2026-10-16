import type {
  AiAvailableModelOption,
  AiAvailableProviderOption,
  AiDefaultModelPolicyItem,
  AiModelIntentKey,
  AiProviderScope,
  UpdateAiDefaultModelPolicyRequest,
} from '@haohaoxue/lexora-contracts'
import type {
  AiProvider,
  AiProviderModel,
  Prisma,
} from '@prisma/client'
import {
  AI_DEFAULT_MODEL_STATUS,
  AI_MODEL_INTENT_KEY,
  AiModelIntentKeySchema,
  AiProviderScopeSchema,
} from '@haohaoxue/lexora-contracts'
import { getAiModelIntentRequirement, isAiModelCapabilitySatisfied } from '@haohaoxue/lexora-shared'
import { BadRequestException, Injectable } from '@nestjs/common'
import { PrismaService } from '../../../database/prisma.service'
import {
  buildAiModelRef,
  toAvailableModelOption,
  toAvailableProviderOption,
  toDefaultModelPolicyItem,
  toDomainCapability,
  toDomainModelType,
  toPrismaCapability,
  toPrismaModelType,
  toPrismaScope,
} from '../ai.utils'
import {
  PLATFORM_EMBEDDING_MODEL_POLICY_ID,
  USER_CONFIGURABLE_DEFAULT_MODEL_INTENT_KEYS,
} from './defaults.constants'

@Injectable()
export class AiDefaultModelsService {
  constructor(private readonly prisma: PrismaService) {}

  async getDefaultModels(userId: string): Promise<AiDefaultModelPolicyItem[]> {
    return Promise.all(USER_CONFIGURABLE_DEFAULT_MODEL_INTENT_KEYS.map(intentKey => this.getDefaultModelItem(userId, intentKey)))
  }

  async updateDefaultModel(
    userId: string,
    intentKey: AiModelIntentKey,
    payload: UpdateAiDefaultModelPolicyRequest,
  ): Promise<AiDefaultModelPolicyItem> {
    const parsedIntentKey = AiModelIntentKeySchema.parse(intentKey)
    this.assertUserConfigurableDefaultModelIntent(parsedIntentKey)

    if (!payload.modelRef) {
      return this.clearDefaultModelPolicy(userId, parsedIntentKey)
    }

    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: payload.modelRef.providerId,
        enabled: true,
        OR: [
          { scope: 'PLATFORM', visibility: 'ALL_USERS' },
          { scope: 'USER', ownerUserId: userId },
        ],
      },
    })

    if (!provider) {
      throw new BadRequestException('服务商不可用')
    }

    const model = await this.prisma.aiProviderModel.findFirst({
      where: {
        providerId: payload.modelRef.providerId,
        modelId: payload.modelRef.modelId,
        enabled: true,
      },
    })

    if (!model) {
      throw new BadRequestException('模型不可用')
    }

    if (!isAiModelCapabilitySatisfied({
      modelType: toDomainModelType(model.modelType),
      capabilities: model.capabilities.map(toDomainCapability),
    }, parsedIntentKey)) {
      throw new BadRequestException('模型不满足当前场景要求')
    }

    const policy = await this.prisma.$bypass.aiDefaultModelPolicy.upsert({
      where: {
        userId_intentKey: {
          userId,
          intentKey: parsedIntentKey,
        },
      },
      create: {
        userId,
        intentKey: parsedIntentKey,
        providerId: payload.modelRef.providerId,
        modelId: payload.modelRef.modelId,
        updatedBy: userId,
        deletedAt: null,
      },
      update: {
        providerId: payload.modelRef.providerId,
        modelId: payload.modelRef.modelId,
        updatedBy: userId,
        deletedAt: null,
      },
    })

    return toDefaultModelPolicyItem({
      intentKey: parsedIntentKey,
      modelRef: buildAiModelRef({
        providerId: provider.id,
        scope: provider.scope,
        providerKey: provider.providerKey,
        modelId: policy.modelId,
      }),
      status: AI_DEFAULT_MODEL_STATUS.READY,
      invalidReason: null,
      updatedAt: policy.updatedAt,
    })
  }

  async getPlatformEmbeddingModel(): Promise<AiDefaultModelPolicyItem> {
    return this.getPlatformEmbeddingModelItem()
  }

  async updatePlatformEmbeddingModel(
    actorUserId: string,
    payload: UpdateAiDefaultModelPolicyRequest,
  ): Promise<AiDefaultModelPolicyItem> {
    if (!payload.modelRef) {
      return this.clearPlatformEmbeddingModelPolicy()
    }

    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: payload.modelRef.providerId,
        enabled: true,
        scope: 'PLATFORM',
        visibility: 'ALL_USERS',
      },
    })

    if (!provider) {
      throw new BadRequestException('平台服务商不可用')
    }

    const model = await this.prisma.aiProviderModel.findFirst({
      where: {
        providerId: payload.modelRef.providerId,
        modelId: payload.modelRef.modelId,
        enabled: true,
      },
    })

    if (!model) {
      throw new BadRequestException('模型不可用')
    }

    if (!isAiModelCapabilitySatisfied({
      modelType: toDomainModelType(model.modelType),
      capabilities: model.capabilities.map(toDomainCapability),
    }, AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT)) {
      throw new BadRequestException('模型不满足当前场景要求')
    }

    const policy = await this.prisma.$bypass.aiPlatformEmbeddingModelPolicy.upsert({
      where: {
        id: PLATFORM_EMBEDDING_MODEL_POLICY_ID,
      },
      create: {
        id: PLATFORM_EMBEDDING_MODEL_POLICY_ID,
        providerId: payload.modelRef.providerId,
        modelId: payload.modelRef.modelId,
        updatedBy: actorUserId,
        deletedAt: null,
      },
      update: {
        providerId: payload.modelRef.providerId,
        modelId: payload.modelRef.modelId,
        updatedBy: actorUserId,
        deletedAt: null,
      },
    })

    return toDefaultModelPolicyItem({
      intentKey: AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT,
      modelRef: buildAiModelRef({
        providerId: provider.id,
        scope: provider.scope,
        providerKey: provider.providerKey,
        modelId: policy.modelId,
      }),
      status: AI_DEFAULT_MODEL_STATUS.READY,
      invalidReason: null,
      updatedAt: policy.updatedAt,
    })
  }

  private async clearDefaultModelPolicy(userId: string, intentKey: AiModelIntentKey): Promise<AiDefaultModelPolicyItem> {
    const policy = await this.prisma.aiDefaultModelPolicy.findUnique({
      where: {
        userId_intentKey: {
          userId,
          intentKey,
        },
      },
    })

    if (policy) {
      await this.prisma.aiDefaultModelPolicy.delete({
        where: {
          userId_intentKey: {
            userId,
            intentKey,
          },
        },
      })
    }

    return this.getDefaultModelItem(userId, intentKey)
  }

  async getAvailableModels(userId: string, intentKey: AiModelIntentKey): Promise<AiAvailableModelOption[]> {
    const parsedIntentKey = AiModelIntentKeySchema.parse(intentKey)
    this.assertUserConfigurableDefaultModelIntent(parsedIntentKey)

    const providers = await this.prisma.aiProvider.findMany({
      where: {
        enabled: true,
        OR: [
          { scope: 'PLATFORM', visibility: 'ALL_USERS' },
          { scope: 'USER', ownerUserId: userId },
        ],
      },
      include: {
        models: {
          where: { enabled: true },
          orderBy: { modelName: 'asc' },
        },
      },
      orderBy: [
        { scope: 'asc' },
        { providerName: 'asc' },
      ],
    })

    return providers.flatMap(provider =>
      provider.models.map(model => this.toAvailableModelOptionForIntent(provider, model, parsedIntentKey)),
    )
  }

  async getAvailableProviders(
    userId: string,
    intentKey: AiModelIntentKey,
    scope: AiProviderScope,
  ): Promise<AiAvailableProviderOption[]> {
    const parsedIntentKey = AiModelIntentKeySchema.parse(intentKey)
    this.assertUserConfigurableDefaultModelIntent(parsedIntentKey)
    const parsedScope = AiProviderScopeSchema.parse(scope)
    const providers = await this.prisma.aiProvider.findMany({
      where: {
        enabled: true,
        scope: toPrismaScope(parsedScope),
        OR: [
          { scope: 'PLATFORM', visibility: 'ALL_USERS' },
          { scope: 'USER', ownerUserId: userId },
        ],
        models: {
          some: this.buildAvailableModelWhere(parsedIntentKey),
        },
      },
      orderBy: { providerName: 'asc' },
    })

    return providers.map(toAvailableProviderOption)
  }

  async getPlatformEmbeddingAvailableProviders(): Promise<AiAvailableProviderOption[]> {
    const providers = await this.prisma.aiProvider.findMany({
      where: {
        enabled: true,
        scope: 'PLATFORM',
        visibility: 'ALL_USERS',
        models: {
          some: this.buildAvailableModelWhere(AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT),
        },
      },
      orderBy: { providerName: 'asc' },
    })

    return providers.map(toAvailableProviderOption)
  }

  private async clearPlatformEmbeddingModelPolicy(): Promise<AiDefaultModelPolicyItem> {
    const policy = await this.prisma.aiPlatformEmbeddingModelPolicy.findUnique({
      where: { id: PLATFORM_EMBEDDING_MODEL_POLICY_ID },
    })

    if (policy) {
      await this.prisma.aiPlatformEmbeddingModelPolicy.delete({
        where: { id: PLATFORM_EMBEDDING_MODEL_POLICY_ID },
      })
    }

    return this.getPlatformEmbeddingModelItem()
  }

  async getAvailableProviderModels(
    userId: string,
    intentKey: AiModelIntentKey,
    providerId: string,
  ): Promise<AiAvailableModelOption[]> {
    const parsedIntentKey = AiModelIntentKeySchema.parse(intentKey)
    this.assertUserConfigurableDefaultModelIntent(parsedIntentKey)

    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: providerId,
        enabled: true,
        OR: [
          { scope: 'PLATFORM', visibility: 'ALL_USERS' },
          { scope: 'USER', ownerUserId: userId },
        ],
      },
      include: {
        models: {
          where: { enabled: true },
          orderBy: { modelName: 'asc' },
        },
      },
    })

    if (!provider) {
      return []
    }

    return provider.models.map(model => this.toAvailableModelOptionForIntent(provider, model, parsedIntentKey))
  }

  async getPlatformEmbeddingAvailableProviderModels(
    providerId: string,
  ): Promise<AiAvailableModelOption[]> {
    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: providerId,
        enabled: true,
        scope: 'PLATFORM',
        visibility: 'ALL_USERS',
      },
      include: {
        models: {
          where: this.buildAvailableModelWhere(AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT),
          orderBy: { modelName: 'asc' },
        },
      },
    })

    if (!provider) {
      return []
    }

    return provider.models.map(model => this.toAvailableModelOptionForIntent(provider, model, AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT))
  }

  private async getDefaultModelItem(userId: string, intentKey: AiModelIntentKey): Promise<AiDefaultModelPolicyItem> {
    const policy = await this.prisma.aiDefaultModelPolicy.findUnique({
      where: {
        userId_intentKey: {
          userId,
          intentKey,
        },
      },
    })

    if (!policy) {
      return toDefaultModelPolicyItem({
        intentKey,
        modelRef: null,
        status: AI_DEFAULT_MODEL_STATUS.NOT_CONFIGURED,
        invalidReason: null,
        updatedAt: null,
      })
    }

    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: policy.providerId,
        enabled: true,
        OR: [
          { scope: 'PLATFORM', visibility: 'ALL_USERS' },
          { scope: 'USER', ownerUserId: userId },
        ],
      },
    })

    if (!provider) {
      return this.invalidPolicy(intentKey, policy.updatedAt, '服务商不可用')
    }

    const model = await this.prisma.aiProviderModel.findFirst({
      where: {
        providerId: policy.providerId,
        modelId: policy.modelId,
        enabled: true,
      },
    })

    if (!model) {
      return this.invalidPolicy(intentKey, policy.updatedAt, '模型不可用')
    }

    if (!isAiModelCapabilitySatisfied({
      modelType: toDomainModelType(model.modelType),
      capabilities: model.capabilities.map(toDomainCapability),
    }, intentKey)) {
      return this.invalidPolicy(intentKey, policy.updatedAt, '模型不满足当前场景要求')
    }

    return toDefaultModelPolicyItem({
      intentKey,
      modelRef: buildAiModelRef({
        providerId: provider.id,
        scope: provider.scope,
        providerKey: provider.providerKey,
        modelId: policy.modelId,
      }),
      status: AI_DEFAULT_MODEL_STATUS.READY,
      invalidReason: null,
      updatedAt: policy.updatedAt,
    })
  }

  private async getPlatformEmbeddingModelItem(): Promise<AiDefaultModelPolicyItem> {
    const policy = await this.prisma.aiPlatformEmbeddingModelPolicy.findUnique({
      where: { id: PLATFORM_EMBEDDING_MODEL_POLICY_ID },
    })

    if (!policy) {
      return toDefaultModelPolicyItem({
        intentKey: AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT,
        modelRef: null,
        status: AI_DEFAULT_MODEL_STATUS.NOT_CONFIGURED,
        invalidReason: null,
        updatedAt: null,
      })
    }

    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: policy.providerId,
        enabled: true,
        scope: 'PLATFORM',
        visibility: 'ALL_USERS',
      },
    })

    if (!provider) {
      return this.invalidPolicy(AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT, policy.updatedAt, '平台服务商不可用')
    }

    const model = await this.prisma.aiProviderModel.findFirst({
      where: {
        providerId: policy.providerId,
        modelId: policy.modelId,
        enabled: true,
      },
    })

    if (!model) {
      return this.invalidPolicy(AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT, policy.updatedAt, '模型不可用')
    }

    if (!isAiModelCapabilitySatisfied({
      modelType: toDomainModelType(model.modelType),
      capabilities: model.capabilities.map(toDomainCapability),
    }, AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT)) {
      return this.invalidPolicy(AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT, policy.updatedAt, '模型不满足当前场景要求')
    }

    return toDefaultModelPolicyItem({
      intentKey: AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT,
      modelRef: buildAiModelRef({
        providerId: provider.id,
        scope: provider.scope,
        providerKey: provider.providerKey,
        modelId: policy.modelId,
      }),
      status: AI_DEFAULT_MODEL_STATUS.READY,
      invalidReason: null,
      updatedAt: policy.updatedAt,
    })
  }

  private buildAvailableModelWhere(intentKey: AiModelIntentKey): Prisma.AiProviderModelWhereInput {
    const requirement = getAiModelIntentRequirement(intentKey)
    const requiredCapabilities = requirement.requiredCapabilities.map(toPrismaCapability)
    const modelWhere: Prisma.AiProviderModelWhereInput = {
      enabled: true,
      modelType: toPrismaModelType(requirement.modelType),
    }

    if (requiredCapabilities.length > 0) {
      modelWhere.capabilities = { hasEvery: requiredCapabilities }
    }

    return modelWhere
  }

  private assertUserConfigurableDefaultModelIntent(intentKey: AiModelIntentKey): void {
    if (intentKey === AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT) {
      throw new BadRequestException('平台向量模型由系统后台统一配置')
    }
  }

  private invalidPolicy(intentKey: AiModelIntentKey, updatedAt: Date, invalidReason: string): AiDefaultModelPolicyItem {
    return toDefaultModelPolicyItem({
      intentKey,
      modelRef: null,
      status: AI_DEFAULT_MODEL_STATUS.INVALID,
      invalidReason,
      updatedAt,
    })
  }

  private toAvailableModelOptionForIntent(
    provider: AiProvider,
    model: AiProviderModel,
    intentKey: AiModelIntentKey,
  ): AiAvailableModelOption {
    const selectable = isAiModelCapabilitySatisfied({
      modelType: toDomainModelType(model.modelType),
      capabilities: model.capabilities.map(toDomainCapability),
    }, intentKey)

    return toAvailableModelOption({
      provider,
      model,
      selectable,
      unavailableReason: selectable ? null : '模型不满足当前场景要求',
    })
  }
}

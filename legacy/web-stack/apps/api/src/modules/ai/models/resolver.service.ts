import type {
  AiModelCapability,
  AiModelIntentKey,
  AiModelModality,
  AiModelRef,
  AiModelType,
} from '@haohaoxue/lexora-contracts'
import type { Prisma } from '@prisma/client'
import { AI_MODEL_INTENT_KEY, AiModelIntentKeySchema } from '@haohaoxue/lexora-contracts'
import { getAiModelIntentFallbackChain, isAiModelCapabilitySatisfied, normalizeAiEndpoint } from '@haohaoxue/lexora-shared'
import { BadRequestException, Injectable } from '@nestjs/common'
import { PrismaService } from '../../../database/prisma.service'
import {
  toDomainAuthMode,
  toDomainCapability,
  toDomainModality,
  toDomainModelType,
  toDomainScope,
} from '../ai.utils'
import { AiProviderAdaptersService } from '../providers/adapters.service'
import { PLATFORM_EMBEDDING_MODEL_POLICY_ID } from './defaults.constants'

export interface ResolveAiModelTargetParams {
  actorUserId: string
  intentKey: AiModelIntentKey
  requestedModelRef?: Pick<AiModelRef, 'providerId' | 'modelId'> | null
}

export interface ResolvedAiModelTarget {
  providerId: string
  scope: 'platform' | 'user'
  providerKey: string
  providerName: string
  adapterKey: string
  endpoint: string
  apiKey: string | null
  authMode: 'api-key' | 'bearer' | 'none'
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
export class AiModelResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adaptersService: AiProviderAdaptersService,
  ) {}

  async resolveModelTarget(params: ResolveAiModelTargetParams): Promise<ResolvedAiModelTarget> {
    const intentKey = AiModelIntentKeySchema.parse(params.intentKey)
    const modelRef = await this.resolveRequestedModelRef(params.actorUserId, intentKey, params.requestedModelRef)
    const provider = await this.prisma.aiProvider.findFirst({
      where: {
        id: modelRef.providerId,
        enabled: true,
        OR: this.getProviderAccessWhere(params.actorUserId, intentKey),
      },
    })

    if (!provider) {
      throw new BadRequestException('服务商不可用')
    }

    const model = await this.prisma.aiProviderModel.findFirst({
      where: {
        providerId: modelRef.providerId,
        modelId: modelRef.modelId,
        enabled: true,
      },
    })

    if (!model) {
      throw new BadRequestException('模型不可用')
    }

    if (!isAiModelCapabilitySatisfied({
      modelType: toDomainModelType(model.modelType),
      capabilities: model.capabilities.map(toDomainCapability),
    }, intentKey)) {
      throw new BadRequestException('模型不满足当前场景要求')
    }

    const endpoint = provider.endpoint?.trim()
    if (!endpoint) {
      throw new BadRequestException('服务商未配置 API 地址')
    }

    const apiKey = this.adaptersService.decryptApiKey(provider.apiKeyEncrypted)
    if (provider.authMode !== 'NONE' && !apiKey) {
      throw new BadRequestException('服务商未配置 API Key')
    }

    return {
      providerId: provider.id,
      scope: toDomainScope(provider.scope),
      providerKey: provider.providerKey,
      providerName: provider.providerName,
      adapterKey: provider.adapterKey,
      endpoint: normalizeAiEndpoint(endpoint),
      apiKey,
      authMode: toDomainAuthMode(provider.authMode),
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

  private async resolveRequestedModelRef(
    actorUserId: string,
    intentKey: AiModelIntentKey,
    requestedModelRef: Pick<AiModelRef, 'providerId' | 'modelId'> | null | undefined,
  ) {
    if (requestedModelRef) {
      return requestedModelRef
    }

    return this.resolveDefaultModelRef(actorUserId, intentKey)
  }

  private async resolveDefaultModelRef(actorUserId: string, intentKey: AiModelIntentKey) {
    if (intentKey === AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT) {
      return this.resolvePlatformEmbeddingModelRef()
    }

    const intentFallbackChain = getAiModelIntentFallbackChain(intentKey)
    const policies = await this.prisma.aiDefaultModelPolicy.findMany({
      where: {
        userId: actorUserId,
        intentKey: { in: intentFallbackChain },
      },
    })
    const policyByIntentKey = new Map(policies.map(policy => [policy.intentKey, policy]))

    for (const currentIntentKey of intentFallbackChain) {
      const policy = policyByIntentKey.get(currentIntentKey)

      if (policy) {
        return {
          providerId: policy.providerId,
          modelId: policy.modelId,
        }
      }
    }

    throw new BadRequestException('请先配置默认模型')
  }

  private async resolvePlatformEmbeddingModelRef() {
    const policy = await this.prisma.aiPlatformEmbeddingModelPolicy.findUnique({
      where: { id: PLATFORM_EMBEDDING_MODEL_POLICY_ID },
    })

    if (!policy) {
      throw new BadRequestException('请先配置平台向量模型')
    }

    return {
      providerId: policy.providerId,
      modelId: policy.modelId,
    }
  }

  private getProviderAccessWhere(actorUserId: string, intentKey: AiModelIntentKey): Prisma.AiProviderWhereInput[] {
    if (intentKey === AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT) {
      return [
        { scope: 'PLATFORM', visibility: 'ALL_USERS' },
      ]
    }

    return [
      { scope: 'PLATFORM', visibility: 'ALL_USERS' },
      { scope: 'USER', ownerUserId: actorUserId },
    ]
  }
}

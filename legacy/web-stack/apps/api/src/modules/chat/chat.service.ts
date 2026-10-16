import type {
  AgentRuntimeHints,
  AiModelRef,
  ChatGenerationModelTargetSnapshot,
  ChatModelItem,
  ChatMutationResponse,
  ChatRuntimeConfig,
  ChatSessionOrigin,
  CreateChatSessionMessageRequest,
  EditAndSendChatMessageRequest,
  ResumeChatRunRequest,
  RetryChatAssistantMessageRequest,
} from '@haohaoxue/lexora-contracts'
import type { FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import {
  AGENT_LOCATION_SKILL_KEY,
  AGENT_RUNTIME_CONTROL_TYPE,
  AgentLocationSkillConfigSchema,
  AgentProfileConfigSchema,
  AI_MODEL_INTENT_KEY,
  ChatGenerationModelTargetSnapshotSchema,
} from '@haohaoxue/lexora-contracts'
import {
  Injectable,
  Logger,
} from '@nestjs/common'
import { AgentCommandPublisherService } from '../agent/agent-command-publisher.service'
import { AgentProfilesService } from '../agent/agent-profiles.service'
import { AgentRuntimeCleanupTasksService } from '../agent/agent-runtime-cleanup-tasks.service'
import { AiDefaultModelsService } from '../ai/models/defaults.service'
import { AiModelResolverService } from '../ai/models/resolver.service'
import { ChatLocationResolverService } from './chat-location-resolver.service'
import { createRuntimeHintsWithLocationClientIp } from './chat-location-runtime.utils'
import { ChatRunDispatcherService } from './chat-run-dispatcher.service'
import { ChatSessionsService } from './chat-sessions.service'

interface ChatMessageMutationParams {
  allowChannelMutation?: boolean
  userId: string
  sessionId: string
  origin: ChatSessionOrigin
}

interface BatchDeleteChatSessionsParams {
  userId: string
  sessionIds: string[]
  origin: ChatSessionOrigin
}

interface RequestRuntimeParams {
  request?: FastifyRequest
}

interface SendChatMessageParams extends ChatMessageMutationParams, CreateChatSessionMessageRequest, RequestRuntimeParams {}

interface EditAndSendChatMessageParams extends ChatMessageMutationParams, EditAndSendChatMessageRequest, RequestRuntimeParams {
  messageId: string
}

interface RetryChatAssistantMessageParams extends ChatMessageMutationParams, RetryChatAssistantMessageRequest, RequestRuntimeParams {
  messageId: string
}

interface SwitchChatActiveMessageParams extends ChatMessageMutationParams {
  messageId: string
}

interface CancelChatRunParams {
  userId: string
  runId: string
  origin: ChatSessionOrigin
}

interface ResumeChatRunParams extends CancelChatRunParams, ResumeChatRunRequest {
  request: FastifyRequest
}

interface UpdateChatSessionModelParams {
  userId: string
  sessionId: string
  origin: ChatSessionOrigin
  modelRef: Pick<AiModelRef, 'providerId' | 'modelId'> | null
}

interface ResolvedChatModelTarget {
  modelTargetSnapshot: ChatGenerationModelTargetSnapshot
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name)

  constructor(
    private readonly chatSessionsService: ChatSessionsService,
    private readonly modelResolverService: AiModelResolverService,
    private readonly defaultModelsService: AiDefaultModelsService,
    private readonly agentProfiles: AgentProfilesService,
    private readonly chatRunDispatcher: ChatRunDispatcherService,
    private readonly chatLocationResolver: ChatLocationResolverService,
    private readonly agentCommandPublisher: AgentCommandPublisherService,
    private readonly agentRuntimeCleanupTasks: AgentRuntimeCleanupTasksService,
  ) {}

  async getRuntimeConfig(userId: string): Promise<ChatRuntimeConfig> {
    try {
      const agentProfile = await this.agentProfiles.getDefaultAgentProfileSettings(userId)
      const target = await this.modelResolverService.resolveModelTarget({
        actorUserId: userId,
        intentKey: AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT,
        requestedModelRef: agentProfile.modelRef ?? undefined,
      })

      return {
        enabled: true,
        ready: true,
        defaultModel: {
          providerId: target.providerId,
          scope: target.scope,
          providerKey: target.providerKey,
          providerName: target.providerName,
          modelId: target.modelId,
          modelName: target.modelName,
          modelType: target.modelType,
          inputModalities: target.inputModalities,
          outputModalities: target.outputModalities,
          capabilities: target.capabilities,
          selectable: true,
          unavailableReason: null,
        },
        notReadyReason: null,
      }
    }
    catch (error) {
      return {
        enabled: false,
        ready: false,
        defaultModel: null,
        notReadyReason: error instanceof Error && error.message ? error.message : '请先配置默认模型',
      }
    }
  }

  async getModels(userId: string): Promise<ChatModelItem[]> {
    this.logger.log(`chat model list requested: user=${userId}`)
    return this.defaultModelsService.getAvailableModels(userId, AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT)
  }

  async updateSessionModel(params: UpdateChatSessionModelParams) {
    if (params.modelRef) {
      await this.modelResolverService.resolveModelTarget({
        actorUserId: params.userId,
        intentKey: AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT,
        requestedModelRef: params.modelRef,
      })
    }

    return this.chatSessionsService.updateSessionModel(params)
  }

  async sendMessage(params: SendChatMessageParams): Promise<ChatMutationResponse> {
    const generationId = randomUUID()
    const modelTarget = await this.resolveChatModelTarget(params)
    const runtimeHints = await this.resolveLocationRuntimeHints(params)
    const { request: _request, ...mutationParams } = params
    const result = await this.chatSessionsService.sendMessage({
      ...mutationParams,
      runtimeHints,
      generationId,
      runId: generationId,
      ...modelTarget,
    })

    this.dispatchRun(generationId, params.sessionId)
    return result
  }

  async editAndSendMessage(params: EditAndSendChatMessageParams): Promise<ChatMutationResponse> {
    const generationId = randomUUID()
    const modelTarget = await this.resolveChatModelTarget(params)
    const runtimeHints = await this.resolveLocationRuntimeHints(params)
    const { request: _request, ...mutationParams } = params
    const result = await this.chatSessionsService.editAndSendMessage({
      ...mutationParams,
      runtimeHints,
      generationId,
      runId: generationId,
      ...modelTarget,
    })

    this.dispatchRun(generationId, params.sessionId)
    return result
  }

  async retryAssistantMessage(params: RetryChatAssistantMessageParams): Promise<ChatMutationResponse> {
    const generationId = randomUUID()
    const modelTarget = await this.resolveChatModelTarget(params)
    const runtimeHints = await this.resolveLocationRuntimeHints(params)
    const { request: _request, ...mutationParams } = params
    const result = await this.chatSessionsService.retryAssistantMessage({
      ...mutationParams,
      runtimeHints,
      generationId,
      runId: generationId,
      ...modelTarget,
    })

    this.dispatchRun(generationId, params.sessionId)
    return result
  }

  async switchActiveMessage(params: SwitchChatActiveMessageParams): Promise<ChatMutationResponse> {
    return this.chatSessionsService.switchActiveMessage(params)
  }

  async deleteSession(params: ChatMessageMutationParams): Promise<void> {
    const result = await this.chatSessionsService.deleteSession(params.userId, params.sessionId, params.origin)

    await this.cleanupDeletedChatSessions({
      activeRunIds: result.activeRunIds,
      sessionIds: [params.sessionId],
    })
  }

  async batchDeleteSessions(params: BatchDeleteChatSessionsParams): Promise<{ deletedSessionIds: string[] }> {
    const result = await this.chatSessionsService.batchDeleteSessions(params.userId, params.sessionIds, params.origin)

    await this.cleanupDeletedChatSessions({
      activeRunIds: result.activeRunIds,
      sessionIds: result.deletedSessionIds,
    })

    return {
      deletedSessionIds: result.deletedSessionIds,
    }
  }

  async cancelRun(params: CancelChatRunParams): Promise<ChatMutationResponse> {
    const result = await this.chatSessionsService.cancelRun(params)

    await this.agentCommandPublisher.publishRuntimeControl({
      controlId: randomUUID(),
      type: AGENT_RUNTIME_CONTROL_TYPE.CANCEL_RUN,
      runId: params.runId,
      reason: 'user_cancelled',
    }).catch(error => this.logger.warn(
      error instanceof Error ? error.message : `publish chat run cancel failed: run=${params.runId}`,
    ))

    return result
  }

  async resumeRun(params: ResumeChatRunParams): Promise<ChatMutationResponse> {
    const prepared = await this.chatSessionsService.prepareResumeRun({
      ...params,
    })
    if (!prepared.shouldDispatch) {
      return prepared.response
    }

    this.dispatchRun(params.runId, prepared.response.session.id)
    return prepared.response
  }

  private async resolveChatModelTarget(params: ChatMessageMutationParams): Promise<ResolvedChatModelTarget> {
    const sessionModelRef = await this.chatSessionsService.getSessionModelSelection(params.userId, params.sessionId, params.origin)
    const target = await this.modelResolverService.resolveModelTarget({
      actorUserId: params.userId,
      intentKey: AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT,
      requestedModelRef: sessionModelRef,
    })

    const modelTargetSnapshot = ChatGenerationModelTargetSnapshotSchema.parse({
      providerId: target.providerId,
      scope: target.scope,
      providerKey: target.providerKey,
      adapterKey: target.adapterKey,
      endpoint: target.endpoint,
      authMode: target.authMode,
      modelId: target.modelId,
      modelName: target.modelName,
      modelType: target.modelType,
      inputModalities: target.inputModalities,
      outputModalities: target.outputModalities,
      capabilities: target.capabilities,
      contextWindow: target.contextWindow,
      maxOutputTokens: target.maxOutputTokens,
    })

    return {
      modelTargetSnapshot,
    }
  }

  private async resolveLocationRuntimeHints(params: RequestRuntimeParams & {
    userId: string
    disabledSkillKeys?: string[]
    runtimeHints?: AgentRuntimeHints
  }): Promise<AgentRuntimeHints | undefined> {
    const sanitizedRuntimeHints = params.runtimeHints
      ? createRuntimeHintsWithLocationClientIp({
          runtimeHints: params.runtimeHints,
          clientIp: null,
        })
      : undefined

    if (!params.request) {
      return sanitizedRuntimeHints
    }

    if (params.disabledSkillKeys?.includes(AGENT_LOCATION_SKILL_KEY)) {
      return sanitizedRuntimeHints
    }

    if (!await this.shouldResolveAutomaticLocation(params.userId)) {
      return sanitizedRuntimeHints
    }

    return this.chatLocationResolver.resolveRuntimeHints({
      request: params.request,
      runtimeHints: sanitizedRuntimeHints,
    })
  }

  private async shouldResolveAutomaticLocation(userId: string): Promise<boolean> {
    const profile = await this.agentProfiles.ensureDefaultAgentProfile({ ownerUserId: userId })
    const config = AgentProfileConfigSchema.parse(profile.currentConfig)
    const binding = config.skillBindings.find(item => item.key === AGENT_LOCATION_SKILL_KEY)
    if (!binding?.enabled) {
      return false
    }

    const locationConfig = AgentLocationSkillConfigSchema.safeParse(binding.config)
    return locationConfig.success && locationConfig.data.mode === 'auto'
  }

  private async cleanupDeletedChatSessions(input: {
    activeRunIds: string[]
    sessionIds: string[]
  }): Promise<void> {
    await Promise.all(input.activeRunIds.map(runId => this.agentCommandPublisher.publishRuntimeControl({
      controlId: randomUUID(),
      type: AGENT_RUNTIME_CONTROL_TYPE.CANCEL_RUN,
      runId,
      reason: 'chat_session_deleted',
    }).catch(error => this.logger.warn(
      error instanceof Error ? error.message : `publish deleted chat run cancel failed: run=${runId}`,
    ))))

    await Promise.all(input.sessionIds.map(sessionId =>
      this.agentRuntimeCleanupTasks.enqueueChatSessionCheckpointCleanup({ sessionId }),
    ))
  }

  private dispatchRun(runId: string, sessionId: string): void {
    void this.chatRunDispatcher.dispatchRun(runId).catch(error => this.logger.error(
      error instanceof Error ? error.message : `dispatch chat run failed: session=${sessionId} run=${runId}`,
      error instanceof Error ? error.stack : undefined,
    ))
  }
}

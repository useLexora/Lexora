import type {
  AgentChatContextMessage,
  AgentChatRuntimeContext,
  AgentClientAction,
  AgentClientActionResult,
  AgentMemoryRunOptions,
  AgentProfileSnapshot,
  AgentRuntimeHints,
  AgentRuntimeModelTarget,
  AgentRuntimeSkillContext,
  AgentRuntimeSkillCredentials,
  AiModelRef,
  ChatDisabledSkillKeys,
  ChatGenerationBootstrap,
  ChatGenerationModelTargetSnapshot,
  ChatMessageAttachmentInput,
  ChatMessageContentJSON,
  ChatMessageFailureReason,
  ChatMessageMetadata,
  ChatMutationResponse,
  ChatPersistedMessageAttachment,
  ChatRunSummary,
  ChatSessionChannel,
  ChatSessionDetail,
  ChatSessionOrigin,
  ChatSessionSummary,
  ChatSkillInvocation,
  ResolvedLanguagePreference,
} from '@haohaoxue/lexora-contracts'
import type { AgentProfileForGeneration } from '../agent/agent-profiles.service'
import type { ChatAssetStorageLocator } from './chat-assets.service'
import type { ChatContextSnapshotCreateData } from './chat-context-snapshots.service'
import { randomUUID } from 'node:crypto'
import {
  AgentClientActionSchema,
  AgentMemoryRunOptionsSchema,
  AgentProfileSnapshotSchema,
  AgentRuntimeHintsSchema,
  AgentRuntimeModelTargetSchema,
  AgentRuntimeSkillContextSchema,
  AgentRuntimeSkillCredentialsSchema,
  AI_MODEL_INTENT_KEY,
  API_ERROR_CODE,
  CHAT_MESSAGE_PART_TYPE,
  CHAT_RUN_STATUS,
  CHAT_SESSION_CHANNEL,
  CHAT_SESSION_DEFAULT_TITLE,
  CHAT_SESSION_EVENT_TYPE,
  ChatDisabledSkillKeysSchema,
  ChatGenerationBootstrapSchema,
  ChatGenerationModelTargetSnapshotSchema,
  ChatMutationResponseSchema,
  ChatPersistedMessageAttachmentSchema,
  ChatSkillInvocationSchema,
  WORKSPACE_MEMBER_STATUS,
} from '@haohaoxue/lexora-contracts'
import { LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import { buildAgentChatThreadId } from '@haohaoxue/lexora-shared/agent'
import { isChatUploadedMessageAttachment, resolveMissingChatAttachmentInputModalities } from '@haohaoxue/lexora-shared/chat'
import { resolveLanguagePreference } from '@haohaoxue/lexora-shared/user'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common'
import {
  ChatMessageGenerationStatus,
  ChatSessionMessagePartType,
  ChatSessionMessageRole,
  ChatSessionMessageStatus,
  ChatSessionRunStatus,
  Prisma,
  ChatSessionChannel as PrismaChatSessionChannel,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { apiBadRequest, apiConflict, apiNotFound } from '../../utils/api-error'
import {
  AgentProfilesService,
  resolveAgentProfileFixedModelRef,
} from '../agent/agent-profiles.service'
import { AgentSkillsService } from '../agent/agent-skills.service'
import { AiModelResolverService } from '../ai/models/resolver.service'
import { mapLanguagePreference } from '../users/users.utils'
import { ChatAssetsService } from './chat-assets.service'
import { ChatContextSnapshotsService } from './chat-context-snapshots.service'
import { ChatSessionEventsService } from './chat-session-events.service'
import {
  ChatSessionDetailRecord,
  ChatSessionMessageRecord,
  getChatMessageContentSnapshot,
  toChatMessageContextSnapshotMeta,
  toChatMessageRole,
  toChatMessageStatus,
  toChatSessionDetail,
  toChatSessionModelRef,
  toChatSessionSummary,
  toPrismaChatMessagePartType,
  toPrismaChatSessionChannel,
  toPrismaChatSessionOrigin,
} from './chat.utils'

const continuableAssistantStatuses = new Set<ChatSessionMessageStatus>([
  ChatSessionMessageStatus.COMPLETED,
  ChatSessionMessageStatus.FAILED,
  ChatSessionMessageStatus.CANCELLED,
])

const bootstrappableGenerationStatuses = new Set<ChatMessageGenerationStatus>([
  ChatMessageGenerationStatus.PENDING,
  ChatMessageGenerationStatus.RUNNING,
  ChatMessageGenerationStatus.REQUIRES_ACTION,
])

const activeRunStatuses: ChatSessionRunStatus[] = [
  ChatSessionRunStatus.PENDING,
  ChatSessionRunStatus.RUNNING,
  ChatSessionRunStatus.REQUIRES_ACTION,
]

const chatSessionSummarySelect = {
  id: true,
  workspaceId: true,
  origin: true,
  channel: true,
  title: true,
  selectedProviderId: true,
  selectedModelId: true,
  agentProfile: {
    select: {
      id: true,
      name: true,
      description: true,
      avatarUrl: true,
    },
  },
  modelOverrideProviderId: true,
  modelOverrideModelId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChatSessionSelect

const chatMessagePartSelect = {
  id: true,
  type: true,
  text: true,
  order: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChatSessionMessagePartSelect

const chatContextSnapshotMetaSelect = {
  id: true,
  type: true,
  documentId: true,
  title: true,
  scope: true,
  size: true,
  sourceAttachmentIds: true,
  capturedAt: true,
  createdAt: true,
} satisfies Prisma.ChatMessageContextSnapshotSelect

const chatContextSnapshotContentSelect = {
  ...chatContextSnapshotMetaSelect,
  content: true,
} satisfies Prisma.ChatMessageContextSnapshotSelect

const chatSessionMessageBaseSelect = {
  id: true,
  role: true,
  status: true,
  content: true,
  parentMessageId: true,
  selectedChildMessageId: true,
  branchOrder: true,
  sourceMessageId: true,
  agentRunId: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  parts: {
    select: chatMessagePartSelect,
    orderBy: {
      order: 'asc',
    },
  },
} satisfies Prisma.ChatSessionMessageSelect

const chatSessionMessageMetaSelect = {
  ...chatSessionMessageBaseSelect,
  contextSnapshots: {
    select: chatContextSnapshotMetaSelect,
    orderBy: [
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  },
} satisfies Prisma.ChatSessionMessageSelect

const chatSessionMessageContentSelect = {
  ...chatSessionMessageBaseSelect,
  contextSnapshots: {
    select: chatContextSnapshotContentSelect,
    orderBy: [
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  },
} satisfies Prisma.ChatSessionMessageSelect

const chatSessionDetailSelect = {
  ...chatSessionSummarySelect,
  activeRootMessageId: true,
  activeLeafMessageId: true,
  nextEventSequence: true,
  messages: {
    select: chatSessionMessageMetaSelect,
    orderBy: [
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  },
} satisfies Prisma.ChatSessionSelect

const chatSessionRunDetailSelect = {
  ...chatSessionSummarySelect,
  agentProfileId: true,
  agentProfile: {
    select: {
      id: true,
      ownerUserId: true,
      name: true,
      description: true,
      avatarUrl: true,
      currentConfig: true,
    },
  },
  activeRootMessageId: true,
  activeLeafMessageId: true,
  nextEventSequence: true,
  historyVersion: true,
  messages: {
    select: chatSessionMessageContentSelect,
    orderBy: [
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  },
} satisfies Prisma.ChatSessionSelect

const chatAssetStorageLocatorSelect = {
  id: true,
  bucket: true,
  objectKey: true,
} satisfies Prisma.ChatAssetSelect & Record<keyof ChatAssetStorageLocator, true>

type PersistedChatSessionDetail = Prisma.ChatSessionGetPayload<{
  select: typeof chatSessionDetailSelect
}>

type PersistedChatSessionRunDetail = Prisma.ChatSessionGetPayload<{
  select: typeof chatSessionRunDetailSelect
}>

type PersistedChatSessionDetailMessage = PersistedChatSessionDetail['messages'][number]
type PersistedChatSessionRunDetailMessage = PersistedChatSessionRunDetail['messages'][number]
type PersistedChatSessionMessage = PersistedChatSessionDetailMessage | PersistedChatSessionRunDetailMessage

interface ActivePathState<T extends PersistedChatSessionMessage = PersistedChatSessionMessage> {
  path: T[]
  activeRootMessageId: string | null
  activeLeafMessageId: string | null
  selectedChildUpdates: Array<{
    messageId: string
    selectedChildMessageId: string | null
  }>
}

const chatSessionModelRefSelect = {
  id: true,
  agentProfileId: true,
  modelOverrideProviderId: true,
  modelOverrideModelId: true,
  agentProfile: {
    select: {
      id: true,
      ownerUserId: true,
      name: true,
      description: true,
      avatarUrl: true,
      currentConfig: true,
    },
  },
} satisfies Prisma.ChatSessionSelect

type PersistedChatSessionModelRef = Prisma.ChatSessionGetPayload<{
  select: typeof chatSessionModelRefSelect
}>

interface CreateRunInput {
  allowChannelMutation?: boolean
  userId: string
  sessionId: string
  origin: ChatSessionOrigin
  content?: string
  contentJSON?: ChatMessageContentJSON
  attachments?: ChatMessageAttachmentInput[] | null
  sourceMessageId?: string
  targetMessageId?: string
  generationId: string
  runId: string
  modelTargetSnapshot: ChatGenerationModelTargetSnapshot
  memory?: AgentMemoryRunOptions
  disabledSkillKeys?: ChatDisabledSkillKeys
  runtimeHints?: AgentRuntimeHints
}

interface CreatedRunResult {
  sessionId: string
  runId: string
  generationId: string
  assistantMessageId: string
  triggerUserMessageId: string
  agentProfileId: string
  expectedHistoryVersion: number
  latestSequence: number
}

interface PreparedResumeRunResult {
  response: ChatMutationResponse
  shouldDispatch: boolean
}

@Injectable()
export class ChatSessionsService {
  private readonly logger = new Logger(ChatSessionsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatSessionEvents: ChatSessionEventsService,
    private readonly chatContextSnapshots: ChatContextSnapshotsService,
    private readonly chatAssets: ChatAssetsService,
    private readonly agentProfiles: AgentProfilesService,
    private readonly modelResolverService: AiModelResolverService,
    @Optional() private readonly agentSkills?: AgentSkillsService,
  ) {}

  async getSessions(userId: string, workspaceId: string, origin: ChatSessionOrigin): Promise<ChatSessionSummary[]> {
    await this.assertWorkspaceAccess(userId, workspaceId)

    const sessions = await this.prisma.chatSession.findMany({
      where: {
        workspaceId,
        origin: toPrismaChatSessionOrigin(origin),
      },
      select: chatSessionSummarySelect,
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    })

    return (await this.personalizeSessionAgentProfiles(userId, sessions)).map(toChatSessionSummary)
  }

  async createSession(userId: string, workspaceId: string, origin: ChatSessionOrigin): Promise<ChatSessionDetail> {
    return this.createSessionForChannel({
      userId,
      workspaceId,
      origin,
      channel: CHAT_SESSION_CHANNEL.DIRECT,
      title: CHAT_SESSION_DEFAULT_TITLE,
    })
  }

  async createSessionForChannel(input: {
    userId: string
    workspaceId: string
    origin: ChatSessionOrigin
    channel: ChatSessionChannel
    title: string
  }): Promise<ChatSessionDetail> {
    await this.assertWorkspaceAccess(input.userId, input.workspaceId)

    const session = await this.prisma.$transaction(async (tx) => {
      const agentProfile = await this.agentProfiles.ensureDefaultAgentProfile({
        ownerUserId: input.userId,
        tx,
      })

      return tx.chatSession.create({
        data: {
          workspaceId: input.workspaceId,
          createdBy: input.userId,
          origin: toPrismaChatSessionOrigin(input.origin),
          channel: toPrismaChatSessionChannel(input.channel),
          title: input.title.trim() || CHAT_SESSION_DEFAULT_TITLE,
          agentProfileId: agentProfile.id,
        },
        select: chatSessionDetailSelect,
      })
    })

    return toChatSessionDetail(toChatSessionDetailRecord(
      await this.personalizeSessionAgentProfile(input.userId, session),
    ))
  }

  async getSession(userId: string, sessionId: string, origin: ChatSessionOrigin): Promise<ChatSessionDetail> {
    const session = await this.findAccessibleSessionDetailOrThrow(userId, sessionId, origin)
    await this.repairActivePathSelection(session)

    return toChatSessionDetail(toChatSessionDetailRecord(
      await this.personalizeSessionAgentProfile(userId, session),
      await this.getActiveRunSummary(session.id),
    ))
  }

  async getSessionModelSelection(
    userId: string,
    sessionId: string,
    origin: ChatSessionOrigin,
  ): Promise<Pick<AiModelRef, 'providerId' | 'modelId'> | null> {
    const session = await this.findAccessibleSessionModelRefOrThrow(userId, sessionId, origin)
    const sessionOverride = toChatSessionModelRef(session)

    if (sessionOverride) {
      return sessionOverride
    }

    const agentProfile = await this.resolveSessionAgentProfile(session, userId)
    return resolveAgentProfileFixedModelRef(agentProfile)
  }

  async updateSessionModel(input: {
    userId: string
    sessionId: string
    origin: ChatSessionOrigin
    modelRef: Pick<AiModelRef, 'providerId' | 'modelId'> | null
  }): Promise<ChatSessionDetail> {
    const result = await this.prisma.chatSession.updateMany({
      where: this.createAccessibleSessionWhere(input.userId, input.sessionId, input.origin),
      data: {
        modelOverrideProviderId: input.modelRef?.providerId ?? null,
        modelOverrideModelId: input.modelRef?.modelId ?? null,
        updatedAt: new Date(),
      },
    })

    if (result.count === 0) {
      throw new NotFoundException('聊天会话不存在')
    }

    return this.getSession(input.userId, input.sessionId, input.origin)
  }

  async updateSessionTitle(input: {
    userId: string
    sessionId: string
    origin: ChatSessionOrigin
    title: string
  }): Promise<ChatSessionDetail> {
    const title = input.title.trim()

    if (!title) {
      throw new BadRequestException('对话名称不能为空')
    }

    const result = await this.prisma.chatSession.updateMany({
      where: this.createAccessibleSessionWhere(input.userId, input.sessionId, input.origin),
      data: {
        title,
        updatedAt: new Date(),
      },
    })

    if (result.count === 0) {
      throw new NotFoundException('聊天会话不存在')
    }

    return this.getSession(input.userId, input.sessionId, input.origin)
  }

  async deleteSession(userId: string, sessionId: string, origin: ChatSessionOrigin): Promise<{ activeRunIds: string[] }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const activeRuns = await tx.chatSessionRun.findMany({
        where: {
          sessionId,
          session: this.createAccessibleSessionWhere(userId, sessionId, origin),
          status: {
            in: activeRunStatuses,
          },
        },
        select: {
          runId: true,
        },
      })
      const chatAssets = await tx.chatAsset.findMany({
        where: {
          sessionId,
        },
        select: chatAssetStorageLocatorSelect,
      })
      const deleteResult = await tx.chatSession.deleteMany({
        where: this.createAccessibleSessionWhere(userId, sessionId, origin),
      })

      return {
        count: deleteResult.count,
        activeRunIds: activeRuns.map(run => run.runId),
        chatAssets,
      }
    })

    if (result.count === 0) {
      throw new NotFoundException('聊天会话不存在')
    }

    await this.deleteStoredChatAssetsAfterSessionDelete(result.chatAssets)

    return {
      activeRunIds: result.activeRunIds,
    }
  }

  async batchDeleteSessions(userId: string, sessionIds: string[], origin: ChatSessionOrigin): Promise<{
    activeRunIds: string[]
    deletedSessionIds: string[]
  }> {
    const uniqueSessionIds = [...new Set(sessionIds.map(id => id.trim()).filter(Boolean))]

    if (uniqueSessionIds.length === 0) {
      throw new BadRequestException('请选择要删除的聊天会话')
    }

    const prismaOrigin = toPrismaChatSessionOrigin(origin)
    const result = await this.prisma.$transaction(async (tx) => {
      const ownedSessions = await tx.chatSession.findMany({
        where: {
          id: { in: uniqueSessionIds },
          origin: prismaOrigin,
          workspace: this.createWorkspaceAccessWhere(userId),
        },
        select: {
          id: true,
        },
      })
      const deletedSessionIds = ownedSessions.map(session => session.id)

      if (deletedSessionIds.length === 0) {
        return {
          activeRunIds: [],
          deletedSessionIds,
          chatAssets: [],
        }
      }

      const activeRuns = await tx.chatSessionRun.findMany({
        where: {
          sessionId: { in: deletedSessionIds },
          status: {
            in: activeRunStatuses,
          },
        },
        select: {
          runId: true,
        },
      })

      const chatAssets = await tx.chatAsset.findMany({
        where: {
          sessionId: { in: deletedSessionIds },
        },
        select: chatAssetStorageLocatorSelect,
      })

      await tx.chatSession.deleteMany({
        where: {
          id: { in: deletedSessionIds },
          origin: prismaOrigin,
          workspace: this.createWorkspaceAccessWhere(userId),
        },
      })

      return {
        activeRunIds: activeRuns.map(run => run.runId),
        deletedSessionIds,
        chatAssets,
      }
    })

    if (result.deletedSessionIds.length === 0) {
      throw new NotFoundException('聊天会话不存在')
    }

    await this.deleteStoredChatAssetsAfterSessionDelete(result.chatAssets)

    return result
  }

  async sendMessage(input: CreateRunInput & {
    content: string
    contentJSON: ChatMessageContentJSON
    attachments?: ChatMessageAttachmentInput[] | null
    skillInvocation?: ChatSkillInvocation | null
  }): Promise<ChatMutationResponse> {
    const result = await this.createRunFromUserMessage(input)
    return this.toMutationResponse(input.userId, input.origin, result.sessionId, result.latestSequence, result.runId)
  }

  async editAndSendMessage(input: CreateRunInput & {
    messageId: string
    content: string
    contentJSON: ChatMessageContentJSON
    attachments?: ChatMessageAttachmentInput[] | null
    skillInvocation?: ChatSkillInvocation | null
  }): Promise<ChatMutationResponse> {
    const result = await this.createRunFromEditedUserMessage(input)
    return this.toMutationResponse(input.userId, input.origin, result.sessionId, result.latestSequence, result.runId)
  }

  async retryAssistantMessage(input: CreateRunInput & {
    messageId: string
  }): Promise<ChatMutationResponse> {
    const result = await this.createRunFromRetriedAssistantMessage(input)
    return this.toMutationResponse(input.userId, input.origin, result.sessionId, result.latestSequence, result.runId)
  }

  private async deleteStoredChatAssetsAfterSessionDelete(assets: ChatAssetStorageLocator[]): Promise<void> {
    await this.chatAssets.deleteStoredAssets(assets).catch(error => this.logger.warn(
      error instanceof Error ? error.message : 'deleted chat session asset cleanup failed',
    ))
  }

  async switchActiveMessage(input: {
    userId: string
    sessionId: string
    origin: ChatSessionOrigin
    messageId: string
  }): Promise<ChatMutationResponse> {
    const session = await this.findAccessibleSessionRunDetailOrThrow(input.userId, input.sessionId, input.origin)
    this.assertChannelMutationAllowed(session, false)
    await this.assertNoActiveRun(input.sessionId)

    const targetMessage = session.messages.find(message => message.id === input.messageId)
    if (!targetMessage) {
      throw new NotFoundException('聊天消息不存在')
    }

    if (targetMessage.parentMessageId) {
      const parentMessage = session.messages.find(message => message.id === targetMessage.parentMessageId)
      if (!parentMessage) {
        throw new ConflictException('聊天消息父节点不存在')
      }

      assertAlternatingChild(parentMessage, targetMessage)
    }
    else if (targetMessage.role !== ChatSessionMessageRole.USER) {
      throw new ConflictException('根分支只能切换到用户消息')
    }

    const path = resolvePathToMessage(session.messages, targetMessage.id)
    const activeRootMessageId = path[0]?.id ?? null
    const nextLeafMessageId = resolveActivePathWithOverride(
      session.messages,
      activeRootMessageId,
      targetMessage,
    ).at(-1)?.id ?? targetMessage.id

    const latestSequence = await this.prisma.$transaction(async (tx) => {
      if (targetMessage.parentMessageId) {
        await tx.chatSessionMessage.update({
          where: { id: targetMessage.parentMessageId },
          data: {
            selectedChildMessageId: targetMessage.id,
          },
        })
      }

      await tx.chatSession.update({
        where: { id: session.id },
        data: {
          activeRootMessageId,
          activeLeafMessageId: nextLeafMessageId,
          historyVersion: {
            increment: 1,
          },
          updatedAt: new Date(),
        },
      })

      return this.chatSessionEvents.appendEvents(tx, session.id, [
        {
          type: CHAT_SESSION_EVENT_TYPE.BRANCH_SWITCHED,
          messageId: targetMessage.id,
          payload: {
            activeRootMessageId,
            activeLeafMessageId: nextLeafMessageId,
          },
        },
      ])
    })

    return this.toMutationResponse(input.userId, input.origin, input.sessionId, latestSequence)
  }

  async cancelRun(input: {
    userId: string
    runId: string
    origin: ChatSessionOrigin
  }): Promise<ChatMutationResponse> {
    const run = await this.prisma.chatSessionRun.findFirst({
      where: {
        runId: input.runId,
        actorUserId: input.userId,
        session: {
          origin: toPrismaChatSessionOrigin(input.origin),
          workspace: this.createWorkspaceAccessWhere(input.userId),
        },
      },
      select: {
        runId: true,
        sessionId: true,
        assistantMessageId: true,
        commandContext: true,
        status: true,
      },
    })

    if (!run) {
      throw new NotFoundException('聊天运行不存在')
    }

    if (
      run.status !== ChatSessionRunStatus.PENDING
      && run.status !== ChatSessionRunStatus.RUNNING
      && run.status !== ChatSessionRunStatus.REQUIRES_ACTION
    ) {
      return this.toMutationResponse(input.userId, input.origin, run.sessionId, await this.chatSessionEvents.getLatestSequence(run.sessionId), run.runId)
    }

    const completedAt = new Date()
    const latestSequence = await this.prisma.$transaction(async (tx) => {
      await tx.chatSessionRun.update({
        where: { runId: run.runId },
        data: {
          status: ChatSessionRunStatus.CANCELLED,
          completedAt,
          dispatchLeaseExpiresAt: null,
        },
      })
      await tx.chatMessageGeneration.updateMany({
        where: { generationId: run.runId },
        data: {
          status: ChatMessageGenerationStatus.CANCELLED,
          completedAt,
          dispatchLeaseExpiresAt: null,
        },
      })
      await tx.chatSessionMessage.update({
        where: { id: run.assistantMessageId },
        data: {
          status: ChatSessionMessageStatus.CANCELLED,
          completedAt,
        },
      })
      await tx.chatSession.update({
        where: { id: run.sessionId },
        data: {
          updatedAt: completedAt,
        },
      })

      return this.chatSessionEvents.appendEvents(tx, run.sessionId, [
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_CANCELLED,
          runId: run.runId,
          payload: {},
        },
        {
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_CANCELLED,
          messageId: run.assistantMessageId,
          runId: run.runId,
          payload: {},
        },
      ])
    })

    return this.toMutationResponse(input.userId, input.origin, run.sessionId, latestSequence, run.runId)
  }

  async prepareResumeRun(input: {
    userId: string
    runId: string
    origin: ChatSessionOrigin
    resume: AgentClientActionResult
  }): Promise<PreparedResumeRunResult> {
    const run = await this.prisma.chatSessionRun.findFirst({
      where: {
        runId: input.runId,
        actorUserId: input.userId,
        session: {
          origin: toPrismaChatSessionOrigin(input.origin),
          workspace: this.createWorkspaceAccessWhere(input.userId),
        },
      },
      select: {
        runId: true,
        sessionId: true,
        assistantMessageId: true,
        commandContext: true,
        status: true,
      },
    })

    if (!run) {
      throw new NotFoundException('聊天运行不存在')
    }

    if (run.status !== ChatSessionRunStatus.REQUIRES_ACTION) {
      return {
        response: await this.toMutationResponse(
          input.userId,
          input.origin,
          run.sessionId,
          await this.chatSessionEvents.getLatestSequence(run.sessionId),
          run.runId,
        ),
        shouldDispatch: false,
      }
    }

    const pendingAction = readPendingClientAction(run.commandContext)
    if (!pendingAction) {
      throw new ConflictException('聊天运行缺少待处理的客户端动作')
    }

    if (!isClientActionResultForAction(input.resume, pendingAction)) {
      throw new BadRequestException('客户端动作结果与当前聊天运行不匹配')
    }

    const now = new Date()
    const dispatchLeaseExpiresAt = new Date(now.getTime() - 1)
    const result = await this.prisma.$transaction(async (tx) => {
      const runUpdate = await tx.chatSessionRun.updateMany({
        where: {
          runId: run.runId,
          status: ChatSessionRunStatus.REQUIRES_ACTION,
        },
        data: {
          status: ChatSessionRunStatus.RUNNING,
          commandPublishedAt: null,
          dispatchLeaseExpiresAt,
        },
      })

      if (runUpdate.count === 0) {
        return null
      }

      const generation = await tx.chatMessageGeneration.update({
        where: {
          generationId: run.runId,
        },
        data: {
          status: ChatMessageGenerationStatus.RUNNING,
          commandPublishedAt: null,
          dispatchLeaseExpiresAt,
          attempt: {
            increment: 1,
          },
        },
        select: {
          attempt: true,
        },
      })
      await tx.chatSessionRun.update({
        where: { runId: run.runId },
        data: {
          commandContext: toJsonObject(setResumeClientActionResult(
            run.commandContext,
            input.resume,
            `chat:generation:${run.runId}:resume:${generation.attempt}`,
          )),
        },
      })
      await tx.chatSession.update({
        where: { id: run.sessionId },
        data: {
          updatedAt: now,
        },
      })
      const clientActionToolResult = await createClientActionToolResultPart({
        tx,
        action: pendingAction,
        messageId: run.assistantMessageId,
        runId: run.runId,
        resume: input.resume,
      })
      const latestSequence = await this.chatSessionEvents.appendEvents(tx, run.sessionId, [
        clientActionToolResult.event,
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_STARTED,
          messageId: run.assistantMessageId,
          runId: run.runId,
          payload: {
            resume: true,
          },
        },
      ])

      return {
        latestSequence,
      }
    })

    if (!result) {
      return {
        response: await this.toMutationResponse(
          input.userId,
          input.origin,
          run.sessionId,
          await this.chatSessionEvents.getLatestSequence(run.sessionId),
          run.runId,
        ),
        shouldDispatch: false,
      }
    }

    return {
      response: await this.toMutationResponse(input.userId, input.origin, run.sessionId, result.latestSequence, run.runId),
      shouldDispatch: true,
    }
  }

  async getAgentGenerationBootstrap(input: {
    generationId: string
  }): Promise<ChatGenerationBootstrap> {
    const generation = await this.prisma.chatMessageGeneration.findFirst({
      where: {
        generationId: input.generationId,
        deletedAt: null,
      },
      select: {
        generationId: true,
        sessionId: true,
        assistantMessageId: true,
        triggerUserMessageId: true,
        actorUserId: true,
        attempt: true,
        status: true,
        agentProfileSnapshot: true,
        modelTargetSnapshot: true,
      },
    })

    if (!generation) {
      throw apiNotFound(API_ERROR_CODE.CHAT_GENERATION_NOT_FOUND)
    }

    if (!bootstrappableGenerationStatuses.has(generation.status)) {
      throw apiConflict(API_ERROR_CODE.CHAT_GENERATION_FINISHED)
    }

    const modelTargetSnapshot = ChatGenerationModelTargetSnapshotSchema.parse(generation.modelTargetSnapshot)
    const agentProfileSnapshot = AgentProfileSnapshotSchema.parse(generation.agentProfileSnapshot)
    const run = await this.prisma.chatSessionRun.findUnique({
      where: { runId: generation.generationId },
      select: { commandContext: true },
    })
    const memory = readAgentMemoryRunOptions(run?.commandContext)
    const disabledSkillKeys = readChatDisabledSkillKeys(run?.commandContext)
    const runtimeHints = readAgentRuntimeHints(run?.commandContext)
    const [context, runtimeModelTarget, skills, skillCredentials] = await Promise.all([
      this.resolveAgentRuntimeContext({
        actorId: generation.actorUserId,
        sessionId: generation.sessionId,
        triggerUserMessageId: generation.triggerUserMessageId,
        memory,
        disabledSkillKeys,
        runtimeHints,
      }),
      this.resolveRuntimeModelTarget(generation.actorUserId, modelTargetSnapshot),
      this.agentSkills
        ? this.agentSkills.resolveRuntimeSkillContext({
            actorUserId: generation.actorUserId,
            agentProfile: agentProfileSnapshot,
          })
        : AgentRuntimeSkillContextSchema.parse({}),
      this.agentSkills
        ? this.agentSkills.resolveRuntimeSkillCredentials({
            actorUserId: generation.actorUserId,
            agentProfile: agentProfileSnapshot,
          })
        : AgentRuntimeSkillCredentialsSchema.parse([]),
    ])

    if (context.assistantMessageId !== generation.assistantMessageId) {
      throw apiConflict(API_ERROR_CODE.CHAT_GENERATION_CONTEXT_MISMATCH)
    }

    return ChatGenerationBootstrapSchema.parse({
      generation: {
        generationId: generation.generationId,
        sessionId: generation.sessionId,
        assistantMessageId: generation.assistantMessageId,
        triggerUserMessageId: generation.triggerUserMessageId,
        actorUserId: generation.actorUserId,
        attempt: generation.attempt,
      },
      agentProfile: agentProfileSnapshot,
      model: modelTargetSnapshot,
      runtimeModelTarget,
      context,
      skills: filterRuntimeSkillContext(skills, disabledSkillKeys),
      skillCredentials: filterRuntimeSkillCredentials(skillCredentials, disabledSkillKeys),
    })
  }

  private async resolveAgentRuntimeContext(input: {
    actorId: string
    sessionId: string
    triggerUserMessageId: string
    memory: AgentMemoryRunOptions
    disabledSkillKeys: ChatDisabledSkillKeys
    runtimeHints: AgentRuntimeHints
  }): Promise<AgentChatRuntimeContext> {
    const [session, actor] = await Promise.all([
      this.findAccessibleSessionRunDetailOrThrow(input.actorId, input.sessionId),
      this.prisma.user.findUnique({
        where: { id: input.actorId },
        select: {
          preference: {
            select: {
              languagePreference: true,
            },
          },
        },
      }),
    ])
    const path = resolvePathToMessage(session.messages, input.triggerUserMessageId)
    const triggerMessage = path.at(-1) ?? null

    if (!triggerMessage || triggerMessage.role !== ChatSessionMessageRole.USER) {
      throw apiNotFound(API_ERROR_CODE.CHAT_TRIGGER_MESSAGE_NOT_FOUND)
    }

    const activePath = resolveActivePath(session.messages, session.activeRootMessageId)
    const assistantMessage = activePath.find(message =>
      message.parentMessageId === triggerMessage.id && message.role === ChatSessionMessageRole.ASSISTANT,
    )

    if (!assistantMessage) {
      throw apiConflict(API_ERROR_CODE.CHAT_TRIGGER_ASSISTANT_MISSING)
    }

    return {
      sessionId: session.id,
      threadId: buildAgentChatThreadId(session.id),
      sessionHistoryVersion: session.historyVersion,
      activePathKey: createChatActivePathKey(activePath),
      triggerUserMessageId: triggerMessage.id,
      triggerParentMessageId: triggerMessage.parentMessageId,
      assistantMessageId: assistantMessage.id,
      defaultResponseLanguage: resolveAgentDefaultResponseLanguage(
        mapLanguagePreference(actor?.preference?.languagePreference),
      ),
      messages: activePath
        .filter(message => message.role === ChatSessionMessageRole.USER || message.status === ChatSessionMessageStatus.COMPLETED)
        .map(message => this.toAgentContextMessage(message)),
      contextSnapshots: triggerMessage.contextSnapshots.map((snapshot, order) => ({
        ...toChatMessageContextSnapshotMeta(snapshot),
        order,
        content: snapshot.content,
      })),
      inputAttachments: readChatInputAttachments(triggerMessage.metadata),
      memory: input.memory,
      disabledSkillKeys: input.disabledSkillKeys,
      runtimeHints: input.runtimeHints,
    }
  }

  private toAgentContextMessage(message: PersistedChatSessionRunDetailMessage): AgentChatContextMessage {
    const skillInvocation = message.role === ChatSessionMessageRole.USER
      ? readChatSkillInvocation(message.metadata)
      : null

    return {
      id: message.id,
      role: toChatMessageRole(message.role),
      content: getChatMessageContentSnapshot(message),
      ...(skillInvocation ? { skillInvocation } : {}),
    }
  }

  async startAssistantMessageRun(input: {
    runId: string
    messageId: string
  }): Promise<void> {
    const startedAt = new Date()

    await this.prisma.$transaction([
      this.prisma.chatSessionRun.updateMany({
        where: {
          runId: input.runId,
          assistantMessageId: input.messageId,
          status: ChatSessionRunStatus.PENDING,
        },
        data: {
          status: ChatSessionRunStatus.RUNNING,
          startedAt,
        },
      }),
      this.prisma.chatMessageGeneration.updateMany({
        where: {
          generationId: input.runId,
          assistantMessageId: input.messageId,
          status: ChatMessageGenerationStatus.PENDING,
        },
        data: {
          status: ChatMessageGenerationStatus.RUNNING,
          startedAt,
        },
      }),
      this.prisma.chatSessionMessage.updateMany({
        where: {
          id: input.messageId,
          status: ChatSessionMessageStatus.PENDING,
        },
        data: {
          status: ChatSessionMessageStatus.STREAMING,
        },
      }),
    ])
  }

  async completeAssistantMessage(input: {
    sessionId: string
    messageId: string
    content: string
    expectedHistoryVersion: number
    metadata?: ChatMessageMetadata
  }): Promise<void> {
    const completedAt = new Date()
    await this.prisma.$transaction(async (tx) => {
      const sessionUpdate = await tx.chatSession.updateMany({
        where: {
          id: input.sessionId,
          historyVersion: input.expectedHistoryVersion,
        },
        data: {
          historyVersion: {
            increment: 1,
          },
          updatedAt: completedAt,
        },
      })

      if (sessionUpdate.count === 0) {
        throw new ConflictException('聊天历史已变化，请重新发送')
      }

      const messageUpdate = await tx.chatSessionMessage.updateMany({
        where: {
          id: input.messageId,
          sessionId: input.sessionId,
          role: ChatSessionMessageRole.ASSISTANT,
        },
        data: {
          status: ChatSessionMessageStatus.COMPLETED,
          content: input.content,
          metadata: input.metadata ? toJsonObject(input.metadata) : undefined,
          completedAt,
        },
      })

      if (messageUpdate.count === 0) {
        throw new ConflictException('聊天助手消息不存在或已结束')
      }

      await tx.chatSessionRun.updateMany({
        where: {
          assistantMessageId: input.messageId,
        },
        data: {
          status: ChatSessionRunStatus.COMPLETED,
          completedAt,
          dispatchLeaseExpiresAt: null,
        },
      })
      await tx.chatMessageGeneration.updateMany({
        where: {
          assistantMessageId: input.messageId,
        },
        data: {
          status: ChatMessageGenerationStatus.COMPLETED,
          completedAt,
          usageSnapshot: input.metadata?.usage ? toJsonObject(input.metadata.usage) : undefined,
          dispatchLeaseExpiresAt: null,
        },
      })
    })
  }

  async failAssistantMessage(input: {
    messageId: string
    failureReason: ChatMessageFailureReason
    failureMessage: string
  }): Promise<void> {
    const completedAt = new Date()
    await this.prisma.$transaction([
      this.prisma.chatSessionMessage.update({
        where: {
          id: input.messageId,
        },
        data: {
          status: ChatSessionMessageStatus.FAILED,
          content: '',
          metadata: toJsonObject({
            failureReason: input.failureReason,
            failureMessage: input.failureMessage,
          }),
          completedAt,
        },
      }),
      this.prisma.chatSessionRun.updateMany({
        where: {
          assistantMessageId: input.messageId,
        },
        data: {
          status: ChatSessionRunStatus.FAILED,
          completedAt,
          dispatchLeaseExpiresAt: null,
        },
      }),
      this.prisma.chatMessageGeneration.updateMany({
        where: {
          assistantMessageId: input.messageId,
        },
        data: {
          status: ChatMessageGenerationStatus.FAILED,
          completedAt,
          dispatchLeaseExpiresAt: null,
          error: toJsonObject({
            failureReason: input.failureReason,
            failureMessage: input.failureMessage,
          }),
        },
      }),
    ])
  }

  private async createRunFromUserMessage(input: CreateRunInput & {
    content: string
    contentJSON: ChatMessageContentJSON
    attachments?: ChatMessageAttachmentInput[] | null
    skillInvocation?: ChatSkillInvocation | null
  }): Promise<CreatedRunResult> {
    const session = await this.findAccessibleSessionRunDetailOrThrow(input.userId, input.sessionId, input.origin)
    this.assertChannelMutationAllowed(session, input.allowChannelMutation)
    await this.assertNoActiveRun(session.id)

    const resolvedContext = await this.chatContextSnapshots.resolveForUserMessage({
      userId: input.userId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      contentJSON: input.contentJSON,
      attachments: input.attachments,
    })
    assertChatInputModalitiesSupported({
      inputModalities: input.modelTargetSnapshot.inputModalities,
      attachments: resolvedContext.metadata.attachments,
    })
    const normalizedContent = resolvedContext.content

    const activePath = resolveActivePath(session.messages, session.activeRootMessageId)
    const activeLeaf = activePath.at(-1) ?? null

    if (activeLeaf && activeLeaf.role !== ChatSessionMessageRole.ASSISTANT) {
      throw new ConflictException('当前对话历史不是可继续发送状态')
    }

    if (activeLeaf && !continuableAssistantStatuses.has(activeLeaf.status)) {
      throw new ConflictException('当前会话正在生成，请稍后再试')
    }

    const now = new Date()
    const triggerUserMessageId = randomUUID()
    const assistantMessageId = randomUUID()
    const expectedHistoryVersion = session.historyVersion + 1
    const nextTitle = session.messages.length === 0 && session.title === CHAT_SESSION_DEFAULT_TITLE
      ? buildChatSessionTitle(normalizedContent)
      : session.title
    const rootMessageId = activePath[0]?.id ?? triggerUserMessageId
    const userParentMessageId = activeLeaf?.id ?? null
    const userBranchOrder = userParentMessageId
      ? 1
      : getNextBranchOrder(session.messages, null, ChatSessionMessageRole.USER)
    let resolvedAgentProfileId: string | null = null

    const latestSequence = await this.writeRunMutation(session.id, async (tx) => {
      const agentProfile = await this.resolveSessionAgentProfile(session, input.userId, tx)
      resolvedAgentProfileId = agentProfile.id
      const agentProfileSnapshot = createAgentProfileSnapshot(agentProfile, now)
      await this.assertSkillInvocationAvailable({
        userId: input.userId,
        skillInvocation: input.skillInvocation,
        agentProfileSnapshot,
      })

      await this.createUserMessage(tx, {
        id: triggerUserMessageId,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        actorId: input.userId,
        content: normalizedContent,
        metadata: {
          ...resolvedContext.metadata,
          skillInvocation: input.skillInvocation ?? null,
          disabledSkillKeys: input.disabledSkillKeys ?? [],
        },
        contextSnapshots: resolvedContext.snapshots,
        parentMessageId: userParentMessageId,
        branchOrder: userBranchOrder,
        sourceMessageId: null,
        completedAt: now,
      })
      await this.createAssistantPendingMessage(tx, {
        id: assistantMessageId,
        sessionId: session.id,
        parentMessageId: triggerUserMessageId,
        branchOrder: 1,
        sourceMessageId: null,
        runId: input.runId,
      })

      if (userParentMessageId) {
        await tx.chatSessionMessage.update({
          where: { id: userParentMessageId },
          data: { selectedChildMessageId: triggerUserMessageId },
        })
      }

      await tx.chatSessionMessage.update({
        where: { id: triggerUserMessageId },
        data: { selectedChildMessageId: assistantMessageId },
      })
      await this.createPendingRun(tx, {
        sessionId: session.id,
        runId: input.runId,
        assistantMessageId,
        triggerUserMessageId,
        actorUserId: input.userId,
        modelTargetSnapshot: input.modelTargetSnapshot,
        expectedHistoryVersion,
        memory: input.memory,
        disabledSkillKeys: input.disabledSkillKeys,
        runtimeHints: input.runtimeHints,
      })
      await this.createPendingGeneration(tx, {
        sessionId: session.id,
        generationId: input.generationId,
        assistantMessageId,
        triggerUserMessageId,
        actorUserId: input.userId,
        agentProfileId: agentProfile.id,
        agentProfileSnapshot,
        modelTargetSnapshot: input.modelTargetSnapshot,
      })
      await tx.chatSession.update({
        where: { id: session.id },
        data: {
          historyVersion: { increment: 1 },
          title: nextTitle,
          activeRootMessageId: rootMessageId,
          activeLeafMessageId: assistantMessageId,
          updatedAt: now,
        },
      })

      return this.chatSessionEvents.appendEvents(tx, session.id, [
        ...createTitleEvents(session.title, nextTitle),
        createMessageCreatedEvent(triggerUserMessageId, ChatSessionMessageRole.USER, ChatSessionMessageStatus.COMPLETED),
        createMessageCreatedEvent(assistantMessageId, ChatSessionMessageRole.ASSISTANT, ChatSessionMessageStatus.PENDING, input.runId),
        createBranchSwitchedEvent(rootMessageId, assistantMessageId),
      ])
    })

    return {
      sessionId: session.id,
      runId: input.runId,
      generationId: input.generationId,
      assistantMessageId,
      triggerUserMessageId,
      agentProfileId: assertResolvedAgentProfileId(resolvedAgentProfileId),
      expectedHistoryVersion,
      latestSequence,
    }
  }

  private async createRunFromEditedUserMessage(input: CreateRunInput & {
    messageId: string
    content: string
    contentJSON: ChatMessageContentJSON
    attachments?: ChatMessageAttachmentInput[] | null
    skillInvocation?: ChatSkillInvocation | null
  }): Promise<CreatedRunResult> {
    const session = await this.findAccessibleSessionRunDetailOrThrow(input.userId, input.sessionId, input.origin)
    this.assertChannelMutationAllowed(session, input.allowChannelMutation)
    await this.assertNoActiveRun(session.id)

    const sourceMessage = session.messages.find(message => message.id === input.messageId)
    if (!sourceMessage || sourceMessage.role !== ChatSessionMessageRole.USER) {
      throw new NotFoundException('可编辑的用户消息不存在')
    }

    const resolvedContext = await this.chatContextSnapshots.resolveForUserMessage({
      userId: input.userId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      reusableAssetMessageIds: [sourceMessage.id],
      contentJSON: input.contentJSON,
      attachments: input.attachments,
    })
    assertChatInputModalitiesSupported({
      inputModalities: input.modelTargetSnapshot.inputModalities,
      attachments: resolvedContext.metadata.attachments,
    })
    const normalizedContent = resolvedContext.content

    const now = new Date()
    const triggerUserMessageId = randomUUID()
    const assistantMessageId = randomUUID()
    const expectedHistoryVersion = session.historyVersion + 1
    const rootMessageId = sourceMessage.parentMessageId
      ? resolvePathToMessage(session.messages, sourceMessage.parentMessageId)[0]?.id ?? triggerUserMessageId
      : triggerUserMessageId
    const userBranchOrder = getNextBranchOrder(
      session.messages,
      sourceMessage.parentMessageId,
      ChatSessionMessageRole.USER,
    )
    let resolvedAgentProfileId: string | null = null

    const latestSequence = await this.writeRunMutation(session.id, async (tx) => {
      const agentProfile = await this.resolveSessionAgentProfile(session, input.userId, tx)
      resolvedAgentProfileId = agentProfile.id
      const agentProfileSnapshot = createAgentProfileSnapshot(agentProfile, now)
      await this.assertSkillInvocationAvailable({
        userId: input.userId,
        skillInvocation: input.skillInvocation,
        agentProfileSnapshot,
      })

      await this.createUserMessage(tx, {
        id: triggerUserMessageId,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        actorId: input.userId,
        content: normalizedContent,
        metadata: {
          ...resolvedContext.metadata,
          skillInvocation: input.skillInvocation ?? null,
          disabledSkillKeys: input.disabledSkillKeys ?? [],
        },
        contextSnapshots: resolvedContext.snapshots,
        parentMessageId: sourceMessage.parentMessageId,
        branchOrder: userBranchOrder,
        sourceMessageId: sourceMessage.id,
        reusableAssetMessageIds: [sourceMessage.id],
        completedAt: now,
      })
      await this.createAssistantPendingMessage(tx, {
        id: assistantMessageId,
        sessionId: session.id,
        parentMessageId: triggerUserMessageId,
        branchOrder: 1,
        sourceMessageId: null,
        runId: input.runId,
      })

      if (sourceMessage.parentMessageId) {
        await tx.chatSessionMessage.update({
          where: { id: sourceMessage.parentMessageId },
          data: { selectedChildMessageId: triggerUserMessageId },
        })
      }

      await tx.chatSessionMessage.update({
        where: { id: triggerUserMessageId },
        data: { selectedChildMessageId: assistantMessageId },
      })
      await this.createPendingRun(tx, {
        sessionId: session.id,
        runId: input.runId,
        assistantMessageId,
        triggerUserMessageId,
        actorUserId: input.userId,
        modelTargetSnapshot: input.modelTargetSnapshot,
        expectedHistoryVersion,
        memory: input.memory,
        disabledSkillKeys: input.disabledSkillKeys,
        runtimeHints: input.runtimeHints,
      })
      await this.createPendingGeneration(tx, {
        sessionId: session.id,
        generationId: input.generationId,
        assistantMessageId,
        triggerUserMessageId,
        actorUserId: input.userId,
        agentProfileId: agentProfile.id,
        agentProfileSnapshot,
        modelTargetSnapshot: input.modelTargetSnapshot,
      })
      await tx.chatSession.update({
        where: { id: session.id },
        data: {
          historyVersion: { increment: 1 },
          activeRootMessageId: rootMessageId,
          activeLeafMessageId: assistantMessageId,
          updatedAt: now,
        },
      })

      return this.chatSessionEvents.appendEvents(tx, session.id, [
        createMessageCreatedEvent(triggerUserMessageId, ChatSessionMessageRole.USER, ChatSessionMessageStatus.COMPLETED),
        createMessageCreatedEvent(assistantMessageId, ChatSessionMessageRole.ASSISTANT, ChatSessionMessageStatus.PENDING, input.runId),
        createBranchSwitchedEvent(rootMessageId, assistantMessageId),
      ])
    })

    return {
      sessionId: session.id,
      runId: input.runId,
      generationId: input.generationId,
      assistantMessageId,
      triggerUserMessageId,
      agentProfileId: assertResolvedAgentProfileId(resolvedAgentProfileId),
      expectedHistoryVersion,
      latestSequence,
    }
  }

  private async createRunFromRetriedAssistantMessage(input: CreateRunInput & {
    messageId: string
  }): Promise<CreatedRunResult> {
    const session = await this.findAccessibleSessionRunDetailOrThrow(input.userId, input.sessionId, input.origin)
    this.assertChannelMutationAllowed(session, input.allowChannelMutation)
    await this.assertNoActiveRun(session.id)

    const sourceMessage = session.messages.find(message => message.id === input.messageId)
    if (!sourceMessage || sourceMessage.role !== ChatSessionMessageRole.ASSISTANT) {
      throw new NotFoundException('可重试的助手消息不存在')
    }
    if (!sourceMessage.parentMessageId) {
      throw new ConflictException('助手消息缺少用户父消息')
    }

    const triggerMessage = session.messages.find(message => message.id === sourceMessage.parentMessageId)
    if (!triggerMessage || triggerMessage.role !== ChatSessionMessageRole.USER) {
      throw new ConflictException('助手消息父节点不是用户消息')
    }
    assertChatInputModalitiesSupported({
      inputModalities: input.modelTargetSnapshot.inputModalities,
      attachments: readChatInputAttachments(triggerMessage.metadata),
    })
    const disabledSkillKeys = readChatDisabledSkillKeys(triggerMessage.metadata)

    const assistantMessageId = randomUUID()
    const now = new Date()
    const expectedHistoryVersion = session.historyVersion + 1
    const rootMessageId = resolvePathToMessage(session.messages, triggerMessage.id)[0]?.id ?? triggerMessage.id
    const assistantBranchOrder = getNextBranchOrder(
      session.messages,
      triggerMessage.id,
      ChatSessionMessageRole.ASSISTANT,
    )
    let resolvedAgentProfileId: string | null = null

    const latestSequence = await this.writeRunMutation(session.id, async (tx) => {
      const agentProfile = await this.resolveSessionAgentProfile(session, input.userId, tx)
      resolvedAgentProfileId = agentProfile.id
      const agentProfileSnapshot = createAgentProfileSnapshot(agentProfile, now)
      await this.assertSkillInvocationAvailable({
        userId: input.userId,
        skillInvocation: readChatSkillInvocation(triggerMessage.metadata),
        agentProfileSnapshot,
      })

      await this.createAssistantPendingMessage(tx, {
        id: assistantMessageId,
        sessionId: session.id,
        parentMessageId: triggerMessage.id,
        branchOrder: assistantBranchOrder,
        sourceMessageId: sourceMessage.id,
        runId: input.runId,
      })
      await tx.chatSessionMessage.update({
        where: { id: triggerMessage.id },
        data: { selectedChildMessageId: assistantMessageId },
      })
      await this.createPendingRun(tx, {
        sessionId: session.id,
        runId: input.runId,
        assistantMessageId,
        triggerUserMessageId: triggerMessage.id,
        actorUserId: input.userId,
        modelTargetSnapshot: input.modelTargetSnapshot,
        expectedHistoryVersion,
        disabledSkillKeys,
        runtimeHints: input.runtimeHints,
      })
      await this.createPendingGeneration(tx, {
        sessionId: session.id,
        generationId: input.generationId,
        assistantMessageId,
        triggerUserMessageId: triggerMessage.id,
        actorUserId: input.userId,
        agentProfileId: agentProfile.id,
        agentProfileSnapshot,
        modelTargetSnapshot: input.modelTargetSnapshot,
      })
      await tx.chatSession.update({
        where: { id: session.id },
        data: {
          historyVersion: { increment: 1 },
          activeRootMessageId: rootMessageId,
          activeLeafMessageId: assistantMessageId,
          updatedAt: now,
        },
      })

      return this.chatSessionEvents.appendEvents(tx, session.id, [
        createMessageCreatedEvent(assistantMessageId, ChatSessionMessageRole.ASSISTANT, ChatSessionMessageStatus.PENDING, input.runId),
        createBranchSwitchedEvent(rootMessageId, assistantMessageId),
      ])
    })

    return {
      sessionId: session.id,
      runId: input.runId,
      generationId: input.generationId,
      assistantMessageId,
      triggerUserMessageId: triggerMessage.id,
      agentProfileId: assertResolvedAgentProfileId(resolvedAgentProfileId),
      expectedHistoryVersion,
      latestSequence,
    }
  }

  private async writeRunMutation(
    sessionId: string,
    write: (tx: Prisma.TransactionClient) => Promise<number>,
  ): Promise<number> {
    try {
      return await this.prisma.$transaction(write)
    }
    catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException('当前会话正在生成，请稍后再试')
      }

      throw error
    }
  }

  private async assertNoActiveRun(sessionId: string): Promise<void> {
    const activeRun = await this.prisma.chatSessionRun.findFirst({
      where: {
        sessionId,
        status: {
          in: activeRunStatuses,
        },
      },
      select: {
        id: true,
      },
    })

    if (activeRun) {
      throw new ConflictException('当前会话正在生成，请稍后再试')
    }
  }

  private assertChannelMutationAllowed(
    session: Pick<PersistedChatSessionRunDetail, 'channel'>,
    allowChannelMutation: boolean | undefined,
  ): void {
    if (allowChannelMutation || !session.channel || session.channel === PrismaChatSessionChannel.DIRECT) {
      return
    }

    throw new ConflictException('Bot 对话只读展示')
  }

  private async assertSkillInvocationAvailable(input: {
    userId: string
    skillInvocation?: ChatSkillInvocation | null
    agentProfileSnapshot: AgentProfileSnapshot
  }): Promise<void> {
    if (!input.skillInvocation) {
      return
    }

    if (!this.agentSkills) {
      throw new BadRequestException('技能不可用')
    }

    const skillContext = await this.agentSkills.resolveRuntimeSkillContext({
      actorUserId: input.userId,
      agentProfile: input.agentProfileSnapshot,
    })

    if (!hasAvailableSkill(skillContext, input.skillInvocation.skillKey)) {
      throw new BadRequestException('技能未安装或未开启')
    }
  }

  private async createUserMessage(
    tx: Prisma.TransactionClient,
    input: {
      id: string
      sessionId: string
      workspaceId: string
      actorId: string
      content: string
      metadata: {
        contentJSON: ChatMessageContentJSON
        attachments: ChatPersistedMessageAttachment[]
        skillInvocation?: ChatSkillInvocation | null
        disabledSkillKeys?: ChatDisabledSkillKeys
      }
      contextSnapshots: ChatContextSnapshotCreateData[]
      parentMessageId: string | null
      branchOrder: number
      sourceMessageId: string | null
      reusableAssetMessageIds?: string[]
      completedAt: Date
    },
  ): Promise<void> {
    await tx.chatSessionMessage.create({
      data: {
        id: input.id,
        sessionId: input.sessionId,
        role: ChatSessionMessageRole.USER,
        status: ChatSessionMessageStatus.COMPLETED,
        content: input.content,
        metadata: toJsonObject(input.metadata),
        parentMessageId: input.parentMessageId,
        branchOrder: input.branchOrder,
        sourceMessageId: input.sourceMessageId,
        completedAt: input.completedAt,
        contextSnapshots: input.contextSnapshots.length > 0
          ? {
              create: input.contextSnapshots.map(snapshot => ({
                type: snapshot.type,
                documentId: snapshot.documentId,
                title: snapshot.title,
                scope: toJsonValue(snapshot.scope),
                size: snapshot.size,
                sourceAttachmentIds: toJsonValue(snapshot.sourceAttachmentIds),
                content: snapshot.content,
                capturedAt: snapshot.capturedAt,
              })),
            }
          : undefined,
        parts: {
          create: {
            type: ChatSessionMessagePartType.TEXT,
            text: input.content,
            order: 0,
          },
        },
      },
    })

    await this.chatAssets.bindAssetsToMessage(tx, {
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      messageId: input.id,
      reusableMessageIds: input.reusableAssetMessageIds,
      attachments: input.metadata.attachments,
    })
  }

  private async createAssistantPendingMessage(
    tx: Prisma.TransactionClient,
    input: {
      id: string
      sessionId: string
      parentMessageId: string
      branchOrder: number
      sourceMessageId: string | null
      runId: string
    },
  ): Promise<void> {
    await tx.chatSessionMessage.create({
      data: {
        id: input.id,
        sessionId: input.sessionId,
        role: ChatSessionMessageRole.ASSISTANT,
        status: ChatSessionMessageStatus.PENDING,
        content: '',
        parentMessageId: input.parentMessageId,
        branchOrder: input.branchOrder,
        sourceMessageId: input.sourceMessageId,
        agentRunId: input.runId,
      },
    })
  }

  private async createPendingRun(
    tx: Prisma.TransactionClient,
    input: {
      sessionId: string
      runId: string
      assistantMessageId: string
      triggerUserMessageId: string
      actorUserId: string
      modelTargetSnapshot: ChatGenerationModelTargetSnapshot
      expectedHistoryVersion: number
      memory?: AgentMemoryRunOptions
      disabledSkillKeys?: ChatDisabledSkillKeys
      runtimeHints?: AgentRuntimeHints
    },
  ): Promise<void> {
    await tx.chatSessionRun.create({
      data: {
        runId: input.runId,
        sessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        triggerUserMessageId: input.triggerUserMessageId,
        actorUserId: input.actorUserId,
        modelTargetSnapshot: toJsonValue(input.modelTargetSnapshot),
        commandContext: toJsonObject({
          expectedHistoryVersion: input.expectedHistoryVersion,
          memory: input.memory,
          disabledSkillKeys: input.disabledSkillKeys,
          runtimeHints: input.runtimeHints,
        }),
        status: ChatSessionRunStatus.PENDING,
      },
    })
  }

  private async createPendingGeneration(
    tx: Prisma.TransactionClient,
    input: {
      sessionId: string
      generationId: string
      assistantMessageId: string
      triggerUserMessageId: string
      actorUserId: string
      agentProfileId: string
      agentProfileSnapshot: AgentProfileSnapshot
      modelTargetSnapshot: ChatGenerationModelTargetSnapshot
    },
  ): Promise<void> {
    await tx.chatMessageGeneration.create({
      data: {
        generationId: input.generationId,
        sessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        triggerUserMessageId: input.triggerUserMessageId,
        actorUserId: input.actorUserId,
        agentProfileId: input.agentProfileId,
        agentProfileSnapshot: toJsonValue(input.agentProfileSnapshot),
        modelTargetSnapshot: toJsonValue(input.modelTargetSnapshot),
        status: ChatMessageGenerationStatus.PENDING,
        idempotencyKey: `chat:generation:${input.generationId}`,
      },
    })
  }

  private async toMutationResponse(
    userId: string,
    origin: ChatSessionOrigin,
    sessionId: string,
    latestSequence: number,
    runId?: string,
  ): Promise<ChatMutationResponse> {
    const [session, run] = await Promise.all([
      this.getSession(userId, sessionId, origin),
      runId ? this.getRunSummary(runId) : Promise.resolve(undefined),
    ])

    return ChatMutationResponseSchema.parse({
      session,
      latestSequence,
      run,
    })
  }

  private async getRunSummary(runId: string): Promise<ChatRunSummary> {
    const run = await this.prisma.chatSessionRun.findUnique({
      where: { runId },
      select: {
        runId: true,
        status: true,
        assistantMessageId: true,
        triggerUserMessageId: true,
        commandContext: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    })

    if (!run) {
      throw new NotFoundException('聊天运行不存在')
    }

    return toChatRunSummary(run)
  }

  private async getActiveRunSummary(sessionId: string): Promise<ChatRunSummary | null> {
    const run = await this.prisma.chatSessionRun.findFirst({
      where: {
        sessionId,
        status: {
          in: activeRunStatuses,
        },
      },
      select: {
        runId: true,
        status: true,
        assistantMessageId: true,
        triggerUserMessageId: true,
        commandContext: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    return run ? toChatRunSummary(run) : null
  }

  private async repairActivePathSelection(session: PersistedChatSessionDetail): Promise<void> {
    const state = resolveActivePathState(session.messages, session.activeRootMessageId)
    const shouldRepairSession
      = session.activeRootMessageId !== state.activeRootMessageId
        || session.activeLeafMessageId !== state.activeLeafMessageId

    if (!shouldRepairSession && state.selectedChildUpdates.length === 0) {
      return
    }

    await this.prisma.$transaction(async (tx) => {
      if (shouldRepairSession) {
        await tx.chatSession.update({
          where: { id: session.id },
          data: {
            activeRootMessageId: state.activeRootMessageId,
            activeLeafMessageId: state.activeLeafMessageId,
          },
        })
      }

      for (const update of state.selectedChildUpdates) {
        await tx.chatSessionMessage.update({
          where: { id: update.messageId },
          data: {
            selectedChildMessageId: update.selectedChildMessageId,
          },
        })
      }
    })
  }

  private async assertWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      },
      select: {
        userId: true,
      },
    })

    if (!membership) {
      throw new NotFoundException('聊天空间不存在')
    }
  }

  private createWorkspaceAccessWhere(userId: string): Prisma.WorkspaceWhereInput {
    return {
      members: {
        some: {
          userId,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        },
      },
    }
  }

  private createAccessibleSessionWhere(
    userId: string,
    sessionId: string,
    origin?: ChatSessionOrigin,
  ): Prisma.ChatSessionWhereInput {
    return {
      id: sessionId,
      ...(origin ? { origin: toPrismaChatSessionOrigin(origin) } : {}),
      workspace: this.createWorkspaceAccessWhere(userId),
    }
  }

  private async findAccessibleSessionDetailOrThrow(
    userId: string,
    sessionId: string,
    origin?: ChatSessionOrigin,
  ): Promise<PersistedChatSessionDetail> {
    const session = await this.prisma.chatSession.findFirst({
      where: this.createAccessibleSessionWhere(userId, sessionId, origin),
      select: chatSessionDetailSelect,
    })

    if (!session) {
      throw new NotFoundException('聊天会话不存在')
    }

    return session
  }

  private async findAccessibleSessionRunDetailOrThrow(
    userId: string,
    sessionId: string,
    origin?: ChatSessionOrigin,
  ): Promise<PersistedChatSessionRunDetail> {
    const session = await this.prisma.chatSession.findFirst({
      where: this.createAccessibleSessionWhere(userId, sessionId, origin),
      select: chatSessionRunDetailSelect,
    })

    if (!session) {
      throw new NotFoundException('聊天会话不存在')
    }

    return session
  }

  private async findAccessibleSessionModelRefOrThrow(
    userId: string,
    sessionId: string,
    origin: ChatSessionOrigin,
  ): Promise<PersistedChatSessionModelRef> {
    const session = await this.prisma.chatSession.findFirst({
      where: this.createAccessibleSessionWhere(userId, sessionId, origin),
      select: chatSessionModelRefSelect,
    })

    if (!session) {
      throw new NotFoundException('聊天会话不存在')
    }

    return session
  }

  private async resolveSessionAgentProfile(
    session: Pick<PersistedChatSessionModelRef, 'id' | 'agentProfileId' | 'agentProfile'>,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AgentProfileForGeneration> {
    if (session.agentProfile) {
      return this.personalizeAgentProfileForGeneration(userId, session.agentProfile, tx)
    }

    const agentProfile = await this.agentProfiles.ensureDefaultAgentProfile({
      ownerUserId: userId,
      tx,
    })
    const client = tx ?? this.prisma

    await client.chatSession.updateMany({
      where: {
        id: session.id,
        agentProfileId: session.agentProfileId,
      },
      data: {
        agentProfileId: agentProfile.id,
      },
    })

    return this.personalizeAgentProfileForGeneration(userId, agentProfile, tx)
  }

  private async personalizeSessionAgentProfile<T extends { agentProfile: { id: string, name: string } | null }>(
    userId: string,
    session: T,
  ): Promise<T> {
    return (await this.personalizeSessionAgentProfiles(userId, [session]))[0] ?? session
  }

  private async personalizeSessionAgentProfiles<T extends { agentProfile: { id: string, name: string } | null }>(
    userId: string,
    sessions: T[],
  ): Promise<T[]> {
    const profileIds = sessions
      .map(session => session.agentProfile?.id)
      .filter((id): id is string => Boolean(id))
    const personalizedNameByProfileId = await this.agentProfiles.resolvePersonalizedAgentProfileNames(userId, profileIds)

    if (personalizedNameByProfileId.size === 0) {
      return sessions
    }

    return sessions.map((session) => {
      const agentProfile = session.agentProfile
      if (!agentProfile) {
        return session
      }

      const personalizedName = personalizedNameByProfileId.get(agentProfile.id)
      if (!personalizedName) {
        return session
      }

      return {
        ...session,
        agentProfile: {
          ...agentProfile,
          name: personalizedName,
        },
      } as T
    })
  }

  private async personalizeAgentProfileForGeneration(
    userId: string,
    profile: AgentProfileForGeneration,
    tx?: Prisma.TransactionClient,
  ): Promise<AgentProfileForGeneration> {
    const personalizedName = (await this.agentProfiles.resolvePersonalizedAgentProfileNames(userId, [profile.id], tx)).get(profile.id)
    return personalizedName
      ? { ...profile, name: personalizedName }
      : profile
  }

  private async resolveRuntimeModelTarget(
    actorUserId: string,
    snapshot: ChatGenerationModelTargetSnapshot,
  ): Promise<AgentRuntimeModelTarget> {
    const target = await this.modelResolverService.resolveModelTarget({
      actorUserId,
      intentKey: AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT,
      requestedModelRef: {
        providerId: snapshot.providerId,
        modelId: snapshot.modelId,
      },
    })

    return AgentRuntimeModelTargetSchema.parse({
      providerId: snapshot.providerId,
      scope: snapshot.scope,
      providerKey: snapshot.providerKey,
      adapterKey: snapshot.adapterKey,
      endpoint: snapshot.endpoint,
      apiKey: target.apiKey,
      authMode: snapshot.authMode,
      modelId: snapshot.modelId,
      capabilities: snapshot.capabilities,
    })
  }
}

function resolveAgentDefaultResponseLanguage(
  languagePreference: ReturnType<typeof mapLanguagePreference>,
): ResolvedLanguagePreference {
  return languagePreference === LANGUAGE_PREFERENCE.AUTO
    ? LANGUAGE_PREFERENCE.ZH_CN
    : resolveLanguagePreference(languagePreference, [])
}

function toChatSessionDetailRecord(
  session: PersistedChatSessionDetail,
  activeRun: ChatRunSummary | null = null,
): ChatSessionDetailRecord {
  const activePath = resolveActivePathState(session.messages, session.activeRootMessageId).path

  return {
    id: session.id,
    workspaceId: session.workspaceId,
    origin: session.origin,
    channel: session.channel,
    title: session.title,
    selectedProviderId: session.selectedProviderId,
    selectedModelId: session.selectedModelId,
    agentProfile: session.agentProfile,
    modelOverrideProviderId: session.modelOverrideProviderId,
    modelOverrideModelId: session.modelOverrideModelId,
    latestSequence: Math.max(0, session.nextEventSequence - 1),
    activeRun,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: activePath.map(message => toChatSessionMessageRecord(message, session.messages)),
    allMessages: session.messages.map(message => toChatSessionMessageRecord(message, session.messages)),
  }
}

function createAgentProfileSnapshot(profile: AgentProfileForGeneration, capturedAt: Date): AgentProfileSnapshot {
  return AgentProfileSnapshotSchema.parse({
    profileId: profile.id,
    ownerUserId: profile.ownerUserId,
    name: profile.name,
    currentConfig: profile.currentConfig,
    capturedAt: capturedAt.toISOString(),
  })
}

function assertResolvedAgentProfileId(agentProfileId: string | null): string {
  if (!agentProfileId) {
    throw new ConflictException('聊天 AgentProfile 未解析')
  }

  return agentProfileId
}

function toChatSessionMessageRecord(
  message: PersistedChatSessionDetailMessage,
  messages: PersistedChatSessionDetailMessage[],
): ChatSessionMessageRecord {
  return {
    id: message.id,
    role: message.role,
    status: message.status,
    content: message.content,
    branch: getMessageBranch(message, messages),
    parts: message.parts,
    contextSnapshots: message.contextSnapshots,
    metadata: message.metadata,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    completedAt: message.completedAt,
  }
}

function resolveActivePath(
  messages: PersistedChatSessionRunDetailMessage[],
  activeRootMessageId: string | null,
): PersistedChatSessionRunDetailMessage[]
function resolveActivePath(
  messages: PersistedChatSessionDetailMessage[],
  activeRootMessageId: string | null,
): PersistedChatSessionDetailMessage[]
function resolveActivePath<T extends PersistedChatSessionMessage>(
  messages: T[],
  activeRootMessageId: string | null,
): T[] {
  return resolveActivePathState(messages, activeRootMessageId).path
}

function resolveActivePathState<T extends PersistedChatSessionMessage>(
  messages: T[],
  activeRootMessageId: string | null,
): ActivePathState<T> {
  const rootMessages = sortBranchMessages(messages.filter(message =>
    message.parentMessageId === null && message.role === ChatSessionMessageRole.USER,
  ))
  const rootMessage = activeRootMessageId
    ? rootMessages.find(message => message.id === activeRootMessageId) ?? rootMessages.at(-1) ?? null
    : rootMessages.at(-1) ?? null

  if (!rootMessage) {
    return {
      path: [],
      activeRootMessageId: null,
      activeLeafMessageId: null,
      selectedChildUpdates: [],
    }
  }

  const path: T[] = []
  const selectedChildUpdates: ActivePathState<T>['selectedChildUpdates'] = []
  const visited = new Set<string>()
  let currentMessage: T | null = rootMessage

  while (currentMessage && !visited.has(currentMessage.id)) {
    path.push(currentMessage)
    visited.add(currentMessage.id)

    const nextRole = currentMessage.role === ChatSessionMessageRole.USER
      ? ChatSessionMessageRole.ASSISTANT
      : ChatSessionMessageRole.USER
    const children = sortBranchMessages(messages.filter(message =>
      message.parentMessageId === currentMessage?.id && message.role === nextRole,
    ))

    if (children.length === 0) {
      if (currentMessage.selectedChildMessageId !== null) {
        selectedChildUpdates.push({
          messageId: currentMessage.id,
          selectedChildMessageId: null,
        })
      }
      break
    }

    const selectedChild = currentMessage.selectedChildMessageId
      ? children.find(message => message.id === currentMessage?.selectedChildMessageId) ?? null
      : null

    const nextMessage = selectedChild ?? children.at(-1) ?? null
    if (nextMessage && currentMessage.selectedChildMessageId !== nextMessage.id) {
      selectedChildUpdates.push({
        messageId: currentMessage.id,
        selectedChildMessageId: nextMessage.id,
      })
    }
    currentMessage = nextMessage
  }

  return {
    path,
    activeRootMessageId: rootMessage.id,
    activeLeafMessageId: path.at(-1)?.id ?? rootMessage.id,
    selectedChildUpdates,
  }
}

function resolvePathToMessage(
  messages: PersistedChatSessionRunDetailMessage[],
  messageId: string,
): PersistedChatSessionRunDetailMessage[]
function resolvePathToMessage(
  messages: PersistedChatSessionDetailMessage[],
  messageId: string,
): PersistedChatSessionDetailMessage[]
function resolvePathToMessage<T extends PersistedChatSessionMessage>(
  messages: T[],
  messageId: string,
): T[] {
  const messageById = new Map(messages.map(message => [message.id, message]))
  const path: T[] = []
  const visited = new Set<string>()
  let currentMessage = messageById.get(messageId) ?? null

  while (currentMessage && !visited.has(currentMessage.id)) {
    path.push(currentMessage)
    visited.add(currentMessage.id)
    currentMessage = currentMessage.parentMessageId
      ? messageById.get(currentMessage.parentMessageId) ?? null
      : null
  }

  return path.reverse()
}

function createChatActivePathKey(messages: Array<Pick<PersistedChatSessionMessage, 'id'>>): string {
  return messages.map(message => message.id).join('>')
}

function resolveActivePathWithOverride(
  messages: PersistedChatSessionRunDetailMessage[],
  activeRootMessageId: string | null,
  targetMessage: PersistedChatSessionRunDetailMessage,
): PersistedChatSessionRunDetailMessage[] {
  const nextMessages: PersistedChatSessionRunDetailMessage[] = messages.map((message) => {
    if (targetMessage.parentMessageId && message.id === targetMessage.parentMessageId) {
      return {
        ...message,
        selectedChildMessageId: targetMessage.id,
      }
    }

    return message
  })

  return resolveActivePath(nextMessages, targetMessage.parentMessageId ? activeRootMessageId : targetMessage.id)
}

function getMessageBranch(
  message: PersistedChatSessionDetailMessage,
  messages: PersistedChatSessionDetailMessage[],
): ChatSessionMessageRecord['branch'] {
  const siblings = sortBranchMessages(messages.filter(item =>
    item.parentMessageId === message.parentMessageId && item.role === message.role,
  ))
  const index = siblings.findIndex(item => item.id === message.id)

  return {
    index: index >= 0 ? index + 1 : 1,
    count: siblings.length || 1,
    previousMessageId: index > 0 ? siblings[index - 1]?.id ?? null : null,
    nextMessageId: index >= 0 && index < siblings.length - 1 ? siblings[index + 1]?.id ?? null : null,
  }
}

function getNextBranchOrder(
  messages: PersistedChatSessionMessage[],
  parentMessageId: string | null,
  role: ChatSessionMessageRole,
): number {
  return messages
    .filter(message => message.parentMessageId === parentMessageId && message.role === role)
    .reduce((maxOrder, message) => Math.max(maxOrder, message.branchOrder), 0) + 1
}

function sortBranchMessages<T extends Pick<PersistedChatSessionMessage, 'branchOrder' | 'createdAt' | 'id'>>(messages: T[]): T[] {
  return [...messages].sort((left, right) =>
    left.branchOrder - right.branchOrder
    || left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id),
  )
}

function buildChatSessionTitle(content: string) {
  return content.slice(0, 30) + (content.length > 30 ? '...' : '')
}

function createTitleEvents(previousTitle: string, nextTitle: string) {
  if (previousTitle === nextTitle) {
    return []
  }

  return [
    {
      type: CHAT_SESSION_EVENT_TYPE.TITLE_UPDATED,
      payload: {
        title: nextTitle,
      },
    },
  ]
}

function createMessageCreatedEvent(
  messageId: string,
  role: ChatSessionMessageRole,
  status: ChatSessionMessageStatus,
  runId?: string,
) {
  return {
    type: CHAT_SESSION_EVENT_TYPE.MESSAGE_CREATED,
    messageId,
    runId: runId ?? null,
    payload: {
      role: toChatMessageRole(role),
      status: toChatMessageStatus(status),
    },
  }
}

function createBranchSwitchedEvent(activeRootMessageId: string | null, activeLeafMessageId: string | null) {
  return {
    type: CHAT_SESSION_EVENT_TYPE.BRANCH_SWITCHED,
    payload: {
      activeRootMessageId,
      activeLeafMessageId,
    },
  }
}

function assertAlternatingChild(
  parentMessage: PersistedChatSessionMessage,
  childMessage: PersistedChatSessionMessage,
): void {
  const expectedRole = parentMessage.role === ChatSessionMessageRole.USER
    ? ChatSessionMessageRole.ASSISTANT
    : ChatSessionMessageRole.USER

  if (childMessage.role !== expectedRole) {
    throw new ConflictException('聊天分支角色不符合交替规则')
  }
}

function toChatRunStatus(status: ChatSessionRunStatus): ChatRunSummary['status'] {
  if (status === ChatSessionRunStatus.PENDING) {
    return CHAT_RUN_STATUS.PENDING
  }
  if (status === ChatSessionRunStatus.RUNNING) {
    return CHAT_RUN_STATUS.RUNNING
  }
  if (status === ChatSessionRunStatus.REQUIRES_ACTION) {
    return CHAT_RUN_STATUS.REQUIRES_ACTION
  }
  if (status === ChatSessionRunStatus.FAILED) {
    return CHAT_RUN_STATUS.FAILED
  }
  if (status === ChatSessionRunStatus.CANCELLED) {
    return CHAT_RUN_STATUS.CANCELLED
  }

  return CHAT_RUN_STATUS.COMPLETED
}

function toChatRunSummary(run: {
  runId: string
  status: ChatSessionRunStatus
  assistantMessageId: string
  triggerUserMessageId: string
  commandContext: unknown
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
}): ChatRunSummary {
  return {
    runId: run.runId,
    status: toChatRunStatus(run.status),
    assistantMessageId: run.assistantMessageId,
    triggerUserMessageId: run.triggerUserMessageId,
    requiredAction: run.status === ChatSessionRunStatus.REQUIRES_ACTION
      ? readPendingClientAction(run.commandContext)
      : null,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function readChatSkillInvocation(metadata: unknown): ChatSkillInvocation | null {
  if (!isRecord(metadata)) {
    return null
  }

  const result = ChatSkillInvocationSchema.safeParse(metadata.skillInvocation)
  return result.success ? result.data : null
}

function readChatDisabledSkillKeys(metadata: unknown): ChatDisabledSkillKeys {
  if (!isRecord(metadata)) {
    return ChatDisabledSkillKeysSchema.parse(undefined)
  }

  return ChatDisabledSkillKeysSchema.parse(metadata.disabledSkillKeys)
}

function readChatInputAttachments(metadata: unknown) {
  if (!isRecord(metadata)) {
    return []
  }

  const result = ChatPersistedMessageAttachmentSchema.array().safeParse(metadata.attachments)
  if (!result.success) {
    return []
  }

  return result.data.filter(isChatUploadedMessageAttachment)
}

function assertChatInputModalitiesSupported(input: {
  inputModalities: readonly ChatGenerationModelTargetSnapshot['inputModalities'][number][]
  attachments: readonly ChatPersistedMessageAttachment[]
}): void {
  const missingModalities = resolveMissingChatAttachmentInputModalities({
    attachments: input.attachments,
    inputModalities: input.inputModalities,
  })

  if (missingModalities.length === 0) {
    return
  }

  throw apiBadRequest(
    API_ERROR_CODE.CHAT_MODEL_INPUT_MODALITY_UNSUPPORTED,
    'Chat model input modality unsupported',
  )
}

function hasAvailableSkill(skillContext: AgentRuntimeSkillContext, skillKey: string): boolean {
  return skillContext.availableSkills.some(skill => skill.key === skillKey)
}

function filterRuntimeSkillContext(
  skillContext: AgentRuntimeSkillContext,
  disabledSkillKeys: ChatDisabledSkillKeys,
): AgentRuntimeSkillContext {
  if (disabledSkillKeys.length === 0) {
    return skillContext
  }

  const disabledSkillKeySet = new Set(disabledSkillKeys)
  return AgentRuntimeSkillContextSchema.parse({
    availableSkills: skillContext.availableSkills.filter(skill => !disabledSkillKeySet.has(skill.key)),
  })
}

function filterRuntimeSkillCredentials(
  skillCredentials: AgentRuntimeSkillCredentials,
  disabledSkillKeys: ChatDisabledSkillKeys,
): AgentRuntimeSkillCredentials {
  if (disabledSkillKeys.length === 0) {
    return skillCredentials
  }

  const disabledSkillKeySet = new Set(disabledSkillKeys)
  return AgentRuntimeSkillCredentialsSchema.parse(
    skillCredentials.filter(credential => !disabledSkillKeySet.has(credential.key)),
  )
}

function readAgentMemoryRunOptions(commandContext: unknown): AgentMemoryRunOptions {
  if (isRecord(commandContext)) {
    return AgentMemoryRunOptionsSchema.parse(commandContext.memory)
  }

  return AgentMemoryRunOptionsSchema.parse(undefined)
}

function readAgentRuntimeHints(commandContext: unknown): AgentRuntimeHints {
  if (isRecord(commandContext)) {
    return AgentRuntimeHintsSchema.parse(commandContext.runtimeHints)
  }

  return AgentRuntimeHintsSchema.parse(undefined)
}

function readPendingClientAction(commandContext: unknown): AgentClientAction | null {
  if (!isRecord(commandContext)) {
    return null
  }

  const result = AgentClientActionSchema.safeParse(commandContext.pendingClientAction)
  return result.success ? result.data : null
}

function setResumeClientActionResult(
  commandContext: unknown,
  resume: AgentClientActionResult,
  idempotencyKey: string,
): Record<string, unknown> {
  const base = isRecord(commandContext) ? { ...commandContext } : {}

  return {
    ...base,
    resumeClientActionResult: resume,
    resumeCommandIdempotencyKey: idempotencyKey,
  }
}

function isClientActionResultForAction(
  result: AgentClientActionResult,
  action: AgentClientAction,
): boolean {
  return result.type === action.resultType && result.toolCallId === action.toolCallId
}

async function createClientActionToolResultPart(input: {
  tx: Prisma.TransactionClient
  action: AgentClientAction
  messageId: string
  runId: string
  resume: AgentClientActionResult
}) {
  const existingParts = await input.tx.chatSessionMessagePart.findMany({
    where: {
      messageId: input.messageId,
      deletedAt: null,
    },
    select: {
      order: true,
      type: true,
      metadata: true,
    },
  })
  const usedOrders = new Set(existingParts.map(part => part.order))
  const callPart = existingParts.find(part =>
    part.type === ChatSessionMessagePartType.TOOL_CALL
    && readMetadataToolCallId(part.metadata) === input.action.toolCallId,
  )
  const fallbackOrder = Math.max(-1, ...existingParts.map(part => part.order)) + 1
  const order = reserveAvailablePartOrder(
    usedOrders,
    callPart ? callPart.order + 1 : fallbackOrder,
  )
  const text = createClientActionToolResultText(input.resume)
  const part = await input.tx.chatSessionMessagePart.create({
    data: {
      messageId: input.messageId,
      type: toPrismaChatMessagePartType(CHAT_MESSAGE_PART_TYPE.TOOL_RESULT),
      text,
      order,
      metadata: toJsonObject(createClientActionToolResultMetadata(input.action, input.resume)),
    },
    select: {
      id: true,
      order: true,
    },
  })
  const projection = createClientActionToolResultPartProjection({
    action: input.action,
    order: part.order,
    partId: part.id,
    resume: input.resume,
  })

  return {
    event: {
      type: CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA,
      messageId: input.messageId,
      runId: input.runId,
      sourceEventId: null,
      payload: projection.payload,
    },
  }
}

export function createClientActionToolResultPartProjection(input: {
  action: AgentClientAction
  order: number
  partId: string
  resume: AgentClientActionResult
}) {
  const text = createClientActionToolResultText(input.resume)
  const metadata = createClientActionToolResultMetadata(input.action, input.resume)

  return {
    text,
    metadata,
    payload: {
      partId: input.partId,
      partType: CHAT_MESSAGE_PART_TYPE.TOOL_RESULT,
      order: input.order,
      delta: text,
      metadata,
    },
  }
}

function createClientActionToolResultMetadata(
  action: AgentClientAction,
  resume: AgentClientActionResult,
) {
  return {
    toolCallId: action.toolCallId,
    skillKey: action.skillKey,
    actionName: action.actionName,
    status: resolveClientActionToolResultStatus(resume),
  } as const
}

function resolveClientActionToolResultStatus(
  resume: AgentClientActionResult,
): 'success' | 'error' {
  return resume.error ? 'error' : 'success'
}

function createClientActionToolResultText(resume: AgentClientActionResult): string {
  if (resume.error) {
    return JSON.stringify({
      status: 'failed',
      reason: resume.error.message ?? resume.error.code,
    })
  }

  if (resume.payload) {
    return JSON.stringify(resume.payload)
  }

  return JSON.stringify({
    status: 'ok',
  })
}

function reserveAvailablePartOrder(usedOrders: Set<number>, preferredOrder: number): number {
  let order = preferredOrder
  while (usedOrders.has(order)) {
    order += 1
  }
  return order
}

function readMetadataToolCallId(metadata: unknown): string | null {
  if (!isRecord(metadata)) {
    return null
  }

  const toolCallId = metadata.toolCallId
  return typeof toolCallId === 'string' && toolCallId.trim() ? toolCallId : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toJsonObject(value: object): Prisma.InputJsonObject
function toJsonObject(value: undefined): undefined
function toJsonObject(value: object | undefined): Prisma.InputJsonObject | undefined {
  if (!value) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Prisma.InputJsonObject
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

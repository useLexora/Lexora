import type {
  AgentClientAction,
  ChatGenerationEvent,
  ChatMessageFailureReason,
  ChatMessageMetadata,
  ChatMessagePartMetadata,
} from '@haohaoxue/lexora-contracts'
import type { ChatSessionEventDraft } from './chat-session-events.service'
import {
  AGENT_LOCATION_SKILL_KEY,
  CHAT_MESSAGE_FAILURE_REASON,
  CHAT_MESSAGE_PART_TYPE,
  CHAT_SESSION_EVENT_TYPE,
  ChatGenerationUsageSnapshotSchema,
  ChatMemoryOperationProjectionSchema,
} from '@haohaoxue/lexora-contracts'
import { createAgentInternalToolProtocolStripper } from '@haohaoxue/lexora-shared/agent'
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import {
  ChatMessageGenerationStatus,
  ChatSessionMessagePartType,
  ChatSessionMessageStatus,
  ChatSessionRunStatus,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import {
  AgentGenerationEventsConsumerError,
  AgentGenerationEventsService,
  getChatGenerationEventText,
} from '../agent/agent-events.service'
import { AgentMemoryOperationsService } from '../agent/agent-memory-operations.service'
import { ChatSessionEventsService } from './chat-session-events.service'
import { toPrismaChatMessagePartType } from './chat.utils'

const PROJECT_RUNNING_INTERVAL_MS = 2000
const PROJECT_RUNNING_BATCH_SIZE = 5
const EMPTY_AGENT_EVENT_STREAM_ID = '0-0'
const TOOL_PART_ORDER_START = 10

type ToolPartType = typeof CHAT_MESSAGE_PART_TYPE.TOOL_CALL | typeof CHAT_MESSAGE_PART_TYPE.TOOL_RESULT

interface ToolPartEntry {
  id?: string
  order: number
  text: string
  metadata: ChatMessagePartMetadata | null
}

interface ToolPartState {
  calls: Map<string, ToolPartEntry>
  results: Map<string, ToolPartEntry>
  nextOrder: number
  usedOrders: Set<number>
}

interface UpsertToolPartInput {
  runId: string
  sessionId: string
  messageId: string
  sourceEventId: string
  type: ToolPartType
  toolCallId: string
  skillKey?: string
  actionName?: string
  status?: ChatMessagePartMetadata['status']
  textDelta?: string
  textSnapshot?: string
  textIfEmpty?: string
  elapsedMs?: number
}

interface PendingSinglePartDelta {
  sourceEventId: string
  type: typeof CHAT_MESSAGE_PART_TYPE.REASONING | typeof CHAT_MESSAGE_PART_TYPE.TEXT
  text: string
  snapshotText: string
}

@Injectable()
export class ChatRunProjectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatRunProjectorService.name)
  private readonly projectingRunIds = new Set<string>()
  private recoverTimer: ReturnType<typeof setInterval> | null = null
  private recovering = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGenerationEventsService: AgentGenerationEventsService,
    private readonly agentMemoryOperations: AgentMemoryOperationsService,
    private readonly chatSessionEvents: ChatSessionEventsService,
  ) {}

  onModuleInit(): void {
    this.recoverTimer = setInterval(() => {
      void this.recoverRunningRuns().catch(error => this.logger.error(
        error instanceof Error ? error.message : 'recover running chat runs failed',
        error instanceof Error ? error.stack : undefined,
      ))
    }, PROJECT_RUNNING_INTERVAL_MS)
  }

  onModuleDestroy(): void {
    if (!this.recoverTimer) {
      return
    }

    clearInterval(this.recoverTimer)
    this.recoverTimer = null
  }

  async recoverRunningRuns(): Promise<void> {
    if (this.recovering) {
      return
    }

    this.recovering = true
    try {
      const runs = await this.prisma.chatSessionRun.findMany({
        where: {
          commandPublishedAt: {
            not: null,
          },
          status: ChatSessionRunStatus.RUNNING,
        },
        select: {
          runId: true,
        },
        orderBy: {
          updatedAt: 'asc',
        },
        take: PROJECT_RUNNING_BATCH_SIZE,
      })

      await Promise.all(runs.map(run => this.recoverRun(run.runId)))
    }
    finally {
      this.recovering = false
    }
  }

  async projectRun(input: {
    runId: string
    afterId: string
  }): Promise<void> {
    if (this.projectingRunIds.has(input.runId)) {
      return
    }

    this.projectingRunIds.add(input.runId)
    try {
      const run = await this.prisma.chatSessionRun.findUnique({
        where: { runId: input.runId },
        select: {
          runId: true,
          sessionId: true,
          assistantMessageId: true,
          commandContext: true,
          status: true,
        },
      })

      if (!run || run.status !== ChatSessionRunStatus.RUNNING) {
        return
      }

      let reasoningText = await this.getMessagePartText(run.assistantMessageId, ChatSessionMessagePartType.REASONING)
      let answerText = await this.getMessagePartText(run.assistantMessageId, ChatSessionMessagePartType.TEXT)
      const toolPartState = await this.getToolPartState(run.assistantMessageId)
      // Persistence defense only; agent runtime owns tool protocol correctness.
      const reasoningTextStripper = createAgentInternalToolProtocolStripper()
      const answerTextStripper = createAgentInternalToolProtocolStripper()

      try {
        await this.agentGenerationEventsService.consumeGenerationEvents({
          generationId: run.runId,
          afterId: input.afterId,
          messages: {
            aborted: '聊天请求已取消',
            cancelled: '聊天运行已取消',
            timedOut: '等待聊天运行结果超时',
            failed: '聊天运行失败',
          },
          onEvent: async (event, sourceEventId) => {
            if (event.type === 'model.reasoning.delta') {
              const rawText = getChatGenerationEventText(event)
              if (!rawText || await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              const text = reasoningTextStripper.write(rawText).textDeltas.join('')
              if (!text) {
                return
              }

              reasoningText += text
              await this.appendPartDelta({
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                type: CHAT_MESSAGE_PART_TYPE.REASONING,
                text,
                snapshotText: reasoningText,
              })
              return
            }

            if (event.type === 'model.text.delta') {
              const rawText = getChatGenerationEventText(event)
              if (!rawText || await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              const text = answerTextStripper.write(rawText).textDeltas.join('')
              if (!text) {
                return
              }

              answerText += text
              await this.appendPartDelta({
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                type: CHAT_MESSAGE_PART_TYPE.TEXT,
                text,
                snapshotText: answerText,
              })
              return
            }

            if (event.type === 'model.tool.call.started') {
              const payload = getToolEventPayload(event)
              if (!payload?.toolCallId || await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              await this.upsertToolPartSnapshot(toolPartState, {
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                type: CHAT_MESSAGE_PART_TYPE.TOOL_CALL,
                toolCallId: payload.toolCallId,
                skillKey: payload.skillKey,
                actionName: payload.actionName,
                status: 'input_streaming',
              })
              return
            }

            if (event.type === 'model.tool.call.args.delta') {
              const payload = getToolEventPayload(event)
              const text = getChatGenerationEventText(event)
              if (!payload?.toolCallId || !text || await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              await this.upsertToolPartSnapshot(toolPartState, {
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                type: CHAT_MESSAGE_PART_TYPE.TOOL_CALL,
                toolCallId: payload.toolCallId,
                textDelta: text,
              })
              return
            }

            if (event.type === 'model.tool.call.completed') {
              const payload = getToolEventPayload(event)
              if (!payload?.toolCallId || await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              await this.upsertToolPartSnapshot(toolPartState, {
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                type: CHAT_MESSAGE_PART_TYPE.TOOL_CALL,
                toolCallId: payload.toolCallId,
                skillKey: payload.skillKey,
                actionName: payload.actionName,
                status: 'input_available',
              })
              return
            }

            if (event.type === 'tool.execution.started') {
              const payload = getToolEventPayload(event)
              if (!payload?.toolCallId || !payload.actionName || await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              await this.upsertToolPartSnapshot(toolPartState, {
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                type: CHAT_MESSAGE_PART_TYPE.TOOL_CALL,
                toolCallId: payload.toolCallId,
                skillKey: payload.skillKey,
                actionName: payload.actionName,
                status: 'running',
                textIfEmpty: payload.argumentsText,
              })
              return
            }

            if (event.type === 'tool.execution.completed') {
              const payload = getToolEventPayload(event)
              if (!payload?.toolCallId || !payload.actionName || await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              await this.upsertToolPartSnapshot(toolPartState, {
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                type: CHAT_MESSAGE_PART_TYPE.TOOL_RESULT,
                toolCallId: payload.toolCallId,
                skillKey: payload.skillKey,
                actionName: payload.actionName,
                status: payload.status ?? 'success',
                textSnapshot: payload.outputText ?? '',
                elapsedMs: payload.durationMs,
              })
              return
            }

            if (event.type === 'tool.execution.failed') {
              const payload = getToolEventPayload(event)
              if (!payload?.toolCallId || !payload.actionName || await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              await this.upsertToolPartSnapshot(toolPartState, {
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                type: CHAT_MESSAGE_PART_TYPE.TOOL_RESULT,
                toolCallId: payload.toolCallId,
                skillKey: payload.skillKey,
                actionName: payload.actionName,
                status: 'error',
                textSnapshot: payload.message,
                elapsedMs: payload.durationMs,
              })
              return
            }

            if (event.type === 'generation.client_action.required') {
              const action = event.payload.action
              if (await this.chatSessionEvents.hasSourceEvent(run.runId, sourceEventId)) {
                return
              }

              await this.upsertToolPartSnapshot(toolPartState, {
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId: `${sourceEventId}:tool`,
                type: CHAT_MESSAGE_PART_TYPE.TOOL_CALL,
                toolCallId: action.toolCallId,
                skillKey: action.skillKey,
                actionName: action.actionName,
                status: 'requires_action',
              })
              await this.requireClientActionRun({
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                action,
              })
              return
            }

            if (event.type === 'generation.completed') {
              const pendingPartDeltas: PendingSinglePartDelta[] = []
              const flushedReasoningText = reasoningTextStripper.flush().textDeltas.join('')
              if (flushedReasoningText) {
                reasoningText += flushedReasoningText
                pendingPartDeltas.push({
                  sourceEventId: `${sourceEventId}:reasoning-flush`,
                  type: CHAT_MESSAGE_PART_TYPE.REASONING,
                  text: flushedReasoningText,
                  snapshotText: reasoningText,
                })
              }

              const flushedAnswerText = answerTextStripper.flush().textDeltas.join('')
              if (flushedAnswerText) {
                answerText += flushedAnswerText
                pendingPartDeltas.push({
                  sourceEventId: `${sourceEventId}:text-flush`,
                  type: CHAT_MESSAGE_PART_TYPE.TEXT,
                  text: flushedAnswerText,
                  snapshotText: answerText,
                })
              }

              await this.completeRun({
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                content: answerText,
                metadata: buildCompletedMessageMetadata({
                  event,
                  startedAt: Date.now(),
                  reasoningStartedAt: null,
                  reasoningEndedAt: null,
                }),
                expectedHistoryVersion: getExpectedHistoryVersion(run.commandContext),
                pendingPartDeltas,
              })
              return
            }

            if (event.type === 'generation.failed') {
              await this.failRun({
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
                failureReason: CHAT_MESSAGE_FAILURE_REASON.FAILED,
                failureMessage: getFailureMessageFromEvent(event, '聊天运行失败'),
              })
              return
            }

            if (event.type === 'generation.cancelled') {
              await this.cancelRun({
                runId: run.runId,
                sessionId: run.sessionId,
                messageId: run.assistantMessageId,
                sourceEventId,
              })
            }
          },
        })
      }
      catch (error) {
        if (await this.isTerminalRun(run.runId)) {
          return
        }

        const failureReason = getFailureReason(error)
        if (failureReason === CHAT_MESSAGE_FAILURE_REASON.CANCELLED) {
          await this.cancelRun({
            runId: run.runId,
            sessionId: run.sessionId,
            messageId: run.assistantMessageId,
            sourceEventId: null,
          })
          return
        }

        await this.failRun({
          runId: run.runId,
          sessionId: run.sessionId,
          messageId: run.assistantMessageId,
          sourceEventId: null,
          failureReason,
          failureMessage: getFailureMessage(error),
        })
      }
    }
    finally {
      this.projectingRunIds.delete(input.runId)
    }
  }

  private async recoverRun(runId: string): Promise<void> {
    const afterId = await this.chatSessionEvents.getLatestSourceEventStreamId(runId) ?? EMPTY_AGENT_EVENT_STREAM_ID
    await this.projectRun({
      runId,
      afterId,
    })
  }

  private async getMessagePartText(messageId: string, type: ChatSessionMessagePartType): Promise<string> {
    const part = await this.prisma.chatSessionMessagePart.findFirst({
      where: {
        messageId,
        type,
      },
      select: {
        text: true,
      },
      orderBy: {
        order: 'asc',
      },
    })

    return part?.text ?? ''
  }

  private async getToolPartState(messageId: string): Promise<ToolPartState> {
    const parts = await this.prisma.chatSessionMessagePart.findMany({
      where: {
        messageId,
      },
      select: {
        id: true,
        type: true,
        text: true,
        order: true,
        metadata: true,
      },
      orderBy: {
        order: 'asc',
      },
    })
    const state: ToolPartState = {
      calls: new Map(),
      results: new Map(),
      nextOrder: TOOL_PART_ORDER_START,
      usedOrders: new Set(),
    }

    for (const part of parts) {
      state.usedOrders.add(part.order)
      state.nextOrder = Math.max(state.nextOrder, part.order + 1)

      if (
        part.type !== ChatSessionMessagePartType.TOOL_CALL
        && part.type !== ChatSessionMessagePartType.TOOL_RESULT
      ) {
        continue
      }

      const metadata = toChatMessagePartMetadata(part.metadata)
      const toolCallId = metadata?.toolCallId
      if (!toolCallId) {
        continue
      }

      const entry = {
        id: part.id,
        order: part.order,
        text: part.text,
        metadata,
      }

      if (part.type === ChatSessionMessagePartType.TOOL_CALL) {
        state.calls.set(toolCallId, entry)
      }
      else {
        state.results.set(toolCallId, entry)
      }
    }

    return state
  }

  private async upsertToolPartSnapshot(
    state: ToolPartState,
    input: UpsertToolPartInput,
  ): Promise<void> {
    const entry = getOrCreateToolPartEntry(state, input.type, input.toolCallId)
    const nextText = resolveNextToolPartText(entry.text, input)
    const delta = nextText.startsWith(entry.text)
      ? nextText.slice(entry.text.length)
      : nextText
    const metadata = createToolPartMetadata(entry.metadata, input)

    const committed = await ignoreUniqueConstraint(async () => this.prisma.$transaction(async (tx) => {
      if (!await isRunStatus(tx, input.runId, ChatSessionRunStatus.RUNNING)) {
        return
      }

      const part = await tx.chatSessionMessagePart.upsert({
        where: {
          messageId_order: {
            messageId: input.messageId,
            order: entry.order,
          },
        },
        create: {
          messageId: input.messageId,
          type: toPrismaChatMessagePartType(input.type),
          text: nextText,
          order: entry.order,
          metadata: toJsonObject(metadata),
        },
        update: {
          type: toPrismaChatMessagePartType(input.type),
          text: nextText,
          metadata: toJsonObject(metadata),
        },
        select: {
          id: true,
          order: true,
        },
      })

      entry.id = part.id
      await this.chatSessionEvents.appendEvents(tx, input.sessionId, [
        {
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA,
          messageId: input.messageId,
          runId: input.runId,
          sourceEventId: input.sourceEventId,
          payload: {
            partId: part.id,
            partType: input.type,
            order: part.order,
            delta,
            metadata,
          },
        },
      ])
    }))

    if (!committed) {
      return
    }

    entry.text = nextText
    entry.metadata = metadata
  }

  private async appendPartDelta(input: {
    runId: string
    sessionId: string
    messageId: string
    sourceEventId: string
    type: typeof CHAT_MESSAGE_PART_TYPE.REASONING | typeof CHAT_MESSAGE_PART_TYPE.TEXT
    text: string
    snapshotText: string
  }): Promise<void> {
    await ignoreUniqueConstraint(async () => this.prisma.$transaction(async (tx) => {
      if (!await isRunStatus(tx, input.runId, ChatSessionRunStatus.RUNNING)) {
        return
      }

      const order = getSinglePartOrder(input.type)
      const part = await tx.chatSessionMessagePart.upsert({
        where: {
          messageId_order: {
            messageId: input.messageId,
            order,
          },
        },
        create: {
          messageId: input.messageId,
          type: toPrismaChatMessagePartType(input.type),
          text: input.snapshotText,
          order,
        },
        update: {
          type: toPrismaChatMessagePartType(input.type),
          text: input.snapshotText,
        },
        select: {
          id: true,
          order: true,
        },
      })
      await tx.chatSessionMessage.update({
        where: { id: input.messageId },
        data: {
          content: input.type === CHAT_MESSAGE_PART_TYPE.TEXT ? input.snapshotText : undefined,
        },
      })
      await this.chatSessionEvents.appendEvents(tx, input.sessionId, [
        {
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA,
          messageId: input.messageId,
          runId: input.runId,
          sourceEventId: input.sourceEventId,
          payload: {
            partId: part.id,
            partType: input.type,
            order: part.order,
            delta: input.text,
            metadata: null,
          },
        },
      ])
    }))
  }

  private async completeRun(input: {
    runId: string
    sessionId: string
    messageId: string
    sourceEventId: string
    content: string
    metadata: ChatMessageMetadata
    expectedHistoryVersion: number
    pendingPartDeltas?: PendingSinglePartDelta[]
  }): Promise<void> {
    if (await this.chatSessionEvents.hasSourceEvent(input.runId, `${input.sourceEventId}:message`)) {
      return
    }

    const completedAt = new Date()
    let finalizedMemoryIds: string[] = []
    const committed = await ignoreUniqueConstraint(async () => this.prisma.$transaction(async (tx) => {
      const run = await readRunningRunForTerminalUpdate(tx, input.runId)
      if (!run) {
        return
      }

      const sessionUpdate = await tx.chatSession.updateMany({
        where: {
          id: input.sessionId,
          historyVersion: input.expectedHistoryVersion,
        },
        data: {
          historyVersion: { increment: 1 },
          updatedAt: completedAt,
        },
      })

      if (sessionUpdate.count === 0) {
        throw new Error('聊天历史已变化，请重新发送')
      }

      await tx.chatSessionMessage.update({
        where: { id: input.messageId },
        data: {
          status: ChatSessionMessageStatus.COMPLETED,
          content: input.content,
          metadata: toJsonObject(input.metadata),
          completedAt,
        },
      })
      await tx.chatSessionRun.update({
        where: { runId: input.runId },
        data: {
          status: ChatSessionRunStatus.COMPLETED,
          completedAt,
          dispatchLeaseExpiresAt: null,
          commandContext: toJsonObject(clearLocationClientIpRuntimeInput(run.commandContext)),
        },
      })
      await tx.chatMessageGeneration.updateMany({
        where: { generationId: input.runId },
        data: {
          status: ChatMessageGenerationStatus.COMPLETED,
          completedAt,
          usageSnapshot: input.metadata.usage ? toJsonObject(input.metadata.usage) : undefined,
          dispatchLeaseExpiresAt: null,
        },
      })
      const finalizeResult = await this.agentMemoryOperations.finalizeGenerationOperations(
        tx,
        input.runId,
        input.metadata.memoryOperations ?? [],
      )
      finalizedMemoryIds = finalizeResult.archivedMemoryIds
      const pendingPartEvents: ChatSessionEventDraft[] = []
      for (const pendingDelta of input.pendingPartDeltas ?? []) {
        const order = getSinglePartOrder(pendingDelta.type)
        const part = await tx.chatSessionMessagePart.upsert({
          where: {
            messageId_order: {
              messageId: input.messageId,
              order,
            },
          },
          create: {
            messageId: input.messageId,
            type: toPrismaChatMessagePartType(pendingDelta.type),
            text: pendingDelta.snapshotText,
            order,
          },
          update: {
            type: toPrismaChatMessagePartType(pendingDelta.type),
            text: pendingDelta.snapshotText,
          },
          select: {
            id: true,
            order: true,
          },
        })

        pendingPartEvents.push({
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA,
          messageId: input.messageId,
          runId: input.runId,
          sourceEventId: pendingDelta.sourceEventId,
          payload: {
            partId: part.id,
            partType: pendingDelta.type,
            order: part.order,
            delta: pendingDelta.text,
            metadata: null,
          },
        })
      }
      await this.chatSessionEvents.appendEvents(tx, input.sessionId, [
        ...pendingPartEvents,
        ...createSnapshotRequiredEvents(input.metadata),
        {
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_COMPLETED,
          messageId: input.messageId,
          runId: input.runId,
          sourceEventId: `${input.sourceEventId}:message`,
          payload: toJsonObject({
            content: input.content,
            metadata: input.metadata,
          }),
        },
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_COMPLETED,
          runId: input.runId,
          sourceEventId: `${input.sourceEventId}:run`,
          payload: toJsonObject({
            usage: input.metadata.usage,
          }),
        },
      ])
    }))
    if (committed && finalizedMemoryIds.length > 0) {
      await this.agentMemoryOperations.cleanupFinalizedMemoryIndexes(finalizedMemoryIds)
    }
  }

  private async requireClientActionRun(input: {
    runId: string
    sessionId: string
    messageId: string
    sourceEventId: string
    action: AgentClientAction
  }): Promise<void> {
    if (await this.chatSessionEvents.hasSourceEvent(input.runId, input.sourceEventId)) {
      return
    }

    const updatedAt = new Date()
    await ignoreUniqueConstraint(async () => this.prisma.$transaction(async (tx) => {
      const run = await tx.chatSessionRun.findUnique({
        where: { runId: input.runId },
        select: {
          commandContext: true,
          status: true,
        },
      })
      if (!run || run.status !== ChatSessionRunStatus.RUNNING) {
        return
      }

      await tx.chatSessionRun.update({
        where: { runId: input.runId },
        data: {
          status: ChatSessionRunStatus.REQUIRES_ACTION,
          commandPublishedAt: null,
          dispatchLeaseExpiresAt: null,
          commandContext: toJsonObject(setPendingClientAction(run.commandContext, input.action)),
        },
      })
      await tx.chatMessageGeneration.updateMany({
        where: { generationId: input.runId },
        data: {
          status: ChatMessageGenerationStatus.REQUIRES_ACTION,
          commandPublishedAt: null,
          dispatchLeaseExpiresAt: null,
        },
      })
      await tx.chatSession.update({
        where: { id: input.sessionId },
        data: {
          updatedAt,
        },
      })
      await this.chatSessionEvents.appendEvents(tx, input.sessionId, [
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_REQUIRES_ACTION,
          messageId: input.messageId,
          runId: input.runId,
          sourceEventId: input.sourceEventId,
          payload: toJsonObject({
            action: input.action,
          }),
        },
      ])
    }))
  }

  private async failRun(input: {
    runId: string
    sessionId: string
    messageId: string
    sourceEventId: string | null
    failureReason: ChatMessageFailureReason
    failureMessage: string
  }): Promise<void> {
    const sourceEventId = input.sourceEventId ? `${input.sourceEventId}:message` : null
    if (sourceEventId && await this.chatSessionEvents.hasSourceEvent(input.runId, sourceEventId)) {
      return
    }

    const completedAt = new Date()
    let rolledBackMemoryIds: string[] = []
    let restoredMemoryIds: string[] = []
    const committed = await ignoreUniqueConstraint(async () => this.prisma.$transaction(async (tx) => {
      const run = await readRunningRunForTerminalUpdate(tx, input.runId)
      if (!run) {
        return
      }

      const rollbackResult = await this.agentMemoryOperations.rollbackGenerationOperations(tx, input.runId)
      rolledBackMemoryIds = rollbackResult.memoryIds
      restoredMemoryIds = rollbackResult.restoredMemoryIds
      await tx.chatSessionMessage.update({
        where: { id: input.messageId },
        data: {
          status: ChatSessionMessageStatus.FAILED,
          metadata: toJsonObject({
            failureReason: input.failureReason,
            failureMessage: input.failureMessage,
          }),
          completedAt,
        },
      })
      await tx.chatSessionRun.update({
        where: { runId: input.runId },
        data: {
          status: ChatSessionRunStatus.FAILED,
          completedAt,
          dispatchLeaseExpiresAt: null,
          commandContext: toJsonObject(clearLocationClientIpRuntimeInput(run.commandContext)),
        },
      })
      await tx.chatMessageGeneration.updateMany({
        where: { generationId: input.runId },
        data: {
          status: ChatMessageGenerationStatus.FAILED,
          completedAt,
          dispatchLeaseExpiresAt: null,
          error: toJsonObject({
            failureReason: input.failureReason,
            failureMessage: input.failureMessage,
          }),
        },
      })
      await tx.chatSession.update({
        where: { id: input.sessionId },
        data: {
          updatedAt: completedAt,
        },
      })
      await this.chatSessionEvents.appendEvents(tx, input.sessionId, [
        ...createSnapshotRequiredEventsForMemoryStateChanged(rollbackResult.changed),
        {
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_FAILED,
          messageId: input.messageId,
          runId: input.runId,
          sourceEventId,
          payload: {
            failureReason: input.failureReason,
            failureMessage: input.failureMessage,
          },
        },
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_FAILED,
          runId: input.runId,
          sourceEventId: input.sourceEventId ? `${input.sourceEventId}:run` : null,
          payload: {
            failureReason: input.failureReason,
            failureMessage: input.failureMessage,
          },
        },
      ])
    }))
    if (committed && (rolledBackMemoryIds.length > 0 || restoredMemoryIds.length > 0)) {
      await this.agentMemoryOperations.cleanupRolledBackMemoryIndexes(rolledBackMemoryIds, restoredMemoryIds)
    }
  }

  private async cancelRun(input: {
    runId: string
    sessionId: string
    messageId: string
    sourceEventId: string | null
  }): Promise<void> {
    const sourceEventId = input.sourceEventId ? `${input.sourceEventId}:message` : null
    if (sourceEventId && await this.chatSessionEvents.hasSourceEvent(input.runId, sourceEventId)) {
      return
    }

    const completedAt = new Date()
    let rolledBackMemoryIds: string[] = []
    let restoredMemoryIds: string[] = []
    const committed = await ignoreUniqueConstraint(async () => this.prisma.$transaction(async (tx) => {
      const run = await readRunningRunForTerminalUpdate(tx, input.runId)
      if (!run) {
        return
      }

      const rollbackResult = await this.agentMemoryOperations.rollbackGenerationOperations(tx, input.runId)
      rolledBackMemoryIds = rollbackResult.memoryIds
      restoredMemoryIds = rollbackResult.restoredMemoryIds
      await tx.chatSessionMessage.update({
        where: { id: input.messageId },
        data: {
          status: ChatSessionMessageStatus.CANCELLED,
          completedAt,
        },
      })
      await tx.chatSessionRun.update({
        where: { runId: input.runId },
        data: {
          status: ChatSessionRunStatus.CANCELLED,
          completedAt,
          dispatchLeaseExpiresAt: null,
          commandContext: toJsonObject(clearLocationClientIpRuntimeInput(run.commandContext)),
        },
      })
      await tx.chatMessageGeneration.updateMany({
        where: { generationId: input.runId },
        data: {
          status: ChatMessageGenerationStatus.CANCELLED,
          completedAt,
          dispatchLeaseExpiresAt: null,
        },
      })
      await tx.chatSession.update({
        where: { id: input.sessionId },
        data: {
          updatedAt: completedAt,
        },
      })
      await this.chatSessionEvents.appendEvents(tx, input.sessionId, [
        ...createSnapshotRequiredEventsForMemoryStateChanged(rollbackResult.changed),
        {
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_CANCELLED,
          messageId: input.messageId,
          runId: input.runId,
          sourceEventId,
          payload: {},
        },
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_CANCELLED,
          runId: input.runId,
          sourceEventId: input.sourceEventId ? `${input.sourceEventId}:run` : null,
          payload: {},
        },
      ])
    }))
    if (committed && (rolledBackMemoryIds.length > 0 || restoredMemoryIds.length > 0)) {
      await this.agentMemoryOperations.cleanupRolledBackMemoryIndexes(rolledBackMemoryIds, restoredMemoryIds)
    }
  }

  private async isTerminalRun(runId: string): Promise<boolean> {
    const run = await this.prisma.chatSessionRun.findUnique({
      where: { runId },
      select: { status: true },
    })

    return !run
      || run.status === ChatSessionRunStatus.COMPLETED
      || run.status === ChatSessionRunStatus.FAILED
      || run.status === ChatSessionRunStatus.CANCELLED
  }
}

async function isRunStatus(
  tx: Prisma.TransactionClient,
  runId: string,
  status: ChatSessionRunStatus,
): Promise<boolean> {
  const run = await tx.chatSessionRun.findUnique({
    where: { runId },
    select: { status: true },
  })

  return run?.status === status
}

async function readRunningRunForTerminalUpdate(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<{
  commandContext: unknown
} | null> {
  const run = await tx.chatSessionRun.findUnique({
    where: { runId },
    select: {
      commandContext: true,
      status: true,
    },
  })

  return run?.status === ChatSessionRunStatus.RUNNING
    ? { commandContext: run.commandContext }
    : null
}

function clearLocationClientIpRuntimeInput(commandContext: unknown): Record<string, unknown> {
  const base = isRecord(commandContext) ? { ...commandContext } : {}
  const runtimeHints = isRecord(base.runtimeHints) ? { ...base.runtimeHints } : null
  const skillInputs = isRecord(runtimeHints?.skillInputs) ? { ...runtimeHints.skillInputs } : null
  const locationInput = isRecord(skillInputs?.[AGENT_LOCATION_SKILL_KEY])
    ? { ...skillInputs[AGENT_LOCATION_SKILL_KEY] }
    : null

  if (!runtimeHints || !skillInputs || !locationInput || !('clientIp' in locationInput)) {
    return base
  }

  delete locationInput.clientIp
  if (Object.keys(locationInput).length > 0) {
    skillInputs[AGENT_LOCATION_SKILL_KEY] = locationInput
  }
  else {
    delete skillInputs[AGENT_LOCATION_SKILL_KEY]
  }

  return removeUndefined({
    ...base,
    runtimeHints: Object.keys(skillInputs).length > 0
      ? {
          ...runtimeHints,
          skillInputs,
        }
      : undefined,
  })
}

function getOrCreateToolPartEntry(
  state: ToolPartState,
  type: ToolPartType,
  toolCallId: string,
): ToolPartEntry {
  const map = type === CHAT_MESSAGE_PART_TYPE.TOOL_CALL ? state.calls : state.results
  const existing = map.get(toolCallId)
  if (existing) {
    return existing
  }

  const pairedCall = state.calls.get(toolCallId)
  const order = resolveNewToolPartOrder(state, type, pairedCall)

  const entry: ToolPartEntry = {
    order,
    text: '',
    metadata: null,
  }
  map.set(toolCallId, entry)
  return entry
}

function resolveNewToolPartOrder(
  state: ToolPartState,
  type: ToolPartType,
  pairedCall: ToolPartEntry | undefined,
): number {
  if (type === CHAT_MESSAGE_PART_TYPE.TOOL_RESULT && pairedCall) {
    return reserveToolPartOrder(state, pairedCall.order + 1)
  }

  const order = reserveToolPartOrder(state, state.nextOrder)
  if (type === CHAT_MESSAGE_PART_TYPE.TOOL_CALL) {
    state.nextOrder = Math.max(state.nextOrder, order + 2)
  }
  return order
}

function reserveToolPartOrder(state: ToolPartState, preferredOrder: number): number {
  let order = preferredOrder
  while (state.usedOrders.has(order)) {
    order += 1
  }

  state.usedOrders.add(order)
  state.nextOrder = Math.max(state.nextOrder, order + 1)
  return order
}

function resolveNextToolPartText(current: string, input: UpsertToolPartInput): string {
  if (input.textSnapshot !== undefined) {
    return input.textSnapshot
  }

  if (!current && input.textIfEmpty !== undefined) {
    return input.textIfEmpty
  }

  return current + (input.textDelta ?? '')
}

function createToolPartMetadata(
  previous: ChatMessagePartMetadata | null,
  input: UpsertToolPartInput,
): ChatMessagePartMetadata {
  return removeUndefined({
    ...(previous ?? {}),
    toolCallId: input.toolCallId,
    skillKey: input.skillKey ?? previous?.skillKey,
    actionName: input.actionName ?? previous?.actionName,
    status: input.status ?? previous?.status,
    elapsedMs: input.elapsedMs ?? previous?.elapsedMs,
  })
}

function toChatMessagePartMetadata(value: unknown): ChatMessagePartMetadata | null {
  return isRecord(value) ? value as ChatMessagePartMetadata : null
}

function getToolEventPayload(event: ChatGenerationEvent): {
  toolCallId?: string
  skillKey?: string
  actionName?: string
  status?: 'success' | 'error' | 'requires_action'
  argumentsText?: string
  outputText?: string
  message?: string
  durationMs?: number
} | null {
  if (!isRecord(event.payload)) {
    return null
  }
  const payload: Record<string, unknown> = event.payload

  return {
    toolCallId: readString(payload.toolCallId),
    skillKey: readString(payload.skillKey),
    actionName: readString(payload.actionName),
    status: readToolStatus(payload.status),
    argumentsText: readString(payload.argumentsText),
    outputText: readString(payload.outputText),
    message: readString(payload.message),
    durationMs: readNonNegativeInteger(payload.durationMs),
  }
}

function readToolStatus(value: unknown): 'success' | 'error' | 'requires_action' | undefined {
  return value === 'success' || value === 'error' || value === 'requires_action'
    ? value
    : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function setPendingClientAction(commandContext: unknown, action: AgentClientAction): Record<string, unknown> {
  const base = isRecord(commandContext) ? { ...commandContext } : {}

  return removeUndefined({
    ...base,
    pendingClientAction: action,
    resumeClientActionResult: undefined,
    resumeCommandIdempotencyKey: undefined,
  })
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}

async function ignoreUniqueConstraint(write: () => Promise<void>): Promise<boolean> {
  try {
    await write()
    return true
  }
  catch (error) {
    if (isUniqueConstraintError(error)) {
      return false
    }

    throw error
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function getSinglePartOrder(type: typeof CHAT_MESSAGE_PART_TYPE.REASONING | typeof CHAT_MESSAGE_PART_TYPE.TEXT): number {
  return type === CHAT_MESSAGE_PART_TYPE.REASONING ? 0 : 1
}

function getExpectedHistoryVersion(value: unknown): number {
  if (!value || typeof value !== 'object') {
    throw new Error('聊天运行上下文无效')
  }

  const expectedHistoryVersion = (value as { expectedHistoryVersion?: unknown }).expectedHistoryVersion
  if (typeof expectedHistoryVersion !== 'number' || !Number.isInteger(expectedHistoryVersion)) {
    throw new TypeError('聊天运行历史版本无效')
  }

  return expectedHistoryVersion
}

function createSnapshotRequiredEvents(metadata: ChatMessageMetadata) {
  return metadata.memoryOperations && metadata.memoryOperations.length > 0
    ? [{ type: CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED }]
    : []
}

function createSnapshotRequiredEventsForMemoryStateChanged(changed: boolean) {
  return changed
    ? [{ type: CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED }]
    : []
}

function buildCompletedMessageMetadata(input: {
  event: ChatGenerationEvent
  startedAt: number
  reasoningStartedAt: number | null
  reasoningEndedAt: number | null
}): ChatMessageMetadata {
  const durationMs = getDurationMs(input.event) ?? Date.now() - input.startedAt
  const reasoningElapsedMs = input.reasoningStartedAt && input.reasoningEndedAt
    ? Math.max(0, input.reasoningEndedAt - input.reasoningStartedAt)
    : undefined

  return {
    elapsedMs: durationMs,
    reasoningElapsedMs,
    usage: getUsageFromEvent(input.event),
    memoryOperations: getMemoryOperationsFromEvent(input.event),
  }
}

function getDurationMs(event: ChatGenerationEvent): number | null {
  if (!event.payload || typeof event.payload !== 'object') {
    return null
  }

  const durationMs = (event.payload as { durationMs?: unknown }).durationMs
  return typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, Math.trunc(durationMs)) : null
}

function getUsageFromEvent(event: ChatGenerationEvent): ChatMessageMetadata['usage'] {
  if (!event.payload || typeof event.payload !== 'object') {
    return undefined
  }

  const usage = (event.payload as { usage?: unknown }).usage
  if (!usage) {
    return undefined
  }

  return ChatGenerationUsageSnapshotSchema.parse(usage)
}

function getMemoryOperationsFromEvent(event: ChatGenerationEvent): NonNullable<ChatMessageMetadata['memoryOperations']> {
  if (!event.payload || typeof event.payload !== 'object') {
    return []
  }

  const operations = (event.payload as { memoryOperations?: unknown }).memoryOperations
  if (!Array.isArray(operations)) {
    return []
  }

  return operations.map(operation => ChatMemoryOperationProjectionSchema.safeParse(operation))
    .filter(result => result.success)
    .map(result => result.data)
}

function getFailureReason(error: unknown): ChatMessageFailureReason {
  if (error instanceof AgentGenerationEventsConsumerError) {
    return error.reason
  }

  return CHAT_MESSAGE_FAILURE_REASON.FAILED
}

function getFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }

  return '聊天流式响应失败'
}

function getFailureMessageFromEvent(event: ChatGenerationEvent, fallback: string): string {
  if (event.payload && typeof event.payload === 'object') {
    const message = (event.payload as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) {
      return message.trim()
    }
  }

  return fallback
}

function toJsonObject(value: object): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Prisma.InputJsonObject
}

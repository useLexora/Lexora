import type { AgentGenerationCommand } from '@haohaoxue/lexora-contracts'
import { randomUUID } from 'node:crypto'
import {
  AGENT_GENERATION_COMMAND_KIND,
  AgentClientActionResultSchema,
  AgentClientActionSchema,
  AgentGenerationCommandSchema,
  CHAT_MESSAGE_FAILURE_REASON,
  CHAT_SESSION_EVENT_TYPE,
} from '@haohaoxue/lexora-contracts'
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import {
  ChatMessageGenerationStatus,
  ChatSessionMessageStatus,
  ChatSessionRunStatus,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { AgentCommandPublisherService } from '../agent/agent-command-publisher.service'
import { AgentGenerationEventsService } from '../agent/agent-events.service'
import { ChatRunProjectorService } from './chat-run-projector.service'
import { ChatSessionEventsService } from './chat-session-events.service'

const DISPATCH_INTERVAL_MS = 1500
const DISPATCH_BATCH_SIZE = 5
const DISPATCH_LEASE_MS = 60_000
const EMPTY_AGENT_EVENT_STREAM_ID = '0-0'

interface DispatchableChatRun {
  generationId: string
  sessionId: string
  assistantMessageId: string
  triggerUserMessageId: string
  actorUserId: string
  status: ChatMessageGenerationStatus
  attempt: number
  idempotencyKey: string
  commandPublishedAt: Date | null
  dispatchLeaseExpiresAt: Date | null
  commandContext: unknown
}

interface ClaimedGeneration {
  attempt: number
}

@Injectable()
export class ChatRunDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatRunDispatcherService.name)
  private dispatchTimer: ReturnType<typeof setInterval> | null = null
  private dispatching = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentCommandPublisher: AgentCommandPublisherService,
    private readonly agentGenerationEventsService: AgentGenerationEventsService,
    private readonly chatSessionEvents: ChatSessionEventsService,
    private readonly chatRunProjector: ChatRunProjectorService,
  ) {}

  onModuleInit(): void {
    this.dispatchTimer = setInterval(() => {
      void this.dispatchPendingRuns().catch(error => this.logger.error(
        error instanceof Error ? error.message : 'dispatch pending chat runs failed',
        error instanceof Error ? error.stack : undefined,
      ))
    }, DISPATCH_INTERVAL_MS)
  }

  onModuleDestroy(): void {
    if (!this.dispatchTimer) {
      return
    }

    clearInterval(this.dispatchTimer)
    this.dispatchTimer = null
  }

  async dispatchRun(runId: string): Promise<void> {
    const now = new Date()
    const run = await this.getDispatchableRun(runId, now)
    if (!run) {
      return
    }

    const afterId = await this.getProjectionAfterId(run)
    const claimed = await this.claimRun(run, now)

    if (!claimed) {
      return
    }

    const command = buildGenerationCommand(run, claimed)

    try {
      await this.agentCommandPublisher.publishGenerationCommand(command)
    }
    catch (error) {
      if (command.kind === AGENT_GENERATION_COMMAND_KIND.RESUME) {
        await this.markResumeCommandPublishFailed({
          run,
          message: error instanceof Error ? error.message : '发布聊天恢复命令失败',
        })
        return
      }

      await this.markRunFailed({
        runId: run.generationId,
        sessionId: run.sessionId,
        assistantMessageId: run.assistantMessageId,
        message: error instanceof Error ? error.message : '发布聊天运行命令失败',
      })
      return
    }

    const commandPublished = await this.markCommandPublished(run.generationId)
    if (!commandPublished) {
      return
    }

    this.logger.log(`chat generation command published: session=${run.sessionId} generation=${run.generationId}`)
    void this.chatRunProjector.projectRun({
      runId: run.generationId,
      afterId,
    }).catch(error => this.logger.error(
      error instanceof Error ? error.message : 'project chat run failed',
      error instanceof Error ? error.stack : undefined,
    ))
  }

  async dispatchPendingRuns(): Promise<void> {
    if (this.dispatching) {
      return
    }

    this.dispatching = true
    try {
      const now = new Date()
      const runs = await this.prisma.chatMessageGeneration.findMany({
        where: {
          OR: [
            { status: ChatMessageGenerationStatus.PENDING },
            {
              commandPublishedAt: null,
              dispatchLeaseExpiresAt: {
                lt: now,
              },
              status: ChatMessageGenerationStatus.RUNNING,
            },
          ],
        },
        select: {
          generationId: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
        take: DISPATCH_BATCH_SIZE,
      })

      for (const run of runs) {
        await this.dispatchRun(run.generationId)
      }
    }
    finally {
      this.dispatching = false
    }
  }

  private async getDispatchableRun(runId: string, now: Date): Promise<DispatchableChatRun | null> {
    const generation = await this.prisma.chatMessageGeneration.findFirst({
      where: {
        generationId: runId,
        OR: [
          { status: ChatMessageGenerationStatus.PENDING },
          {
            commandPublishedAt: null,
            dispatchLeaseExpiresAt: {
              lt: now,
            },
            status: ChatMessageGenerationStatus.RUNNING,
          },
        ],
      },
      select: {
        generationId: true,
        sessionId: true,
        assistantMessageId: true,
        triggerUserMessageId: true,
        actorUserId: true,
        status: true,
        attempt: true,
        idempotencyKey: true,
        commandPublishedAt: true,
        dispatchLeaseExpiresAt: true,
      },
    })

    if (!generation) {
      return null
    }

    const run = await this.prisma.chatSessionRun.findUnique({
      where: { runId },
      select: {
        commandContext: true,
      },
    })

    return {
      ...generation,
      commandContext: run?.commandContext ?? {},
    }
  }

  private async getProjectionAfterId(run: DispatchableChatRun): Promise<string> {
    if (run.status === ChatMessageGenerationStatus.RUNNING) {
      return await this.chatSessionEvents.getLatestSourceEventStreamId(run.generationId) ?? EMPTY_AGENT_EVENT_STREAM_ID
    }

    return this.agentGenerationEventsService.getLatestEventStreamId()
  }

  private async claimRun(run: DispatchableChatRun, now: Date): Promise<ClaimedGeneration | null> {
    if (run.status === ChatMessageGenerationStatus.RUNNING) {
      if (readResumeClientActionResult(run.commandContext)) {
        return this.claimResumeRun(run, now)
      }

      return this.reclaimRun(run, now)
    }

    const dispatchLeaseExpiresAt = new Date(now.getTime() + DISPATCH_LEASE_MS)
    return this.prisma.$transaction(async (tx) => {
      const update = await tx.chatMessageGeneration.updateMany({
        where: {
          generationId: run.generationId,
          status: ChatMessageGenerationStatus.PENDING,
        },
        data: {
          status: ChatMessageGenerationStatus.RUNNING,
          startedAt: now,
          dispatchLeaseExpiresAt,
          attempt: {
            increment: 1,
          },
        },
      })

      if (update.count === 0) {
        return null
      }

      await tx.chatSessionMessage.update({
        where: { id: run.assistantMessageId },
        data: {
          status: ChatSessionMessageStatus.STREAMING,
        },
      })
      await tx.chatSessionRun.updateMany({
        where: {
          runId: run.generationId,
          status: ChatSessionRunStatus.PENDING,
        },
        data: {
          status: ChatSessionRunStatus.RUNNING,
          startedAt: now,
          dispatchLeaseExpiresAt,
        },
      })
      await this.chatSessionEvents.appendEvents(tx, run.sessionId, [
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_STARTED,
          runId: run.generationId,
          payload: {},
        },
        {
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_STATUS_CHANGED,
          messageId: run.assistantMessageId,
          runId: run.generationId,
          payload: {
            status: 'streaming',
          },
        },
      ])

      return { attempt: run.attempt + 1 }
    })
  }

  private async claimResumeRun(run: DispatchableChatRun, now: Date): Promise<ClaimedGeneration | null> {
    const dispatchLeaseExpiresAt = new Date(now.getTime() + DISPATCH_LEASE_MS)
    return this.prisma.$transaction(async (tx) => {
      const update = await tx.chatMessageGeneration.updateMany({
        where: {
          commandPublishedAt: null,
          dispatchLeaseExpiresAt: {
            lt: now,
          },
          generationId: run.generationId,
          status: ChatMessageGenerationStatus.RUNNING,
        },
        data: {
          dispatchLeaseExpiresAt,
        },
      })

      if (update.count === 0) {
        return null
      }

      await tx.chatSessionRun.updateMany({
        where: {
          commandPublishedAt: null,
          dispatchLeaseExpiresAt: {
            lt: now,
          },
          runId: run.generationId,
          status: ChatSessionRunStatus.RUNNING,
        },
        data: {
          dispatchLeaseExpiresAt,
        },
      })

      return { attempt: run.attempt }
    })
  }

  private async reclaimRun(run: DispatchableChatRun, now: Date): Promise<ClaimedGeneration | null> {
    const dispatchLeaseExpiresAt = new Date(now.getTime() + DISPATCH_LEASE_MS)
    return this.prisma.$transaction(async (tx) => {
      const update = await tx.chatMessageGeneration.updateMany({
        where: {
          commandPublishedAt: null,
          dispatchLeaseExpiresAt: {
            lt: now,
          },
          generationId: run.generationId,
          status: ChatMessageGenerationStatus.RUNNING,
        },
        data: {
          dispatchLeaseExpiresAt,
          attempt: {
            increment: 1,
          },
        },
      })

      if (update.count === 0) {
        return null
      }

      await tx.chatSessionRun.updateMany({
        where: {
          commandPublishedAt: null,
          dispatchLeaseExpiresAt: {
            lt: now,
          },
          runId: run.generationId,
          status: ChatSessionRunStatus.RUNNING,
        },
        data: {
          dispatchLeaseExpiresAt,
        },
      })

      return { attempt: run.attempt + 1 }
    })
  }

  private async markCommandPublished(runId: string): Promise<boolean> {
    const commandPublishedAt = new Date()
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.chatSessionRun.findUnique({
        where: { runId },
        select: {
          commandContext: true,
        },
      })
      const update = await tx.chatSessionRun.updateMany({
        where: {
          commandPublishedAt: null,
          runId,
        },
        data: {
          commandPublishedAt,
          dispatchLeaseExpiresAt: null,
          ...(run
            ? { commandContext: toJsonObject(clearClientActionDispatchState(run.commandContext)) }
            : {}),
        },
      })

      if (update.count === 0) {
        return false
      }

      await tx.chatMessageGeneration.updateMany({
        where: {
          generationId: runId,
          commandPublishedAt: null,
        },
        data: {
          commandPublishedAt,
          dispatchLeaseExpiresAt: null,
        },
      })

      return true
    })
  }

  private async markResumeCommandPublishFailed(input: {
    run: DispatchableChatRun
    message: string
  }): Promise<void> {
    const pendingAction = readPendingClientAction(input.run.commandContext)
    if (!pendingAction) {
      await this.markRunFailed({
        runId: input.run.generationId,
        sessionId: input.run.sessionId,
        assistantMessageId: input.run.assistantMessageId,
        message: input.message,
      })
      return
    }

    await this.prisma.$transaction(async (tx) => {
      const runUpdate = await tx.chatSessionRun.updateMany({
        where: {
          runId: input.run.generationId,
          status: ChatSessionRunStatus.RUNNING,
          commandPublishedAt: null,
        },
        data: {
          status: ChatSessionRunStatus.REQUIRES_ACTION,
          dispatchLeaseExpiresAt: null,
          commandContext: toJsonObject(clearResumeClientActionResult(input.run.commandContext)),
        },
      })
      if (runUpdate.count === 0) {
        return
      }

      await tx.chatMessageGeneration.updateMany({
        where: {
          generationId: input.run.generationId,
          status: ChatMessageGenerationStatus.RUNNING,
          commandPublishedAt: null,
        },
        data: {
          status: ChatMessageGenerationStatus.REQUIRES_ACTION,
          dispatchLeaseExpiresAt: null,
        },
      })
      await this.chatSessionEvents.appendEvents(tx, input.run.sessionId, [
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_REQUIRES_ACTION,
          messageId: input.run.assistantMessageId,
          runId: input.run.generationId,
          payload: toJsonObject({
            action: pendingAction,
            failureMessage: input.message,
          }),
        },
      ])
    })
  }

  private async markRunFailed(input: {
    runId: string
    sessionId: string
    assistantMessageId: string
    message: string
  }): Promise<void> {
    const completedAt = new Date()

    await this.prisma.$transaction(async (tx) => {
      await tx.chatSessionRun.updateMany({
        where: {
          runId: input.runId,
        },
        data: {
          status: ChatSessionRunStatus.FAILED,
          completedAt,
          dispatchLeaseExpiresAt: null,
        },
      })
      await tx.chatMessageGeneration.updateMany({
        where: {
          generationId: input.runId,
        },
        data: {
          status: ChatMessageGenerationStatus.FAILED,
          completedAt,
          dispatchLeaseExpiresAt: null,
          error: toJsonObject({
            failureReason: CHAT_MESSAGE_FAILURE_REASON.FAILED,
            failureMessage: input.message,
          }),
        },
      })
      await tx.chatSessionMessage.updateMany({
        where: {
          id: input.assistantMessageId,
        },
        data: {
          status: ChatSessionMessageStatus.FAILED,
          metadata: toJsonObject({
            failureReason: CHAT_MESSAGE_FAILURE_REASON.FAILED,
            failureMessage: input.message,
          }),
          completedAt,
        },
      })
      await this.chatSessionEvents.appendEvents(tx, input.sessionId, [
        {
          type: CHAT_SESSION_EVENT_TYPE.RUN_FAILED,
          runId: input.runId,
          payload: {
            failureReason: CHAT_MESSAGE_FAILURE_REASON.FAILED,
            failureMessage: input.message,
          },
        },
        {
          type: CHAT_SESSION_EVENT_TYPE.MESSAGE_FAILED,
          messageId: input.assistantMessageId,
          runId: input.runId,
          payload: {
            failureReason: CHAT_MESSAGE_FAILURE_REASON.FAILED,
            failureMessage: input.message,
          },
        },
      ])
    })
  }
}

function buildGenerationCommand(run: DispatchableChatRun, claim: ClaimedGeneration): AgentGenerationCommand {
  const resume = readResumeClientActionResult(run.commandContext)
  if (resume) {
    return AgentGenerationCommandSchema.parse({
      kind: AGENT_GENERATION_COMMAND_KIND.RESUME,
      commandId: randomUUID(),
      generationId: run.generationId,
      idempotencyKey: readResumeCommandIdempotencyKey(run.commandContext) ?? `chat:generation:${run.generationId}:resume:${claim.attempt}`,
      attempt: claim.attempt,
      resume,
    })
  }

  return AgentGenerationCommandSchema.parse({
    commandId: randomUUID(),
    generationId: run.generationId,
    idempotencyKey: run.idempotencyKey,
    attempt: claim.attempt,
  })
}

function readPendingClientAction(commandContext: unknown) {
  if (!isRecord(commandContext)) {
    return null
  }

  const result = AgentClientActionSchema.safeParse(commandContext.pendingClientAction)
  return result.success ? result.data : null
}

function readResumeClientActionResult(commandContext: unknown) {
  if (!isRecord(commandContext)) {
    return null
  }

  const result = AgentClientActionResultSchema.safeParse(commandContext.resumeClientActionResult)
  return result.success ? result.data : null
}

function readResumeCommandIdempotencyKey(commandContext: unknown): string | null {
  if (!isRecord(commandContext)) {
    return null
  }

  const idempotencyKey = commandContext.resumeCommandIdempotencyKey
  return typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey : null
}

function clearClientActionDispatchState(commandContext: unknown): Record<string, unknown> {
  const base = isRecord(commandContext) ? { ...commandContext } : {}

  return removeUndefined({
    ...base,
    pendingClientAction: undefined,
    resumeClientActionResult: undefined,
    resumeCommandIdempotencyKey: undefined,
  })
}

function clearResumeClientActionResult(commandContext: unknown): Record<string, unknown> {
  const base = isRecord(commandContext) ? { ...commandContext } : {}

  return removeUndefined({
    ...base,
    resumeClientActionResult: undefined,
    resumeCommandIdempotencyKey: undefined,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return removeUndefined(value) as Prisma.InputJsonObject
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}

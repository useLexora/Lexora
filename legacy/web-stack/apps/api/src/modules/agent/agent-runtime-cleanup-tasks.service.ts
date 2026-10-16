import type { AgentRuntimeControlResult } from '@haohaoxue/lexora-contracts'
import type Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import {
  AGENT_QUEUE_NAME,
  AGENT_RUNTIME_CONTROL_RESULT_TYPE,
  AGENT_RUNTIME_CONTROL_TYPE,
  AgentRuntimeControlResultSchema,
} from '@haohaoxue/lexora-contracts'
import { buildAgentChatThreadId, sleep } from '@haohaoxue/lexora-shared'
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import { AgentRuntimeCleanupTaskStatus } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { RedisService } from '../../infrastructure/redis/redis.service'
import { AgentCommandPublisherService } from './agent-command-publisher.service'

const CHAT_SESSION_CLEANUP_SCOPE = 'chat_session'
const DISPATCH_INTERVAL_MS = 5_000
const DISPATCH_BATCH_SIZE = 10
const CONTROL_LEASE_MS = 60_000
const CONTROL_RESULT_FIELD = 'result'
const CONTROL_RESULT_READ_BLOCK_MS = 1_000
const CONTROL_RESULT_READ_COUNT = 20
const CONTROL_RESULT_GROUP_NAME = 'lexora-api'
const CONTROL_RESULT_CONSUMER_NAME = `api-${process.pid}`
const PENDING_RESULT_STREAM_ID = '0'
const NEW_RESULT_STREAM_ID = '>'
const MIN_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 5 * 60_000
const MAX_CLEANUP_TASK_ATTEMPTS = 12

type RedisStreamMessage = [string, string[]]
type RedisStreamReadResult = Array<[string, RedisStreamMessage[]]>

@Injectable()
export class AgentRuntimeCleanupTasksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRuntimeCleanupTasksService.name)
  private dispatchTimer: ReturnType<typeof setInterval> | null = null
  private dispatching = false
  private resultRedis: Redis | null = null
  private resultConsumerRunning = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly agentCommandPublisher: AgentCommandPublisherService,
  ) {}

  onModuleInit(): void {
    this.dispatchTimer = setInterval(() => {
      void this.dispatchPendingTasks().catch(error => this.logger.error(
        error instanceof Error ? error.message : 'dispatch agent cleanup tasks failed',
        error instanceof Error ? error.stack : undefined,
      ))
    }, DISPATCH_INTERVAL_MS)

    this.resultConsumerRunning = true
    this.resultRedis = this.redisService.createClient()
    void this.consumeControlResults(this.resultRedis).catch(error => this.logger.error(
      error instanceof Error ? error.message : 'consume agent cleanup control results failed',
      error instanceof Error ? error.stack : undefined,
    ))
  }

  async onModuleDestroy(): Promise<void> {
    this.resultConsumerRunning = false

    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer)
      this.dispatchTimer = null
    }

    if (!this.resultRedis) {
      return
    }

    try {
      await this.resultRedis.quit()
    }
    catch {
      this.resultRedis.disconnect()
    }
    finally {
      this.resultRedis = null
    }
  }

  async enqueueChatSessionCheckpointCleanup(input: {
    sessionId: string
    initialDelayMs?: number
  }): Promise<void> {
    const threadId = buildAgentChatThreadId(input.sessionId)
    const nextAttemptAt = new Date(Date.now() + (input.initialDelayMs ?? 0))

    await this.prisma.agentRuntimeCleanupTask.upsert({
      where: {
        scope_resourceId_threadId: {
          scope: CHAT_SESSION_CLEANUP_SCOPE,
          resourceId: input.sessionId,
          threadId,
        },
      },
      create: {
        scope: CHAT_SESSION_CLEANUP_SCOPE,
        resourceId: input.sessionId,
        threadId,
        nextAttemptAt,
      },
      update: {
        status: AgentRuntimeCleanupTaskStatus.PENDING,
        lastError: null,
        nextAttemptAt,
        controlId: null,
        controlPublishedAt: null,
        controlLeaseExpiresAt: null,
        completedAt: null,
      },
    })

    void this.dispatchPendingTasks().catch(error => this.logger.error(
      error instanceof Error ? error.message : `dispatch chat cleanup task failed: session=${input.sessionId}`,
      error instanceof Error ? error.stack : undefined,
    ))
  }

  async dispatchPendingTasks(): Promise<void> {
    if (this.dispatching) {
      return
    }

    this.dispatching = true
    try {
      const now = new Date()
      const tasks = await this.prisma.agentRuntimeCleanupTask.findMany({
        where: {
          OR: [
            {
              status: {
                in: [
                  AgentRuntimeCleanupTaskStatus.PENDING,
                  AgentRuntimeCleanupTaskStatus.FAILED,
                ],
              },
              attempts: {
                lt: MAX_CLEANUP_TASK_ATTEMPTS,
              },
              nextAttemptAt: {
                lte: now,
              },
            },
            {
              status: AgentRuntimeCleanupTaskStatus.DISPATCHED,
              attempts: {
                lt: MAX_CLEANUP_TASK_ATTEMPTS,
              },
              controlLeaseExpiresAt: {
                lt: now,
              },
            },
          ],
        },
        select: {
          id: true,
        },
        orderBy: {
          updatedAt: 'asc',
        },
        take: DISPATCH_BATCH_SIZE,
      })

      for (const task of tasks) {
        await this.dispatchTask(task.id)
      }
    }
    finally {
      this.dispatching = false
    }
  }

  private async dispatchTask(taskId: string): Promise<void> {
    const now = new Date()
    const controlId = randomUUID()
    const controlLeaseExpiresAt = new Date(now.getTime() + CONTROL_LEASE_MS)
    const claimed = await this.prisma.agentRuntimeCleanupTask.updateMany({
      where: {
        id: taskId,
        OR: [
          {
            status: {
              in: [
                AgentRuntimeCleanupTaskStatus.PENDING,
                AgentRuntimeCleanupTaskStatus.FAILED,
              ],
            },
            attempts: {
              lt: MAX_CLEANUP_TASK_ATTEMPTS,
            },
            nextAttemptAt: {
              lte: now,
            },
          },
          {
            status: AgentRuntimeCleanupTaskStatus.DISPATCHED,
            attempts: {
              lt: MAX_CLEANUP_TASK_ATTEMPTS,
            },
            controlLeaseExpiresAt: {
              lt: now,
            },
          },
        ],
      },
      data: {
        status: AgentRuntimeCleanupTaskStatus.DISPATCHED,
        attempts: {
          increment: 1,
        },
        controlId,
        controlPublishedAt: now,
        controlLeaseExpiresAt,
        lastError: null,
      },
    })

    if (claimed.count === 0) {
      return
    }

    const task = await this.prisma.agentRuntimeCleanupTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        threadId: true,
        attempts: true,
      },
    })

    if (!task) {
      return
    }

    try {
      await this.agentCommandPublisher.publishRuntimeControl({
        controlId,
        type: AGENT_RUNTIME_CONTROL_TYPE.DELETE_CHECKPOINT_THREAD,
        cleanupTaskId: task.id,
        threadId: task.threadId,
        reason: 'chat_session_deleted',
      })
    }
    catch (error) {
      await this.markTaskFailed({
        taskId,
        controlId,
        attempts: task.attempts,
        message: error instanceof Error ? error.message : '发布 checkpoint 清理命令失败',
      })
    }
  }

  private async markTaskFailed(input: {
    taskId: string
    controlId: string
    attempts: number
    message: string
  }): Promise<void> {
    await this.prisma.agentRuntimeCleanupTask.updateMany({
      where: {
        id: input.taskId,
        controlId: input.controlId,
        status: AgentRuntimeCleanupTaskStatus.DISPATCHED,
      },
      data: {
        status: AgentRuntimeCleanupTaskStatus.FAILED,
        lastError: input.message,
        nextAttemptAt: getNextAttemptAt(input.attempts),
        controlLeaseExpiresAt: null,
      },
    })
  }

  private async consumeControlResults(redis: Redis): Promise<void> {
    await ensureControlResultConsumerGroup(redis)

    while (this.resultConsumerRunning) {
      const result = await readControlResultBatch(redis, PENDING_RESULT_STREAM_ID, false).catch(async (error) => {
        if (this.resultConsumerRunning) {
          this.logger.warn(error instanceof Error ? error.message : 'read agent cleanup control results failed')
          await sleep(CONTROL_RESULT_READ_BLOCK_MS)
        }

        return null
      })

      const nextResult = result?.length
        ? result
        : await readControlResultBatch(redis, NEW_RESULT_STREAM_ID, true).catch(async (error) => {
            if (this.resultConsumerRunning) {
              this.logger.warn(error instanceof Error ? error.message : 'read agent cleanup control results failed')
              await sleep(CONTROL_RESULT_READ_BLOCK_MS)
            }

            return null
          })

      if (!nextResult?.length) {
        continue
      }

      for (const [, messages] of nextResult) {
        for (const [messageId, fields] of messages) {
          await this.handleControlResultMessage(redis, messageId, fields)
        }
      }
    }
  }

  private async handleControlResultMessage(redis: Redis, messageId: string, fields: string[]): Promise<void> {
    const controlResult = parseControlResult(fields)
    if (!controlResult) {
      await redis.xack(AGENT_QUEUE_NAME.CONTROL_RESULTS, CONTROL_RESULT_GROUP_NAME, messageId)
      return
    }

    await this.applyControlResult(controlResult)
    await redis.xack(AGENT_QUEUE_NAME.CONTROL_RESULTS, CONTROL_RESULT_GROUP_NAME, messageId)
  }

  private async applyControlResult(result: AgentRuntimeControlResult): Promise<void> {
    if (result.type === AGENT_RUNTIME_CONTROL_RESULT_TYPE.CHECKPOINT_THREAD_DELETE_COMPLETED) {
      await this.prisma.agentRuntimeCleanupTask.updateMany({
        where: {
          id: result.cleanupTaskId,
          controlId: result.controlId,
          threadId: result.threadId,
          status: AgentRuntimeCleanupTaskStatus.DISPATCHED,
        },
        data: {
          status: AgentRuntimeCleanupTaskStatus.COMPLETED,
          completedAt: new Date(),
          lastError: null,
          controlLeaseExpiresAt: null,
        },
      })
      return
    }

    const task = await this.prisma.agentRuntimeCleanupTask.findFirst({
      where: {
        id: result.cleanupTaskId,
        controlId: result.controlId,
        threadId: result.threadId,
        status: AgentRuntimeCleanupTaskStatus.DISPATCHED,
      },
      select: {
        attempts: true,
      },
    })

    if (!task) {
      return
    }

    await this.markTaskFailed({
      taskId: result.cleanupTaskId,
      controlId: result.controlId,
      attempts: task.attempts,
      message: result.errorMessage,
    })
  }
}

async function ensureControlResultConsumerGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup('CREATE', AGENT_QUEUE_NAME.CONTROL_RESULTS, CONTROL_RESULT_GROUP_NAME, '0', 'MKSTREAM')
  }
  catch (error) {
    if (!isBusyGroupError(error)) {
      throw error
    }
  }
}

function readControlResultBatch(redis: Redis, streamId: string, block: boolean): Promise<RedisStreamReadResult | null> {
  if (block) {
    return redis.xreadgroup(
      'GROUP',
      CONTROL_RESULT_GROUP_NAME,
      CONTROL_RESULT_CONSUMER_NAME,
      'COUNT',
      CONTROL_RESULT_READ_COUNT,
      'BLOCK',
      CONTROL_RESULT_READ_BLOCK_MS,
      'STREAMS',
      AGENT_QUEUE_NAME.CONTROL_RESULTS,
      streamId,
    ) as Promise<RedisStreamReadResult | null>
  }

  return redis.xreadgroup(
    'GROUP',
    CONTROL_RESULT_GROUP_NAME,
    CONTROL_RESULT_CONSUMER_NAME,
    'COUNT',
    CONTROL_RESULT_READ_COUNT,
    'STREAMS',
    AGENT_QUEUE_NAME.CONTROL_RESULTS,
    streamId,
  ) as Promise<RedisStreamReadResult | null>
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('BUSYGROUP')
}

function parseControlResult(fields: string[]): AgentRuntimeControlResult | null {
  const rawResult = getStreamField(fields, CONTROL_RESULT_FIELD)
  if (!rawResult) {
    return null
  }

  try {
    return AgentRuntimeControlResultSchema.parse(JSON.parse(rawResult))
  }
  catch {
    return null
  }
}

function getStreamField(fields: string[], fieldName: string): string | null {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === fieldName) {
      return fields[index + 1] ?? null
    }
  }

  return null
}

function getNextAttemptAt(attempts: number): Date {
  const delayMs = Math.min(
    MAX_RETRY_DELAY_MS,
    MIN_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1),
  )

  return new Date(Date.now() + delayMs)
}

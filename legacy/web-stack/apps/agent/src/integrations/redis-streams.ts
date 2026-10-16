import type { AgentIdempotencyStore } from '../runtime/command'
import type {
  AgentCommandHandler,
  AgentCommandQueue,
  AgentControlHandler,
  AgentControlResultPublisher,
  AgentEventPublisher,
  AgentQueueCommand,
  AgentRuntimeControlCommand,
  AgentRuntimeControlResult,
  ChatGenerationEvent,
} from '../runtime/typing'
import type { AgentRedisClient, RedisCommandArgument, RedisStreamReadResult } from './redis-client'
import process from 'node:process'
import {
  AGENT_QUEUE_NAME,
  AgentGenerationCommandSchema,
  AgentRuntimeControlCommandSchema,
  AgentRuntimeControlResultSchema,
  ChatGenerationEventSchema,
} from '@haohaoxue/lexora-contracts'
import { sleepUnref } from '@haohaoxue/lexora-shared'

const DEFAULT_GROUP_NAME = 'lexora-agent'
const DEFAULT_CONSUMER_NAME = `agent-${process.pid}`
const DEFAULT_READ_COUNT = 10
const DEFAULT_READ_BLOCK_MS = 1000
const DEFAULT_MAX_ATTEMPTS = 1
const COMMAND_FIELD = 'command'
const CONTROL_FIELD = 'control'
const CONTROL_RESULT_FIELD = 'result'
const EVENT_FIELD = 'event'
const DEFAULT_IDEMPOTENCY_KEY_PREFIX = 'lexora:agent:idempotency:'
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

export interface CreateRedisStreamsAgentQueueOptions {
  /** command stream 的 Redis 客户端 */
  redis: AgentRedisClient
  /** control stream 的 Redis 客户端 */
  controlRedis?: AgentRedisClient
  /** 单个 agent 实例同时执行的 generation 数量。 */
  maxConcurrentRuns: number
  onError?: RedisStreamsAgentQueueErrorHandler
}

export interface RedisStreamsAgentQueueErrorContext {
  streamName: string
  messageId: string
}

export type RedisStreamsAgentQueueErrorHandler = (
  error: unknown,
  context: RedisStreamsAgentQueueErrorContext,
) => void

export interface CreateRedisStreamsAgentEventPublisherOptions {
  /** Redis 客户端 */
  redis: AgentRedisClient
}

export interface CreateRedisStreamsAgentControlResultPublisherOptions {
  /** Redis 客户端 */
  redis: AgentRedisClient
}

export interface CreateRedisAgentIdempotencyStoreOptions {
  /** Redis 客户端 */
  redis: AgentRedisClient
  /** 幂等键前缀 */
  keyPrefix?: string
  /** 幂等键保留时长，覆盖 API 侧 lease 重发窗口即可 */
  ttlSeconds?: number
}

export function createRedisAgentIdempotencyStore(
  options: CreateRedisAgentIdempotencyStoreOptions,
): AgentIdempotencyStore {
  const keyPrefix = options.keyPrefix ?? DEFAULT_IDEMPOTENCY_KEY_PREFIX
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS

  return {
    async markStarted(idempotencyKey) {
      const result = await options.redis.set(
        `${keyPrefix}${idempotencyKey}`,
        '1',
        'EX',
        ttlSeconds,
        'NX',
      )

      return result === 'OK'
    },

    async has(idempotencyKey) {
      return await options.redis.get(`${keyPrefix}${idempotencyKey}`) !== null
    },

    async clear(idempotencyKey) {
      await options.redis.del(`${keyPrefix}${idempotencyKey}`)
    },
  }
}

export function createRedisStreamsAgentQueue(options: CreateRedisStreamsAgentQueueOptions): AgentCommandQueue {
  const redis = options.redis
  const controlRedis = options.controlRedis ?? redis
  const groupName = DEFAULT_GROUP_NAME
  const consumerName = DEFAULT_CONSUMER_NAME
  const readCount = DEFAULT_READ_COUNT
  const readBlockMs = DEFAULT_READ_BLOCK_MS
  const maxAttempts = DEFAULT_MAX_ATTEMPTS
  const maxConcurrentRuns = options.maxConcurrentRuns
  const inFlightMessages = new Set<Promise<void>>()
  const inFlightMessageIds = new Set<string>()
  let handler: AgentCommandHandler | null = null
  let controlHandler: AgentControlHandler | null = null
  let running = false
  let controlRunning = false
  let closed = false

  async function ready(): Promise<void> {
    await ensureConsumerGroup(redis, groupName, AGENT_QUEUE_NAME.COMMANDS)
    await ensureConsumerGroup(controlRedis, groupName, AGENT_QUEUE_NAME.CONTROLS)
  }

  function subscribe(nextHandler: AgentCommandHandler): () => void {
    handler = nextHandler

    if (!running) {
      running = true
      void consumeLoop()
    }

    return () => {
      handler = null
      running = false
    }
  }

  function subscribeControl(nextHandler: AgentControlHandler): () => void {
    controlHandler = nextHandler

    if (!controlRunning) {
      controlRunning = true
      void consumeControlLoop()
    }

    return () => {
      controlHandler = null
      controlRunning = false
    }
  }

  async function close(): Promise<void> {
    running = false
    controlRunning = false
    closed = true
    await waitForInFlightMessages()
    await Promise.allSettled([
      redis.quit(),
      controlRedis === redis ? Promise.resolve() : controlRedis.quit(),
    ])
  }

  async function consumeLoop(): Promise<void> {
    await ready()

    while (true) {
      if (closed || !running) {
        return
      }

      try {
        const handledPending = await readBatch('0', false)

        if (handledPending) {
          continue
        }

        const handledNew = await readBatch('>', canBlockCommandRead())

        if (!handledNew) {
          await sleepUnref(readBlockMs)
        }
      }
      catch {
        if (closed || !running) {
          return
        }

        await sleepUnref(readBlockMs)
      }
    }
  }

  async function readBatch(streamId: string, block: boolean): Promise<boolean> {
    await waitForCommandSlot()

    const currentHandler = handler
    if (!currentHandler) {
      return false
    }

    const availableSlots = getAvailableCommandSlots()
    if (availableSlots <= 0) {
      return false
    }

    const result = await readCommandBatch(redis, {
      groupName,
      consumerName,
      readCount: Math.min(readCount, availableSlots),
      readBlockMs,
      streamId,
      block,
    })

    if (!result?.length) {
      return false
    }

    let handledMessage = false

    for (const [, messages] of result) {
      for (const [messageId, fields] of messages) {
        if (inFlightMessageIds.has(messageId)) {
          continue
        }

        handledMessage = true
        trackInFlightMessage(messageId, () => handleMessage(messageId, fields, currentHandler))
      }
    }

    return handledMessage
  }

  async function waitForCommandSlot(): Promise<void> {
    while (getAvailableCommandSlots() <= 0) {
      if (closed || !running) {
        return
      }

      await Promise.race(inFlightMessages)
    }
  }

  function getAvailableCommandSlots(): number {
    return maxConcurrentRuns - inFlightMessages.size
  }

  function canBlockCommandRead(): boolean {
    return inFlightMessages.size === 0
  }

  function trackInFlightMessage(messageId: string, task: () => Promise<void>): void {
    inFlightMessageIds.add(messageId)

    const trackedTask = Promise.resolve()
      .then(task)
      .catch((error) => {
        reportCommandTaskError(error, messageId)
      })
      .finally(() => {
        inFlightMessages.delete(trackedTask)
        inFlightMessageIds.delete(messageId)
      })

    inFlightMessages.add(trackedTask)
  }

  async function waitForInFlightMessages(): Promise<void> {
    while (inFlightMessages.size > 0) {
      await Promise.allSettled([...inFlightMessages])
    }
  }

  function reportCommandTaskError(error: unknown, messageId: string): void {
    try {
      options.onError?.(error, {
        streamName: AGENT_QUEUE_NAME.COMMANDS,
        messageId,
      })
    }
    catch {}
  }

  async function consumeControlLoop(): Promise<void> {
    await ready()

    while (true) {
      if (closed || !controlRunning) {
        return
      }

      try {
        const handledPending = await readControlBatch('0', false)

        if (handledPending) {
          continue
        }

        const handledNew = await readControlBatch('>', true)

        if (!handledNew) {
          await sleepUnref(readBlockMs)
        }
      }
      catch {
        if (closed || !controlRunning) {
          return
        }

        await sleepUnref(readBlockMs)
      }
    }
  }

  async function readControlBatch(streamId: string, block: boolean): Promise<boolean> {
    const result = await readAgentControlBatch(controlRedis, {
      groupName,
      consumerName,
      readCount,
      readBlockMs,
      streamId,
      block,
    })

    if (!result?.length) {
      return false
    }

    const currentHandler = controlHandler
    if (!currentHandler) {
      return false
    }

    let handledMessage = false

    for (const [, messages] of result) {
      for (const [messageId, fields] of messages) {
        handledMessage = true
        await handleControlMessage(messageId, fields, currentHandler)
      }
    }

    return handledMessage
  }

  async function handleMessage(
    messageId: string,
    fields: string[],
    currentHandler: AgentCommandHandler,
  ): Promise<void> {
    const rawCommand = getStreamField(fields, COMMAND_FIELD)

    if (!rawCommand) {
      await publishDeadLetter(redis, {
        messageId,
        command: null,
        errorMessage: 'command 字段缺失',
        attempts: 0,
      })
      await redis.xack(AGENT_QUEUE_NAME.COMMANDS, groupName, messageId)
      return
    }

    const command = parseCommand(rawCommand)
    if (!command.ok) {
      await publishDeadLetter(redis, {
        messageId,
        command: null,
        errorMessage: command.errorMessage,
        attempts: 0,
      })
      await redis.xack(AGENT_QUEUE_NAME.COMMANDS, groupName, messageId)
      return
    }

    let lastErrorMessage = 'Agent command failed'

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await currentHandler(command.value)
      }
      catch (error) {
        lastErrorMessage = getErrorMessage(error)
        continue
      }

      await redis.xack(AGENT_QUEUE_NAME.COMMANDS, groupName, messageId)
      return
    }

    await publishDeadLetter(redis, {
      messageId,
      command: command.value,
      errorMessage: lastErrorMessage,
      attempts: maxAttempts,
    })
    await redis.xack(AGENT_QUEUE_NAME.COMMANDS, groupName, messageId)
  }

  async function handleControlMessage(
    messageId: string,
    fields: string[],
    currentHandler: AgentControlHandler,
  ): Promise<void> {
    const rawControl = getStreamField(fields, CONTROL_FIELD)

    if (!rawControl) {
      await controlRedis.xack(AGENT_QUEUE_NAME.CONTROLS, groupName, messageId)
      return
    }

    const control = parseControl(rawControl)
    if (!control.ok) {
      await controlRedis.xack(AGENT_QUEUE_NAME.CONTROLS, groupName, messageId)
      return
    }

    await currentHandler(control.value)
    await controlRedis.xack(AGENT_QUEUE_NAME.CONTROLS, groupName, messageId)
  }

  return {
    async publish(command) {
      await publishCommand(redis, command)
    },
    async publishControl(control) {
      await publishControl(controlRedis, control)
    },
    subscribe,
    subscribeControl,
    ready,
    close,
  }
}

export function createRedisStreamsAgentEventPublisher(
  options: CreateRedisStreamsAgentEventPublisherOptions,
): AgentEventPublisher {
  const redis = options.redis

  return {
    async publish(event) {
      await publishEvent(redis, event)
    },

    async close() {
      await redis.quit()
    },
  }
}

export function createRedisStreamsAgentControlResultPublisher(
  options: CreateRedisStreamsAgentControlResultPublisherOptions,
): AgentControlResultPublisher {
  const redis = options.redis

  return {
    async publish(result) {
      await publishControlResult(redis, result)
    },
  }
}

async function ensureConsumerGroup(
  redis: AgentRedisClient,
  groupName: string,
  streamName: string,
): Promise<void> {
  try {
    await redis.xgroup('CREATE', streamName, groupName, '0', 'MKSTREAM')
  }
  catch (error) {
    if (!isBusyGroupError(error)) {
      throw error
    }
  }
}

function readAgentControlBatch(
  redis: AgentRedisClient,
  options: {
    groupName: string
    consumerName: string
    readCount: number
    readBlockMs: number
    streamId: string
    block: boolean
  },
): Promise<RedisStreamReadResult | null> {
  const baseArgs: RedisCommandArgument[] = [
    'GROUP',
    options.groupName,
    options.consumerName,
    'COUNT',
    options.readCount,
  ]

  if (options.block) {
    baseArgs.push('BLOCK', options.readBlockMs)
  }

  return redis.xreadgroup(
    ...baseArgs,
    'STREAMS',
    AGENT_QUEUE_NAME.CONTROLS,
    options.streamId,
  )
}

function readCommandBatch(
  redis: AgentRedisClient,
  options: {
    groupName: string
    consumerName: string
    readCount: number
    readBlockMs: number
    streamId: string
    block: boolean
  },
): Promise<RedisStreamReadResult | null> {
  const baseArgs: RedisCommandArgument[] = [
    'GROUP',
    options.groupName,
    options.consumerName,
    'COUNT',
    options.readCount,
  ]

  if (options.block) {
    baseArgs.push('BLOCK', options.readBlockMs)
  }

  return redis.xreadgroup(
    ...baseArgs,
    'STREAMS',
    AGENT_QUEUE_NAME.COMMANDS,
    options.streamId,
  )
}

function publishCommand(redis: AgentRedisClient, command: AgentQueueCommand): Promise<string> {
  const normalizedCommand = parseQueueCommand(command)

  return redis.xadd(
    AGENT_QUEUE_NAME.COMMANDS,
    '*',
    COMMAND_FIELD,
    JSON.stringify(normalizedCommand),
  )
}

function publishControl(redis: AgentRedisClient, control: AgentRuntimeControlCommand): Promise<string> {
  const normalizedControl = AgentRuntimeControlCommandSchema.parse(control)

  return redis.xadd(
    AGENT_QUEUE_NAME.CONTROLS,
    '*',
    CONTROL_FIELD,
    JSON.stringify(normalizedControl),
  )
}

function publishControlResult(redis: AgentRedisClient, result: AgentRuntimeControlResult): Promise<string> {
  const normalizedResult = AgentRuntimeControlResultSchema.parse(result)

  return redis.xadd(
    AGENT_QUEUE_NAME.CONTROL_RESULTS,
    '*',
    CONTROL_RESULT_FIELD,
    JSON.stringify(normalizedResult),
  )
}

function publishEvent(redis: AgentRedisClient, event: ChatGenerationEvent): Promise<string> {
  const normalizedEvent = ChatGenerationEventSchema.parse(event)

  return redis.xadd(
    AGENT_QUEUE_NAME.EVENTS,
    '*',
    EVENT_FIELD,
    JSON.stringify(normalizedEvent),
  )
}

function publishDeadLetter(
  redis: AgentRedisClient,
  options: {
    messageId: string
    command: AgentQueueCommand | null
    errorMessage: string
    attempts: number
  },
): Promise<string> {
  const summary = createDeadLetterCommandSummary(options.command)

  return redis.xadd(
    AGENT_QUEUE_NAME.DEAD_LETTER,
    '*',
    'originalId',
    options.messageId,
    'commandKind',
    summary.commandKind,
    ...toRedisFieldPairs(summary.fields),
    'error',
    options.errorMessage,
    'attempts',
    String(options.attempts),
  )
}

function createDeadLetterCommandSummary(command: AgentQueueCommand | null): {
  commandKind: string
  fields: Record<string, string | undefined>
} {
  if (!command) {
    return {
      commandKind: 'unknown',
      fields: {},
    }
  }

  return {
    commandKind: 'generation',
    fields: {
      commandId: command.commandId,
      generationId: command.generationId,
    },
  }
}

function toRedisFieldPairs(fields: Record<string, string | undefined>): string[] {
  return Object.entries(fields).flatMap(([key, value]) => value ? [key, value] : [])
}

function getStreamField(fields: string[], fieldName: string): string | null {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === fieldName) {
      return fields[index + 1] ?? null
    }
  }

  return null
}

function parseCommand(rawCommand: string): { ok: true, value: AgentQueueCommand } | { ok: false, errorMessage: string } {
  try {
    return {
      ok: true,
      value: parseQueueCommand(JSON.parse(rawCommand)),
    }
  }
  catch (error) {
    return {
      ok: false,
      errorMessage: getErrorMessage(error),
    }
  }
}

function parseQueueCommand(value: unknown): AgentQueueCommand {
  return AgentGenerationCommandSchema.parse(value)
}

function parseControl(rawControl: string): { ok: true, value: AgentRuntimeControlCommand } | { ok: false, errorMessage: string } {
  try {
    return {
      ok: true,
      value: AgentRuntimeControlCommandSchema.parse(JSON.parse(rawControl)),
    }
  }
  catch (error) {
    return {
      ok: false,
      errorMessage: getErrorMessage(error),
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('BUSYGROUP')
}

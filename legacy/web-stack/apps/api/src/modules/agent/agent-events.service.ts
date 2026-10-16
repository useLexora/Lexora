import type { ChatGenerationEvent } from '@haohaoxue/lexora-contracts'
import type Redis from 'ioredis'
import { AGENT_QUEUE_NAME, ChatGenerationEventSchema } from '@haohaoxue/lexora-contracts'
import { Injectable } from '@nestjs/common'
import { RedisService } from '../../infrastructure/redis/redis.service'

const EVENT_FIELD = 'event'
const DEFAULT_READ_COUNT = 20
const DEFAULT_READ_BLOCK_MS = 1000
const DEFAULT_GENERATION_TIMEOUT_MS = 10 * 60_000
const EMPTY_STREAM_ID = '0-0'

export type AgentGenerationEventFailureReason = 'failed' | 'cancelled' | 'timed_out'

type RedisStreamMessage = [string, string[]]
type RedisStreamReadResult = Array<[string, RedisStreamMessage[]]>

export interface ConsumeAgentGenerationEventsInput {
  generationId: string
  afterId: string
  timeoutMs?: number
  signal?: AbortSignal
  messages?: AgentGenerationEventConsumerMessages
  onEvent: (event: ChatGenerationEvent, sourceEventId: string) => void | Promise<void>
}

export interface AgentGenerationEventConsumerMessages {
  aborted?: string
  cancelled?: string
  timedOut?: string
  failed?: string
}

export class AgentGenerationEventsConsumerError extends Error {
  constructor(
    message: string,
    readonly reason: AgentGenerationEventFailureReason,
  ) {
    super(message)
    this.name = 'AgentGenerationEventsConsumerError'
  }
}

@Injectable()
export class AgentGenerationEventsService {
  constructor(private readonly redisService: RedisService) {}

  async getLatestEventStreamId(): Promise<string> {
    const result = await this.redisService.getClient().xrevrange(
      AGENT_QUEUE_NAME.EVENTS,
      '+',
      '-',
      'COUNT',
      1,
    ) as Array<[string, string[]]>

    return result[0]?.[0] ?? EMPTY_STREAM_ID
  }

  async consumeGenerationEvents(input: ConsumeAgentGenerationEventsInput): Promise<void> {
    const redis = this.redisService.createClient()

    try {
      await this.consumeGenerationEventsWithClient(redis, input)
    }
    finally {
      await closeRedis(redis)
    }
  }

  private async consumeGenerationEventsWithClient(
    redis: Redis,
    input: ConsumeAgentGenerationEventsInput,
  ): Promise<void> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
    const deadlineAt = Date.now() + timeoutMs
    const messages = normalizeMessages(input.messages)
    let lastId = input.afterId

    while (Date.now() < deadlineAt) {
      if (input.signal?.aborted) {
        throw new AgentGenerationEventsConsumerError(messages.aborted, 'cancelled')
      }

      const remainingMs = Math.max(1, deadlineAt - Date.now())
      const result = await readNextBatch(redis, lastId, Math.min(DEFAULT_READ_BLOCK_MS, remainingMs))

      if (!result?.length) {
        continue
      }

      for (const [, streamMessages] of result) {
        for (const [messageId, fields] of streamMessages) {
          lastId = messageId
          const event = parseEvent(fields)

          if (!event || event.generationId !== input.generationId) {
            continue
          }

          await input.onEvent(event, messageId)

          if (event.type === 'generation.completed') {
            return
          }

          if (event.type === 'generation.client_action.required') {
            return
          }

          if (event.type === 'generation.failed') {
            throw new AgentGenerationEventsConsumerError(getFailureMessage(event, messages.failed), 'failed')
          }

          if (event.type === 'generation.cancelled') {
            throw new AgentGenerationEventsConsumerError(getFailureMessage(event, messages.cancelled), 'cancelled')
          }
        }
      }
    }

    throw new AgentGenerationEventsConsumerError(messages.timedOut, 'timed_out')
  }
}

function readNextBatch(
  redis: Redis,
  afterId: string,
  blockMs: number,
): Promise<RedisStreamReadResult | null> {
  return redis.xread(
    'COUNT',
    DEFAULT_READ_COUNT,
    'BLOCK',
    blockMs,
    'STREAMS',
    AGENT_QUEUE_NAME.EVENTS,
    afterId,
  ) as Promise<RedisStreamReadResult | null>
}

function parseEvent(fields: string[]): ChatGenerationEvent | null {
  const rawEvent = getStreamField(fields, EVENT_FIELD)
  if (!rawEvent) {
    return null
  }

  try {
    return ChatGenerationEventSchema.parse(JSON.parse(rawEvent))
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

export function getChatGenerationEventText(event: ChatGenerationEvent): string | null {
  if (!event.payload || typeof event.payload !== 'object') {
    return null
  }

  const text = (event.payload as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

function getFailureMessage(event: ChatGenerationEvent, fallback: string): string {
  if (event.payload && typeof event.payload === 'object') {
    const message = (event.payload as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) {
      return message.trim()
    }
  }

  return fallback
}

function normalizeMessages(messages: AgentGenerationEventConsumerMessages = {}): Required<AgentGenerationEventConsumerMessages> {
  return {
    aborted: messages.aborted ?? 'Agent 请求已取消',
    cancelled: messages.cancelled ?? 'Agent 运行已取消',
    timedOut: messages.timedOut ?? '等待 Agent 运行结果超时',
    failed: messages.failed ?? 'Agent 运行失败',
  }
}

async function closeRedis(redis: Redis): Promise<void> {
  try {
    await redis.quit()
  }
  catch {
    redis.disconnect()
  }
}

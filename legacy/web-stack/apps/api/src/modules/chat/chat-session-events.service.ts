import type {
  ChatSessionEvent,
  ChatSessionEventType,
} from '@haohaoxue/lexora-contracts'
import {
  CHAT_SESSION_EVENT_TYPE,
  ChatSessionEventSchema,
} from '@haohaoxue/lexora-contracts'
import { Injectable } from '@nestjs/common'
import {
  Prisma,
  ChatSessionEventType as PrismaChatSessionEventType,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'

type ChatEventTransaction = Prisma.TransactionClient

export interface ChatSessionEventDraft {
  type: ChatSessionEventType
  messageId?: string | null
  runId?: string | null
  sourceEventId?: string | null
  payload?: Prisma.InputJsonObject
}

interface PersistedChatSessionEvent {
  sequence: number
  sessionId: string
  type: PrismaChatSessionEventType
  messageId: string | null
  runId: string | null
  sourceEventId: string | null
  payload: unknown
  createdAt: Date
}

const eventTypeToPrisma = {
  [CHAT_SESSION_EVENT_TYPE.MESSAGE_CREATED]: PrismaChatSessionEventType.MESSAGE_CREATED,
  [CHAT_SESSION_EVENT_TYPE.MESSAGE_STATUS_CHANGED]: PrismaChatSessionEventType.MESSAGE_STATUS_CHANGED,
  [CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA]: PrismaChatSessionEventType.MESSAGE_PART_DELTA,
  [CHAT_SESSION_EVENT_TYPE.MESSAGE_COMPLETED]: PrismaChatSessionEventType.MESSAGE_COMPLETED,
  [CHAT_SESSION_EVENT_TYPE.MESSAGE_FAILED]: PrismaChatSessionEventType.MESSAGE_FAILED,
  [CHAT_SESSION_EVENT_TYPE.MESSAGE_CANCELLED]: PrismaChatSessionEventType.MESSAGE_CANCELLED,
  [CHAT_SESSION_EVENT_TYPE.RUN_STARTED]: PrismaChatSessionEventType.RUN_STARTED,
  [CHAT_SESSION_EVENT_TYPE.RUN_REQUIRES_ACTION]: PrismaChatSessionEventType.RUN_REQUIRES_ACTION,
  [CHAT_SESSION_EVENT_TYPE.RUN_COMPLETED]: PrismaChatSessionEventType.RUN_COMPLETED,
  [CHAT_SESSION_EVENT_TYPE.RUN_FAILED]: PrismaChatSessionEventType.RUN_FAILED,
  [CHAT_SESSION_EVENT_TYPE.RUN_CANCELLED]: PrismaChatSessionEventType.RUN_CANCELLED,
  [CHAT_SESSION_EVENT_TYPE.BRANCH_SWITCHED]: PrismaChatSessionEventType.BRANCH_SWITCHED,
  [CHAT_SESSION_EVENT_TYPE.TITLE_UPDATED]: PrismaChatSessionEventType.TITLE_UPDATED,
  [CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED]: PrismaChatSessionEventType.SNAPSHOT_REQUIRED,
} satisfies Record<ChatSessionEventType, PrismaChatSessionEventType>

const eventTypeFromPrisma = Object.fromEntries(
  Object.entries(eventTypeToPrisma).map(([contractType, prismaType]) => [prismaType, contractType]),
) as Record<PrismaChatSessionEventType, ChatSessionEventType>

@Injectable()
export class ChatSessionEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async appendEvents(
    tx: ChatEventTransaction,
    sessionId: string,
    events: ChatSessionEventDraft[],
  ): Promise<number> {
    if (events.length === 0) {
      return this.getLatestSequence(sessionId)
    }

    const rows = await tx.$queryRaw<Array<{ nextEventSequence: number }>>`
      UPDATE "ChatSession"
      SET "nextEventSequence" = "nextEventSequence" + ${events.length}
      WHERE "id" = ${sessionId}
      RETURNING "nextEventSequence"
    `
    const nextEventSequence = rows[0]?.nextEventSequence

    if (typeof nextEventSequence !== 'number') {
      throw new TypeError('聊天会话不存在')
    }

    const latestSequence = nextEventSequence - 1
    const firstSequence = latestSequence - events.length + 1

    await tx.chatSessionEvent.createMany({
      data: events.map((event, index) => ({
        sessionId,
        sequence: firstSequence + index,
        type: eventTypeToPrisma[event.type],
        messageId: event.messageId ?? null,
        runId: event.runId ?? null,
        sourceEventId: event.sourceEventId ?? null,
        payload: event.type === CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED
          ? {
              ...(event.payload ?? {}),
              latestSequence,
            }
          : event.payload ?? {},
      })),
    })

    return latestSequence
  }

  async getLatestSequence(sessionId: string): Promise<number> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { nextEventSequence: true },
    })

    return session ? Math.max(0, session.nextEventSequence - 1) : 0
  }

  async getMinimumSequence(sessionId: string): Promise<number | null> {
    const result = await this.prisma.chatSessionEvent.aggregate({
      where: { sessionId },
      _min: {
        sequence: true,
      },
    })

    return result._min.sequence ?? null
  }

  async getEventsAfter(sessionId: string, afterSequence: number): Promise<ChatSessionEvent[]> {
    const events = await this.prisma.chatSessionEvent.findMany({
      where: {
        sessionId,
        sequence: {
          gt: afterSequence,
        },
      },
      orderBy: {
        sequence: 'asc',
      },
      take: 100,
    })

    return events.map(toChatSessionEvent)
  }

  async hasSourceEvent(runId: string, sourceEventId: string): Promise<boolean> {
    const existing = await this.prisma.chatSessionEvent.findFirst({
      where: {
        runId,
        sourceEventId,
      },
      select: {
        id: true,
      },
    })

    return !!existing
  }

  async getLatestSourceEventStreamId(runId: string): Promise<string | null> {
    const event = await this.prisma.chatSessionEvent.findFirst({
      where: {
        runId,
        sourceEventId: {
          not: null,
        },
      },
      select: {
        sourceEventId: true,
      },
      orderBy: {
        sequence: 'desc',
      },
    })

    return event?.sourceEventId ? toAgentEventStreamId(event.sourceEventId) : null
  }

  createSnapshotRequiredEvent(input: {
    sessionId: string
    latestSequence: number
  }): ChatSessionEvent {
    const now = new Date().toISOString()

    return ChatSessionEventSchema.parse({
      sequence: Math.max(1, input.latestSequence),
      sessionId: input.sessionId,
      type: CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED,
      messageId: null,
      runId: null,
      sourceEventId: null,
      createdAt: now,
      payload: {
        reason: 'cursor_expired',
        latestSequence: input.latestSequence,
      },
    })
  }
}

function toAgentEventStreamId(sourceEventId: string): string | null {
  const streamId = sourceEventId.replace(/:[^:]+$/, '')
  return /^\d+-\d+$/.test(streamId) ? streamId : null
}

function toChatSessionEvent(event: PersistedChatSessionEvent): ChatSessionEvent {
  return ChatSessionEventSchema.parse({
    sequence: event.sequence,
    sessionId: event.sessionId,
    type: eventTypeFromPrisma[event.type],
    messageId: event.messageId,
    runId: event.runId,
    sourceEventId: event.sourceEventId,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload,
  })
}

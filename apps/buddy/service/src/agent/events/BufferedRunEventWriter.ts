import type { BuddyAssistantTextPhase } from '../../../../shared/runs/assistantTextPhase'
import type { RunEventWriter } from '../../events/RunEventPorts'
import type { BuddyProjectedEvent } from './projectPiEvent'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { buddyAssistantTextPhaseSchema } from '../../../../shared/runs/assistantTextPhase'
import { buddyToolPresentationDeltaSchema } from '../../../../shared/runs/runEventPresentation'

const STREAM_WINDOW_MS = 25
const STREAM_EVENT_LIMIT = 20
const STREAM_BYTE_LIMIT = 64 * 1024

export class BufferedRunEventWriter {
  readonly #eventLog: Pick<RunEventWriter, 'appendBatch'>
  readonly #runId: string
  readonly #timestamp: () => string
  #pending: TimestampedBuddyProjectedEvent[] = []
  #pendingCount = 0
  #pendingBytes = 0
  #pendingSince = 0
  #tail = Promise.resolve()
  #timer: NodeJS.Timeout | undefined

  constructor(
    eventLog: Pick<RunEventWriter, 'appendBatch'>,
    runId: string,
    timestamp: () => string,
  ) {
    this.#eventLog = eventLog
    this.#runId = runId
    this.#timestamp = timestamp
  }

  append(event: BuddyProjectedEvent): void {
    const timestamped = { ...event, createdAt: this.#timestamp() }
    if (!isBufferedStreamEvent(timestamped)) {
      this.#flushPending()
      this.#enqueue([timestamped])
      return
    }

    const bytes = Buffer.byteLength(JSON.stringify({ ...timestamped, runId: this.#runId }))
    if (this.#pendingCount > 0 && (
      this.#pendingBytes + bytes > STREAM_BYTE_LIMIT
      || performance.now() - this.#pendingSince >= STREAM_WINDOW_MS
    )) {
      this.#flushPending()
    }
    if (this.#pendingCount === 0)
      this.#pendingSince = performance.now()
    this.#pendingCount += 1
    this.#pendingBytes += bytes
    const previous = this.#pending.at(-1)
    const merged = previous ? mergeStreamDelta(previous, timestamped) : null
    if (merged)
      this.#pending[this.#pending.length - 1] = merged
    else
      this.#pending.push(timestamped)
    if (this.#pendingCount >= STREAM_EVENT_LIMIT || this.#pendingBytes >= STREAM_BYTE_LIMIT) {
      this.#flushPending()
      return
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => this.#flushPending(), STREAM_WINDOW_MS)
      this.#timer.unref()
    }
  }

  appendBatch(events: readonly BuddyProjectedEvent[]): void {
    if (events.length === 0)
      return
    if (
      events.length === 1
      || events.some(isBufferedStreamEvent)
    ) {
      for (const event of events)
        this.append(event)
      return
    }
    this.#flushPending()
    this.#enqueue(events.map(event => ({
      ...event,
      createdAt: this.#timestamp(),
    })))
  }

  async drain(): Promise<void> {
    this.#flushPending()
    await this.#tail
  }

  #enqueue(events: readonly TimestampedBuddyProjectedEvent[]): void {
    const write = this.#eventLog.appendBatch(events.map(event => ({
      createdAt: event.createdAt,
      payload: event.payload,
      runId: this.#runId,
      type: event.type,
    })))
    this.#tail = Promise.all([this.#tail, write]).then(() => undefined)
    void this.#tail.catch(() => {})
  }

  #flushPending(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (this.#pending.length === 0)
      return
    const events = this.#pending
    this.#pending = []
    this.#pendingCount = 0
    this.#pendingBytes = 0
    this.#enqueue(events)
  }
}

interface TimestampedBuddyProjectedEvent extends BuddyProjectedEvent {
  createdAt: string
}

function mergeStreamDelta(
  left: TimestampedBuddyProjectedEvent,
  right: TimestampedBuddyProjectedEvent,
): TimestampedBuddyProjectedEvent | null {
  if (left.type === 'tool.updated' && right.type === 'tool.updated')
    return mergeToolPresentationDelta(left, right)
  if (left.type === 'message.block.delta' && right.type === 'message.block.delta')
    return mergeMessageBlockDelta(left, right)
  if (left.type !== 'message.delta' || right.type !== 'message.delta')
    return null
  const leftPayload = readMessageDeltaPayload(left.payload)
  const rightPayload = readMessageDeltaPayload(right.payload)
  if (
    !leftPayload
    || !rightPayload
    || leftPayload.messageId !== rightPayload.messageId
    || leftPayload.contentIndex !== rightPayload.contentIndex
    || leftPayload.phase !== rightPayload.phase
  ) {
    return null
  }
  return {
    createdAt: left.createdAt,
    payload: {
      ...(leftPayload.contentIndex === null ? {} : { contentIndex: leftPayload.contentIndex }),
      delta: leftPayload.delta + rightPayload.delta,
      messageId: leftPayload.messageId,
      ...(leftPayload.phase ? { phase: leftPayload.phase } : {}),
    },
    type: 'message.delta',
  }
}

function mergeToolPresentationDelta(
  left: TimestampedBuddyProjectedEvent,
  right: TimestampedBuddyProjectedEvent,
): TimestampedBuddyProjectedEvent | null {
  const leftPayload = readToolPresentationDeltaPayload(left.payload)
  const rightPayload = readToolPresentationDeltaPayload(right.payload)
  if (
    !leftPayload
    || !rightPayload
    || leftPayload.toolCallId !== rightPayload.toolCallId
    || leftPayload.toolName !== rightPayload.toolName
    || leftPayload.delta.outputStart + leftPayload.delta.outputDelta.length
    !== rightPayload.delta.outputStart
  ) {
    return null
  }
  return {
    createdAt: left.createdAt,
    payload: {
      presentationDelta: {
        ...rightPayload.delta,
        outputDelta: leftPayload.delta.outputDelta + rightPayload.delta.outputDelta,
        outputStart: leftPayload.delta.outputStart,
      },
      toolCallId: leftPayload.toolCallId,
      toolName: leftPayload.toolName,
    },
    type: 'tool.updated',
  }
}

function isBufferedStreamEvent(event: BuddyProjectedEvent): boolean {
  return event.type === 'message.delta'
    || event.type === 'message.block.delta'
    || (event.type === 'tool.updated' && readToolPresentationDeltaPayload(event.payload) !== null)
}

function readToolPresentationDeltaPayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null
  const payload = value as Record<string, unknown>
  const delta = buddyToolPresentationDeltaSchema.safeParse(payload.presentationDelta)
  return delta.success
    && typeof payload.toolCallId === 'string'
    && typeof payload.toolName === 'string'
    ? {
        delta: delta.data,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
      }
    : null
}

function mergeMessageBlockDelta(
  left: TimestampedBuddyProjectedEvent,
  right: TimestampedBuddyProjectedEvent,
): TimestampedBuddyProjectedEvent | null {
  const leftPayload = readMessageBlockDeltaPayload(left.payload)
  const rightPayload = readMessageBlockDeltaPayload(right.payload)
  if (
    !leftPayload
    || !rightPayload
    || leftPayload.messageId !== rightPayload.messageId
    || leftPayload.contentIndex !== rightPayload.contentIndex
  ) {
    return null
  }
  return {
    createdAt: left.createdAt,
    payload: {
      contentIndex: leftPayload.contentIndex,
      delta: leftPayload.delta + rightPayload.delta,
      kind: 'reasoning',
      messageId: leftPayload.messageId,
    },
    type: 'message.block.delta',
  }
}

function readMessageDeltaPayload(value: unknown): {
  contentIndex: number | null
  delta: string
  messageId: string
  phase: BuddyAssistantTextPhase | undefined
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null
  const payload = value as Record<string, unknown>
  if (typeof payload.delta !== 'string' || typeof payload.messageId !== 'string')
    return null
  const contentIndex = payload.contentIndex === undefined
    ? null
    : typeof payload.contentIndex === 'number'
      && Number.isSafeInteger(payload.contentIndex)
      && payload.contentIndex >= 0
      ? payload.contentIndex
      : undefined
  if (contentIndex === undefined)
    return null
  const phase = payload.phase === undefined
    ? undefined
    : buddyAssistantTextPhaseSchema.safeParse(payload.phase)
  if (phase !== undefined && !phase.success)
    return null
  return {
    contentIndex,
    delta: payload.delta,
    messageId: payload.messageId,
    phase: phase?.data,
  }
}

function readMessageBlockDeltaPayload(
  value: unknown,
): { contentIndex: number, delta: string, messageId: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null
  const payload = value as Record<string, unknown>
  return payload.kind === 'reasoning'
    && typeof payload.delta === 'string'
    && typeof payload.messageId === 'string'
    && typeof payload.contentIndex === 'number'
    && Number.isSafeInteger(payload.contentIndex)
    && payload.contentIndex >= 0
    ? {
        contentIndex: payload.contentIndex,
        delta: payload.delta,
        messageId: payload.messageId,
      }
    : null
}

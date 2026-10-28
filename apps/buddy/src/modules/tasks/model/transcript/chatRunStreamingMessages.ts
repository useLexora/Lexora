import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'

import type { ChatProjectionReducer } from './chatRunEventProjection'
import { readAssistantTextPhase, readPayload } from './chatRunEventProjection'

export interface StreamingAssistantMessage {
  id: string
  text: string
}

export interface ChatRunStreamingMessage {
  message: LocalMessage
  orderCreatedAt: string
  orderSequence: number
  text: string
}

export function projectStreamingAssistantMessage(
  messages: ReadonlyArray<LocalMessage>,
  events: ReadonlyArray<LocalRunEvent>,
  runs: ReadonlyArray<LocalRun>,
): StreamingAssistantMessage | null {
  const latest = projectChatStreamingMessages(messages, events, runs).at(-1)
  return latest ? { id: latest.message.id, text: latest.text } : null
}

export function projectChatStreamingMessages(
  messages: ReadonlyArray<LocalMessage>,
  events: ReadonlyArray<LocalRunEvent>,
  runs: ReadonlyArray<LocalRun>,
): ReadonlyArray<ChatRunStreamingMessage> {
  const eventsByRunId = new Map<string, LocalRunEvent[]>()
  for (const event of events) {
    const runEvents = eventsByRunId.get(event.runId) ?? []
    runEvents.push(event)
    eventsByRunId.set(event.runId, runEvents)
  }
  return selectChatStreamingMessages(
    messages,
    runs.flatMap(run => projectChatRunStreamingMessages(
      run,
      eventsByRunId.get(run.id) ?? [],
    )),
    runs,
  )
}

export function projectChatRunStreamingMessages(
  run: LocalRun,
  events: ReadonlyArray<LocalRunEvent>,
): ReadonlyArray<ChatRunStreamingMessage> {
  const reducer = createChatRunStreamingMessageReducer(run)
  reducer.append(events)
  return reducer.project()
}

export function createChatRunStreamingMessageReducer(
  run: LocalRun,
): ChatProjectionReducer<ReadonlyArray<ChatRunStreamingMessage>> {
  const isActive = run.status === 'queued' || run.status === 'running'
  const messageStartedAtById = new Map<string, string>()
  const candidates = new Map<string, {
    orderCreatedAt: string
    orderSequence: number
    sourceCreatedAt: string
    text: string
  }>()

  function append(events: ReadonlyArray<LocalRunEvent>) {
    for (const event of events) {
      const payload = readPayload(event.payload)
      if (!payload)
        continue
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null
      if (!messageId)
        continue
      if (event.type === 'message.started') {
        if (!messageStartedAtById.has(messageId))
          messageStartedAtById.set(messageId, event.createdAt)
        if (!isActive)
          continue
        const current = candidates.get(messageId)
        candidates.set(messageId, {
          orderCreatedAt: current?.orderCreatedAt ?? event.createdAt,
          orderSequence: current?.orderSequence ?? event.sequence,
          sourceCreatedAt: event.createdAt,
          text: '',
        })
        continue
      }
      if (!isActive && event.type !== 'message.completed')
        continue
      if (event.type === 'message.delta') {
        if (readAssistantTextPhase(payload.phase) === 'commentary') {
          candidates.delete(messageId)
          continue
        }
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        const current = candidates.get(messageId)
        candidates.set(messageId, {
          orderCreatedAt: current?.orderCreatedAt ?? event.createdAt,
          orderSequence: current?.orderSequence ?? event.sequence,
          sourceCreatedAt: event.createdAt,
          text: (current?.text ?? '') + delta,
        })
        continue
      }
      if (event.type === 'message.completed') {
        const phase = readAssistantTextPhase(payload.phase)
        if (phase === 'commentary' || (!phase && payload.stopReason === 'tool_use')) {
          candidates.delete(messageId)
          continue
        }
        const content = readPayload(payload.content)
        const text = typeof content?.text === 'string'
          ? content.text
          : candidates.get(messageId)?.text ?? ''
        const current = candidates.get(messageId)
        candidates.set(messageId, {
          orderCreatedAt: current?.orderCreatedAt ?? event.createdAt,
          orderSequence: current?.orderSequence ?? event.sequence,
          sourceCreatedAt: event.createdAt,
          text,
        })
      }
    }
  }

  function project(): ReadonlyArray<ChatRunStreamingMessage> {
    return [...candidates.entries()].flatMap(([messageId, candidate]): ChatRunStreamingMessage[] => {
      if (!candidate.text.trim())
        return []
      return [{
        message: {
          attachments: [],
          branchId: run.branchId,
          content: { text: candidate.text },
          conversationId: run.conversationId,
          createdAt: messageStartedAtById.get(messageId) ?? candidate.sourceCreatedAt,
          id: messageId,
          role: 'assistant',
          runId: run.id,
        },
        orderCreatedAt: candidate.orderCreatedAt,
        orderSequence: candidate.orderSequence,
        text: candidate.text,
      }]
    })
  }

  return { append, project }
}

export function selectChatStreamingMessage(
  messages: ReadonlyArray<LocalMessage>,
  candidates: ReadonlyArray<ChatRunStreamingMessage>,
  runs: ReadonlyArray<LocalRun>,
): ChatRunStreamingMessage | null {
  return selectChatStreamingMessages(messages, candidates, runs).at(-1) ?? null
}

export function selectChatStreamingMessages(
  messages: ReadonlyArray<LocalMessage>,
  candidates: ReadonlyArray<ChatRunStreamingMessage>,
  runs: ReadonlyArray<LocalRun>,
): ReadonlyArray<ChatRunStreamingMessage> {
  const persistedMessageIds = new Set(messages.map(message => message.id))
  const loadedMessageIds = new Set(persistedMessageIds)
  const runById = new Map(runs.map(run => [run.id, run]))
  const latest = new Map<string, ChatRunStreamingMessage>()
  for (const candidate of candidates) {
    if (persistedMessageIds.has(candidate.message.id) || !candidate.message.runId)
      continue
    const run = runById.get(candidate.message.runId)
    if (!run || (run.status !== 'queued' && run.status !== 'running' && !loadedMessageIds.has(run.triggeringMessageId)))
      continue
    const previous = latest.get(run.id)
    if (!previous || compareRunStreamingMessages(previous, candidate) < 0)
      latest.set(run.id, candidate)
  }
  return [...latest.values()].sort(compareRunStreamingMessages)
}

function compareRunStreamingMessages(
  left: ChatRunStreamingMessage,
  right: ChatRunStreamingMessage,
): number {
  return left.orderCreatedAt.localeCompare(right.orderCreatedAt)
    || left.orderSequence - right.orderSequence
}

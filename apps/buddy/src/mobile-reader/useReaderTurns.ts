import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { Ref } from 'vue'
import type { ChatAgentTurn } from '../modules/tasks/contracts'
import type { ReaderEntry, ReaderTranscript } from './readerBridge'
import { computed, watch } from 'vue'
import { createChatAgentTurnReducer } from '../modules/tasks/reader'

export function useReaderTurns(entries: Ref<ReaderEntry[]>, runs: Ref<LocalRun[]>, transcripts: Ref<Record<string, ReaderTranscript>>, topic: Ref<string>) {
  const cache = new Map<string, { count: number, state: string, reducer: ReturnType<typeof createChatAgentTurnReducer> }>()
  watch(topic, () => cache.clear())
  return computed(() => {
    const turns = new Map<string, ChatAgentTurn>()
    for (const run of runs.value) {
      const source = transcripts.value[run.id]
      if (!source?.loaded || !source.events.length)
        continue
      const state = `${run.status}:${run.completedAt}:${run.errorCode}`
      let cached = cache.get(run.id)
      if (!cached || cached.state !== state || source.events.length < cached.count) {
        cached = { count: 0, state, reducer: createChatAgentTurnReducer(run) }
        cache.set(run.id, cached)
      }
      cached.reducer.append(source.events.slice(cached.count))
      cached.count = source.events.length
      turns.set(run.id, cached.reducer.project())
    }
    const messagesByRun = new Map<string, ReaderEntry['messages']>()
    for (const entry of entries.value) {
      for (const message of entry.messages) {
        if (message.role === 'user' || !message.runId)
          continue
        const messages = messagesByRun.get(message.runId) ?? []
        messages.push(message)
        messagesByRun.set(message.runId, messages)
      }
    }
    const emitted = new Set<string>()
    const errors = new Set<string>()
    const result: ReaderEntry[] = []
    const appendTurn = (turn: ChatAgentTurn) => {
      emitted.add(turn.runId)
      result.push({ id: `turn:${turn.runId}`, continuation: false, turn, transcriptError: transcripts.value[turn.runId]?.error, messages: messagesByRun.get(turn.runId) ?? [] })
    }
    for (const entry of entries.value) {
      const message = entry.messages[0]
      const turn = message?.role !== 'user' && message?.runId ? turns.get(message.runId) : null
      if (turn) {
        if (!emitted.has(turn.runId))
          appendTurn(turn)
      }
      else {
        const error = message?.runId ? transcripts.value[message.runId]?.error : undefined
        if (error && message?.runId && !errors.has(message.runId) && message.role !== 'user') {
          result.push({ ...entry, transcriptError: error })
          errors.add(message.runId)
        }
        else {
          result.push(entry)
        }
        for (const candidate of turns.values()) {
          if (candidate.triggeringMessageId === message?.id && !messagesByRun.has(candidate.runId) && !emitted.has(candidate.runId))
            appendTurn(candidate)
        }
      }
    }
    for (const id of cache.keys()) {
      if (!runs.value.some(run => run.id === id))
        cache.delete(id)
    }
    return result
  })
}

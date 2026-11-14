import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatAgentTurn } from '../modules/tasks/contracts'
import type { ReaderActionInput, ReaderWireEntry } from './readerProtocol'
import { useTimeoutFn } from '@vueuse/core'
import { onMounted, onUnmounted, provide, shallowRef } from 'vue'
import { setMarkdownLanguage } from './markdownStrings'
import { ReaderProjection } from './readerProjection'
import { readerActionSchema, readerCopiedSchema, readerUpdateSchema } from './readerProtocol'
import { readerLanguageKey } from './readerStrings'
import { readerAvatarsKey } from './useReaderAvatars'
import { readerCopyFeedbackKey } from './useReaderCopyFeedback'

export type { ReaderMessage } from './readerProtocol'
export interface ReaderTranscript { events: LocalRunEvent[], loaded?: boolean, error?: string | null }
export interface ReaderEntry extends ReaderWireEntry { transcriptError?: string | null, turn?: ChatAgentTurn }

export function useReaderBridge() {
  const copiedMessageId = shallowRef<string | null>(null)
  provide(readerCopyFeedbackKey, copiedMessageId)
  const copiedReset = useTimeoutFn(() => copiedMessageId.value = null, 1_400, { immediate: false })
  const appearance = shallowRef<Record<string, string>>({})
  const typography = shallowRef({ bodySize: 15, bodyLineHeight: 24 })
  const avatars = shallowRef<Record<string, string>>({})
  provide(readerAvatarsKey, avatars)
  const entries = shallowRef<ReaderEntry[]>([])
  const runs = shallowRef<LocalRun[]>([])
  const transcripts = shallowRef<Record<string, ReaderTranscript>>({})
  const topic = shallowRef('')
  const dark = shallowRef(false)
  const fontScale = shallowRef(1)
  const language = shallowRef('zh')
  provide(readerLanguageKey, language)
  const resultRunId = shallowRef<string | null>(null)
  let port: MessagePort | undefined
  const projection = new ReaderProjection()

  function send(action: ReaderActionInput) {
    port?.postMessage(JSON.stringify(readerActionSchema.parse({ ...action, topic: topic.value })))
  }

  function connect(event: MessageEvent) {
    if (event.data !== 'lexora-reader' || !event.isTrusted || event.source !== null || !event.ports[0])
      return
    port?.close()
    port = event.ports[0]
    port.onmessage = (message: MessageEvent<string>) => {
      let source: unknown
      try {
        source = JSON.parse(message.data)
      }
      catch {
        return
      }
      const parsed = readerCopiedSchema.or(readerUpdateSchema).safeParse(source)
      if (!parsed.success)
        return
      const update = parsed.data
      if ('type' in update) {
        if (update.type === 'copied' && update.topic === topic.value) {
          copiedMessageId.value = update.id
          copiedReset.start()
        }
        return
      }
      if (update.appearance)
        appearance.value = update.appearance.variables
      if (update.typography)
        typography.value = update.typography
      const next = projection.apply(update)
      if (next.reset) {
        copiedMessageId.value = null
        copiedReset.stop()
        avatars.value = {}
      }
      if (update.avatars)
        avatars.value = update.avatars
      runs.value = (update.runs ?? []).map(run => ({ ...run, generation: Number(run.generation) }))
      transcripts.value = next.transcripts
      topic.value = update.topic
      resultRunId.value = update.resultRunId ?? null
      dark.value = update.dark
      fontScale.value = update.fontScale
      language.value = update.language === 'en' ? 'en' : 'zh'
      setMarkdownLanguage(language.value)
      document.documentElement.lang = language.value
      document.title = 'Lexora'
      entries.value = next.entries
    }
    port.start()
    send({ action: 'ready' })
  }

  onMounted(() => window.addEventListener('message', connect))
  onUnmounted(() => {
    window.removeEventListener('message', connect)
    port?.close()
  })
  return { entries, runs, transcripts, topic, dark, fontScale, appearance, typography, language, resultRunId, send }
}

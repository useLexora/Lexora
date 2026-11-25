import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatAgentTurn } from '../modules/tasks/contracts'
import type { ReaderAnchor } from './readerProjection'
import type { ReaderActionInput, ReaderOutput, ReaderStepDetailReply, ReaderToolImage, ReaderUpdate, ReaderWireEntry } from './readerProtocol'
import { useTimeoutFn } from '@vueuse/core'
import { onMounted, onUnmounted, provide, shallowRef } from 'vue'
import { setMarkdownLanguage } from './markdownStrings'
import { readerBodyPageKey } from './readerBodyPages'
import { readerTurnWindowKey } from './readerLoadingPolicy'
import { ReaderProjection } from './readerProjection'
import { readerActionSchema, readerCopiedSchema, readerStepDetailReplySchema, readerUpdateSchema } from './readerProtocol'
import { readerStepDetailKey } from './readerStepDetail'
import { readerLanguageKey } from './readerStrings'
import { readerToolImagesKey } from './readerToolImages'
import { readerAvatarsKey } from './useReaderAvatars'
import { readerCopyFeedbackKey } from './useReaderCopyFeedback'

export type { ReaderMessage } from './readerProtocol'
export interface ReaderTranscript { events: LocalRunEvent[], loaded?: boolean, error?: string | null }
export type ReaderRun = LocalRun & Pick<NonNullable<ReaderUpdate['runs']>[number], 'executionKind'>
export interface ReaderTurnOwner { id: string, name?: string }
export interface ReaderEntry extends ReaderWireEntry {
  transcriptError?: string | null
  turn?: ChatAgentTurn
  runStatus?: { run: ReaderRun, hasReply: boolean }
  groupOwner?: { name?: string }
}

export function useReaderBridge() {
  const copiedMessageId = shallowRef<string | null>(null)
  provide(readerCopyFeedbackKey, copiedMessageId)
  const copiedReset = useTimeoutFn(() => copiedMessageId.value = null, 1_400, { immediate: false })
  const composerActivity = shallowRef<ReaderUpdate['composerActivity']>()
  const appearance = shallowRef<Record<string, string>>({})
  const typography = shallowRef({ bodySize: 15, bodyLineHeight: 24 })
  const avatars = shallowRef<Record<string, string>>({})
  provide(readerAvatarsKey, avatars)
  const buddyNames = shallowRef(new Map<string, string>())
  const entries = shallowRef<ReaderEntry[]>([])
  const turnWindow = shallowRef(false)
  provide(readerTurnWindowKey, turnWindow)
  const history = shallowRef<ReaderUpdate['history']>()
  const stepDetail = shallowRef<ReaderStepDetailReply>()
  provide(readerStepDetailKey, stepDetail)
  const bodyPage = shallowRef<ReaderUpdate['bodyPage']>()
  provide(readerBodyPageKey, bodyPage)
  const runs = shallowRef<ReaderRun[]>([])
  const transcripts = shallowRef<Record<string, ReaderTranscript>>({})
  const outputs = shallowRef<Record<string, ReaderOutput>>({})
  const toolImages = shallowRef<ReaderToolImage[]>([])
  provide(readerToolImagesKey, toolImages)
  const branches = shallowRef<NonNullable<ReaderUpdate['branches']>>([])
  const selectedBranchId = shallowRef<string | null>(null)
  const topic = shallowRef('')
  const dark = shallowRef(false)
  const fontScale = shallowRef(1)
  const language = shallowRef('zh')
  provide(readerLanguageKey, language)
  const resultRunId = shallowRef<string | null>(null)
  const anchor = shallowRef<ReaderAnchor | null>(null)
  const latestState = shallowRef<ReaderUpdate['latest']>()
  const hasLaterMessages = shallowRef(false)
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
      const parsed = readerCopiedSchema.or(readerStepDetailReplySchema).or(readerUpdateSchema).safeParse(source)
      if (!parsed.success)
        return
      const update = parsed.data
      if ('type' in update) {
        if (update.type === 'step-detail' && update.topic === topic.value)
          stepDetail.value = update
        if (update.type === 'copied' && update.topic === topic.value) {
          copiedMessageId.value = update.id
          copiedReset.start()
        }
        return
      }
      if (!update.reset && topic.value && update.topic !== topic.value)
        return
      if (update.appearance)
        appearance.value = update.appearance.variables
      if (update.typography)
        typography.value = update.typography
      const next = projection.apply(update)
      if (next.reset) {
        stepDetail.value = undefined
        copiedMessageId.value = null
        copiedReset.stop()
        avatars.value = {}
      }
      if (update.composerActivity !== undefined || next.reset)
        composerActivity.value = update.composerActivity
      if (update.turnWindow !== undefined || next.reset)
        turnWindow.value = update.turnWindow === true
      if (update.history || next.reset)
        history.value = update.history
      if (update.bodyPage || next.reset)
        bodyPage.value = update.bodyPage
      if (update.avatars)
        avatars.value = update.avatars
      buddyNames.value = next.buddyNames
      if (update.branches || next.reset)
        branches.value = update.branches ?? []
      if (update.selectedBranchId !== undefined || next.reset)
        selectedBranchId.value = update.selectedBranchId ?? null
      if (update.outputs || next.reset)
        outputs.value = update.outputs ?? {}
      if (update.toolImages || next.reset)
        toolImages.value = update.toolImages ?? []
      runs.value = (update.runs ?? []).filter(run => run.executionKind !== 'maintenance' && run.purpose !== 'conversation.compaction').map(run => ({ ...run, generation: Number(run.generation) }))
      transcripts.value = next.transcripts
      topic.value = update.topic
      anchor.value = next.anchor
      latestState.value = update.latest
      hasLaterMessages.value = update.hasLaterMessages ?? false
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
  return { entries, composerActivity, turnWindow, history, runs, buddyNames, transcripts, outputs, branches, selectedBranchId, topic, dark, fontScale, appearance, typography, language, resultRunId, anchor, hasLaterMessages, latestState, send }
}

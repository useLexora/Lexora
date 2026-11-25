import type { Ref } from 'vue'
import type { ChatActivityInput } from '../modules/tasks/reader'
import type { ReaderSend, ReaderUpdate } from './readerProtocol'
import { computed, shallowRef, watch } from 'vue'
import { describeChatCurrentActivity, executionLabels } from '../modules/tasks/reader'

type Source = NonNullable<ReaderUpdate['composerActivity']>

export function describeReaderComposerActivity(source: Source, turn: ChatActivityInput | undefined, language: string, now: number) {
  const locale = language === 'en' ? 'en-US' : 'zh-CN'
  if (source.awaitingAnswer && !source.stopping && !source.awaitingApproval)
    return { label: executionLabels(locale).waitingAnswer, active: false, warning: true }
  const nodes = [...turn?.nodes ?? []]
  if (source.awaitingApproval)
    nodes.push({ kind: 'tool', status: 'awaiting_approval' })
  if (source.runningTool)
    nodes.push({ kind: 'tool', status: 'running' })
  if (source.runningReasoning)
    nodes.push({ kind: 'reasoning', status: 'running' })
  const progress = turn?.progress ?? (source.replying ? { phase: 'model_responding', toolName: null } as const : null)
  return describeChatCurrentActivity({ nodes, status: source.status, progress }, locale, now, source.stopping)
}

export function useReaderComposerActivity(source: Ref<ReaderUpdate['composerActivity']>, legacyTurn: () => ChatActivityInput | undefined, language: Ref<string>, send: ReaderSend) {
  const now = shallowRef(Date.now())
  const activity = computed(() => source.value && describeReaderComposerActivity(source.value, legacyTurn(), language.value, now.value))
  watch(() => source.value && legacyTurn()?.progress?.retry?.retryAt, (deadline, _, cleanup) => {
    if (!deadline)
      return
    now.value = Date.now()
    const timer = window.setInterval(() => {
      now.value = Date.now()
    }, 1000)
    cleanup(() => window.clearInterval(timer))
  }, { immediate: true })
  watch([() => source.value?.requestId, () => activity.value?.label, () => activity.value?.active, () => !!activity.value?.warning] as const, ([requestId, label, active, warning]) => {
    if (requestId && label && active !== undefined)
      send({ action: 'composer-activity', requestId, label, active, warning })
  }, { immediate: true })
}

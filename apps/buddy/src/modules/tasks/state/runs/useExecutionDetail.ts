import type { ExecutionTarget, LocalExecutionDetail } from '@buddy-shared/executions/executionPresentationApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { Ref } from 'vue'
import type { ChatRunEventBuckets } from '../../model/runs/typing'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { mergeChatRunEventBuckets } from '../../model/runs/chatRunEventBuckets'
import { createChatRunTranscriptProjector } from '../../model/transcript/chatRunTranscriptProjector'
import { createChatTranscriptProjector } from '../../model/transcript/chatTranscriptProjection'
import { useExecutionEnvironment } from './chatExecutionContext'

export function useExecutionDetail(target: Readonly<Ref<ExecutionTarget | null>>, visible: Readonly<Ref<boolean>>) {
  const environment = useExecutionEnvironment()
  const detail = shallowRef<LocalExecutionDetail | null>(null)
  const buckets = shallowRef<ChatRunEventBuckets>(new Map())
  const events = computed<readonly LocalRunEvent[]>(() => target.value ? buckets.value.get(target.value.runId)?.events ?? [] : [])
  const loading = shallowRef(false)
  const failed = shallowRef(false)
  const projector = createChatRunTranscriptProjector()
  const transcript = createChatTranscriptProjector()
  let generation = 0
  let disposed = false
  let busy = false
  let again = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let sequence = 0
  const rows = computed(() => {
    if (!detail.value)
      return []
    const run = detail.value.run
    const projections = projector.project(buckets.value, [run])
    return transcript.project({
      includeUnanchoredTurns: true,
      runs: [run],
      runProjections: projections,
      timelineItems: projections.flatMap(projection => projection.streamingMessages.map(item => ({ ...item.message, kind: 'message' as const }))),
      outputs: [],
      changeSets: [],
    }).rows.map(row => row.kind === 'message' && !events.value.some(event => event.type === 'message.completed' && event.payload.messageId === row.message.id) ? { ...row, streaming: true } : row)
  })

  async function refresh() {
    const input = target.value
    if (!input || disposed || !visible.value || !environment?.ready.value)
      return
    if (busy) {
      again = true
      return
    }
    busy = true
    const current = generation
    const active = () => !disposed && current === generation && visible.value && environment.ready.value
    loading.value = !detail.value
    failed.value = false
    try {
      const value = await environment.api.detail(input)
      if (!active())
        return
      detail.value = detail.value && Object.entries(detail.value.run).every(([key, field]) => value.run[key as keyof typeof value.run] === field) ? { ...value, run: detail.value.run } : value
      for (;;) {
        const page = await environment.api.events({ ...input, afterSequence: sequence })
        if (!active())
          return
        buckets.value = mergeChatRunEventBuckets(buckets.value, page.events)
        sequence = page.nextSequence
        if (!page.hasMore)
          break
      }
    }
    catch {
      if (active())
        failed.value = true
    }
    finally {
      busy = false
      if (active())
        loading.value = false
      if (again && !disposed) {
        again = false
        void refresh()
      }
    }
  }

  const stop = environment?.api.onChanged((notice) => {
    if (notice.conversationId !== target.value?.conversationId || notice.rootRunId !== target.value?.rootRunId || !visible.value || timer)
      return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, 80)
  })
  watch(target, () => {
    generation++
    sequence = 0
    detail.value = null
    buckets.value = new Map()
    void refresh()
  }, { immediate: true })
  watch(() => [visible.value, environment?.ready.value], () => {
    generation++
    clearTimeout(timer)
    timer = undefined
    loading.value = false
    void refresh()
  })
  onScopeDispose(() => {
    disposed = true
    generation++
    stop?.()
    clearTimeout(timer)
  })
  return { detail: readonly(detail), rows, loading: readonly(loading), failed: readonly(failed), refresh, environment }
}

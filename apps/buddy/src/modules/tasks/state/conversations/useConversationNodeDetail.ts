import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import type { ConversationNodeDetailRequest, LocalConversationTreeNode } from '@buddy-shared/conversation/conversationTree'
import type { UserQuestionRequest } from '@buddy-shared/questions/userQuestionApi'
import type { LocalRun, LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { Ref } from 'vue'
import type { ChatRunEventBuckets } from '../../model/runs/typing'
import type { ChatTranscriptRow } from '../../model/transcript/chatTranscriptProjection'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { mergeChatRunEventBuckets, replaceChatRunEventBuckets } from '../../model/runs/chatRunEventBuckets'
import { createChatRunTranscriptProjector } from '../../model/transcript/chatRunTranscriptProjector'
import { createChatTranscriptProjector } from '../../model/transcript/chatTranscriptProjection'

export function useConversationNodeDetail(options: {
  load: (input: ConversationNodeDetailRequest) => Promise<LocalConversationTimelinePage>
  conversationId: Readonly<Ref<string | null>>
  language: Readonly<Ref<BuddyLocale>>
  runs: Readonly<Ref<readonly LocalRun[]>>
  runEventBuckets: Readonly<Ref<ChatRunEventBuckets>>
  runOutputs: Readonly<Ref<readonly LocalRunOutput[]>>
  changeSets: Readonly<Ref<readonly LocalChangeSetSummary[]>>
  userQuestions?: Readonly<Ref<readonly UserQuestionRequest[]>>
}) {
  const target = shallowRef<ConversationNodeDetailRequest | null>(null)
  const data = shallowRef<LocalConversationTimelinePage | null>(null)
  const visible = shallowRef(false)
  const loading = shallowRef(false)
  const error = shallowRef<string | null>(null)
  const buckets = shallowRef<ChatRunEventBuckets>(new Map())
  const runProjector = createChatRunTranscriptProjector()
  const transcriptProjector = createChatTranscriptProjector()
  let generation = 0
  let disposed = false
  const liveRun = computed(() => target.value?.kind === 'answer'
    ? options.runs.value.find(run => target.value?.kind === 'answer' && run.id === target.value.runId)
    : null)
  const liveBucket = computed(() => target.value?.kind === 'answer'
    ? options.runEventBuckets.value.get(target.value.runId)
    : null)
  const runs = computed(() => liveRun.value ? [liveRun.value] : data.value?.runs ?? [])
  const rows = computed<readonly ChatTranscriptRow[]>(() => {
    if (!visible.value || !data.value)
      return []
    const projections = runProjector.project(buckets.value, runs.value)
    const content = transcriptProjector.project({
      includeUnanchoredTurns: true,
      userQuestions: options.userQuestions?.value,
      changeSets: [...data.value.changeSets, ...options.changeSets.value.filter(item => item.runId === liveRun.value?.id)],
      outputs: [...data.value.outputs, ...options.runOutputs.value.filter(item => item.runId === liveRun.value?.id)],
      runProjections: projections,
      runs: runs.value,
      timelineItems: data.value.items,
    })
    return content.rows
  })

  async function refresh() {
    const input = target.value
    if (!input || disposed)
      return
    const current = ++generation
    loading.value = !data.value
    error.value = null
    try {
      const result = await options.load(input)
      if (current !== generation || disposed)
        return
      data.value = result
      buckets.value = mergeChatRunEventBuckets(replaceChatRunEventBuckets(result.runEvents), liveBucket.value?.events ?? [])
    }
    catch (cause) {
      if (current === generation)
        error.value = resolveLocalChatErrorMessage(cause, options.language.value)
    }
    finally {
      if (current === generation)
        loading.value = false
    }
  }
  function open(node: LocalConversationTreeNode) {
    const conversationId = options.conversationId.value
    if (!conversationId || (node.kind === 'question' ? !node.messageId : !node.runId))
      return
    generation++
    target.value = node.kind === 'question'
      ? { conversationId, kind: 'question', messageId: node.messageId! }
      : { conversationId, kind: 'answer', runId: node.runId! }
    data.value = null
    buckets.value = new Map()
    visible.value = true
    return refresh()
  }
  function close() {
    generation++
    visible.value = false
    loading.value = false
  }
  watch(liveBucket, (bucket, previous) => {
    if (!bucket || !data.value || !visible.value)
      return
    const events = bucket.update && bucket.update.previousRevision === previous?.revision ? bucket.update.events : bucket.events
    buckets.value = mergeChatRunEventBuckets(buckets.value, events)
  })
  watch(() => liveRun.value?.status, (status, previous) => {
    if (visible.value && previous && status && status !== 'running' && status !== 'queued')
      void refresh()
  })
  watch(options.conversationId, () => {
    close()
    target.value = null
    data.value = null
    buckets.value = new Map()
  }, { flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    generation++
  })
  return { target, data, visible, loading, error, rows, open, close, refresh }
}

import type { ExecutionTarget, LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { Ref } from 'vue'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { executionDisplayName } from '../../model/executions/executionDisplayName'
import { provideExecutionTree, useExecutionEnvironment } from './chatExecutionContext'

export function useChatExecutionTree(options: { conversationId: Readonly<Ref<string | null>>, branchId: Readonly<Ref<string | null>> }) {
  const environment = useExecutionEnvironment()
  const records = shallowRef<readonly LocalExecution[]>([])
  const revision = shallowRef(0)
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let loading = false
  let again = false
  const byParent = computed(() => {
    const result = new Map<string, LocalExecution[]>()
    for (const record of records.value) {
      if (!record.parentRunId)
        continue
      const siblings = result.get(record.parentRunId) ?? []
      siblings.push(record)
      result.set(record.parentRunId, siblings)
    }
    return result
  })

  async function refresh() {
    const conversationId = options.conversationId.value
    const branchId = options.branchId.value
    if (!environment?.ready.value || disposed || !conversationId || !branchId)
      return
    if (loading) {
      again = true
      return
    }
    loading = true
    const request = ++generation
    const scope = { conversationId, branchId }
    try {
      const value = await environment.api.list(scope)
      if (!disposed && request === generation && scope.conversationId === options.conversationId.value && scope.branchId === options.branchId.value) {
        records.value = value
        revision.value++
      }
    }
    catch (error) {
      if (!disposed && request === generation)
        environment.onError(error)
    }
    finally {
      loading = false
      if (again && !disposed) {
        again = false
        void refresh()
      }
    }
  }

  const stop = environment?.api.onChanged((notice) => {
    if (notice.conversationId !== options.conversationId.value || timer)
      return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, 60)
  })
  watch(() => [options.conversationId.value, options.branchId.value, environment?.ready.value], () => {
    generation++
    records.value = []
    void refresh()
  }, { immediate: true })
  onScopeDispose(() => {
    disposed = true
    generation++
    stop?.()
    clearTimeout(timer)
  })

  function target(record: LocalExecution): ExecutionTarget {
    const conversationId = options.conversationId.value
    const branchId = options.branchId.value
    if (!conversationId || !branchId)
      throw new Error('No active execution scope')
    return { conversationId, branchId, rootRunId: record.rootRunId, runId: record.runId }
  }
  const tree = {
    records: readonly(records),
    revision: readonly(revision),
    ready: computed(() => environment?.ready.value ?? false),
    selectedRunId: computed(() => {
      const selected = environment?.selectedTarget.value
      return selected?.conversationId === options.conversationId.value && selected?.branchId === options.branchId.value ? selected.runId : null
    }),
    byParent,
    target,
    open: async (record: LocalExecution) => environment?.open(target(record), executionDisplayName(record)),
    onError: environment?.onError,
    refresh,
    api: environment?.api,
  }
  provideExecutionTree(tree)
  return tree
}

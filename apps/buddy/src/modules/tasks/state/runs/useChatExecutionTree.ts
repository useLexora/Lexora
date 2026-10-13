import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { ExecutionTarget, LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { Ref } from 'vue'
import type { TaskExecutionTree } from '../../contracts'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { projectExecutionGroups } from '../../model/executions/executionGroups'

export function useChatExecutionTree(options: {
  conversationId: Readonly<Ref<string | null>>
  branchId: Readonly<Ref<string | null>>
  ready: Readonly<Ref<boolean>>
  api: LocalChatApi['executions']
  onError: (error: unknown) => void
}): TaskExecutionTree {
  const records = shallowRef<readonly LocalExecution[]>([])
  const revision = shallowRef(0)
  const groups = computed(() => projectExecutionGroups(records.value))
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
    if (!options.ready.value || disposed || !conversationId || !branchId)
      return
    if (loading) {
      again = true
      return
    }
    loading = true
    const request = ++generation
    const scope = { conversationId, branchId }
    try {
      const value = await options.api.list(scope)
      if (!disposed && request === generation && scope.conversationId === options.conversationId.value && scope.branchId === options.branchId.value) {
        records.value = value
        revision.value++
      }
    }
    catch (error) {
      if (!disposed && request === generation)
        options.onError(error)
    }
    finally {
      loading = false
      if (again && !disposed) {
        again = false
        void refresh()
      }
    }
  }

  const stop = options.api.onChanged((notice) => {
    if (notice.conversationId !== options.conversationId.value || timer)
      return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, 60)
  })
  watch(() => [options.conversationId.value, options.branchId.value, options.ready.value], () => {
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
    groups,
    records: readonly(records),
    revision: readonly(revision),
    ready: options.ready,
    conversationId: options.conversationId,
    branchId: options.branchId,
    byParent,
    target,
    onError: options.onError,
    refresh,
    api: options.api,
  }
  return tree
}

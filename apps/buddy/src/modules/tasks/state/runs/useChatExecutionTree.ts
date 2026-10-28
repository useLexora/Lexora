import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalExecutionInputReceipt } from '@buddy-shared/executions/executionInputReceipt'
import type { ExecutionTarget, LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { Ref } from 'vue'
import type { TaskExecutionTree } from '../../contracts'
import { EXECUTION_INPUT_RUN_BATCH_SIZE } from '@buddy-shared/executions/executionInputReceipt'
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
  const inputs = shallowRef<readonly LocalExecutionInputReceipt[]>([])
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
    const current = () => !disposed && options.ready.value && request === generation
      && scope.conversationId === options.conversationId.value && scope.branchId === options.branchId.value
    try {
      const value = await options.api.list(scope)
      if (!current())
        return
      records.value = value
      revision.value++
      const runIds = value.filter(record => record.kind === 'root' || record.kind === 'actor_child').map(record => record.runId)
      const nextInputs: LocalExecutionInputReceipt[] = []
      for (let start = 0; start < runIds.length; start += EXECUTION_INPUT_RUN_BATCH_SIZE) {
        const batch = runIds.slice(start, start + EXECUTION_INPUT_RUN_BATCH_SIZE)
        let offset: number | null = 0
        do {
          const page = await options.api.inputs({ ...scope, runIds: batch, offset })
          if (!current())
            return
          if (page.inputs.some(input => input.conversationId !== conversationId || input.branchId !== branchId || !batch.includes(input.runId))
            || (page.nextOffset !== null && page.nextOffset <= offset)) {
            throw new Error('Invalid execution input page')
          }
          nextInputs.push(...page.inputs)
          offset = page.nextOffset
        } while (offset !== null)
      }
      inputs.value = nextInputs
    }
    catch (error) {
      if (current())
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
  watch(() => [options.conversationId.value, options.branchId.value, options.ready.value] as const, (scope, previous) => {
    generation++
    if (scope[0] !== previous?.[0] || scope[1] !== previous?.[1]) {
      records.value = []
      inputs.value = []
    }
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
    inputs: readonly(inputs),
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

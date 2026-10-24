import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { ExecutionTarget, LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { InjectionKey, Ref } from 'vue'
import type { useChatExecutionTree } from './useChatExecutionTree'
import { computed, inject, provide, shallowReactive } from 'vue'

import { executionDisplayName } from '../../model/executions/executionDisplayName'

interface ExecutionEnvironment {
  api: LocalChatApi['executions']
  ready: Readonly<Ref<boolean>>
  selectedTarget: Readonly<Ref<ExecutionTarget | null>>
  open: (target: ExecutionTarget, label: string) => Promise<void>
  onError: (error: unknown) => void
}
const environmentKey: InjectionKey<ExecutionEnvironment> = Symbol('executionEnvironment')
const treeKey: InjectionKey<ReturnType<typeof provideExecutionTree>> = Symbol('executionTree')

export function provideExecutionEnvironment(environment: ExecutionEnvironment) {
  provide(environmentKey, environment)
}

export function useExecutionEnvironment() {
  return inject(environmentKey, null)
}

export function provideExecutionTree(tree: ReturnType<typeof useChatExecutionTree>) {
  const environment = useExecutionEnvironment()
  const expandedProcesses = shallowReactive(new Set<string>())
  const processKey = (target: ExecutionTarget) => JSON.stringify([target.conversationId, target.branchId, target.rootRunId, target.runId])
  const context = {
    isProcessExpanded: (target: ExecutionTarget) => expandedProcesses.has(processKey(target)),
    setProcessExpanded: (target: ExecutionTarget, expanded: boolean) => {
      const key = processKey(target)
      if (expanded)
        expandedProcesses.add(key)
      else
        expandedProcesses.delete(key)
    },
    ...tree,
    selectedRunId: computed(() => {
      const selected = environment?.selectedTarget.value
      return selected?.conversationId === tree.conversationId.value && selected?.branchId === tree.branchId.value ? selected.runId : null
    }),
    open: async (record: LocalExecution) => environment?.open(tree.target(record), executionDisplayName(record)),
  }
  provide(treeKey, context)
  return context
}

export function useExecutionTree() {
  return inject(treeKey, null)
}

import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { ExecutionTarget } from '@buddy-shared/executions/executionPresentationApi'
import type { InjectionKey, Ref } from 'vue'
import type { useChatExecutionTree } from './useChatExecutionTree'
import { inject, provide } from 'vue'

interface ExecutionEnvironment {
  api: LocalChatApi['executions']
  ready: Readonly<Ref<boolean>>
  selectedTarget: Readonly<Ref<ExecutionTarget | null>>
  open: (target: ExecutionTarget, label: string) => Promise<void>
  onError: (error: unknown) => void
}
const environmentKey: InjectionKey<ExecutionEnvironment> = Symbol('executionEnvironment')
const treeKey: InjectionKey<ReturnType<typeof useChatExecutionTree>> = Symbol('executionTree')

export function provideExecutionEnvironment(environment: ExecutionEnvironment) {
  provide(environmentKey, environment)
}

export function useExecutionEnvironment() {
  return inject(environmentKey, null)
}

export function provideExecutionTree(tree: ReturnType<typeof useChatExecutionTree>) {
  provide(treeKey, tree)
}

export function useExecutionTree() {
  return inject(treeKey, null)
}

import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { Ref } from 'vue'
import type { ChatSession } from './conversations/useChatSession'
import type { TaskModelSelection } from './drafts/typing'
import type { useTaskWorkspacePersistence } from './drafts/useTaskWorkspacePersistence'
import type { ChatRunSync } from './runs/typing'
import type { TaskIndexData } from './task-index/useTaskIndexData'
import { readonly, shallowRef } from 'vue'

interface TaskLifecycleOptions {
  api: LocalChatApi
  activeConversation: Readonly<Ref<LocalConversation | null>>
  clearError: () => void
  onError: (error: unknown) => void
  refreshBranches: () => Promise<void>
  runSync: Pick<ChatRunSync, 'handleRunEvent' | 'refreshActiveConversation'>
  session: ChatSession
  taskIndex: TaskIndexData
  taskModels: TaskModelSelection
  restoreScopeModel: (fallback: LocalConversation['modelSelection']) => void
  workspacePersistence: ReturnType<typeof useTaskWorkspacePersistence>
}

export function useTaskLifecycle(options: TaskLifecycleOptions) {
  const isLoading = shallowRef(true)
  let resolveInitialLoad: () => void
  const initialLoad = new Promise<void>((resolve) => {
    resolveInitialLoad = resolve
  })
  const hasCompletedInitialLoad = shallowRef(false)
  let isDisposed = false
  let initialization: Promise<void> | null = null
  let runtimeRefresh: Promise<void> | null = null

  function initialize(): Promise<void> {
    if (initialization)
      return initialization
    initialization = loadInitialState()
    return initialization
  }

  async function loadInitialState() {
    isLoading.value = true
    options.clearError()
    const navigation = options.session.generation()
    const modelSelection = JSON.stringify(options.taskModels.currentSelection())
    try {
      const navigationReady = options.taskIndex.initialize()
      if (await options.workspacePersistence.restore(navigationReady))
        await refreshActiveConversation(navigation, modelSelection)
    }
    catch (error) {
      if (!isDisposed)
        options.onError(error)
    }
    finally {
      isLoading.value = false
      if (!hasCompletedInitialLoad.value) {
        hasCompletedInitialLoad.value = true
        resolveInitialLoad()
      }
    }
  }

  function refreshRuntimeDependentState(): Promise<void> {
    if (runtimeRefresh)
      return runtimeRefresh
    runtimeRefresh = refreshRuntime().finally(() => runtimeRefresh = null)
    return runtimeRefresh
  }

  async function refreshRuntime() {
    if (options.workspacePersistence.restorationState.value === 'failed')
      options.clearError()
    const navigation = options.session.generation()
    const modelSelection = JSON.stringify(options.taskModels.currentSelection())
    try {
      const restored = options.workspacePersistence.restore()
      if (await restored)
        await refreshActiveConversation(navigation, modelSelection)
    }
    catch (error) {
      if (!isDisposed)
        options.onError(error)
    }
  }

  async function refreshActiveConversation(navigation: number, modelSelection: string) {
    if (isDisposed || !options.session.isCurrent(navigation) || !options.session.activeConversationId.value)
      return
    const conversation = options.activeConversation.value
    options.session.setActiveBranch(conversation?.activeBranchId ?? null)
    if (JSON.stringify(options.taskModels.currentSelection()) === modelSelection)
      options.restoreScopeModel(conversation?.modelSelection ?? null)
    await Promise.all([
      options.refreshBranches(),
      options.runSync.refreshActiveConversation(),
    ])
  }

  const stopRunEventListener = options.api.chat.onRunEvent(event => options.runSync.handleRunEvent(event))

  return {
    hasCompletedInitialLoad: readonly(hasCompletedInitialLoad),
    initialLoad,
    initialize,
    isLoading: readonly(isLoading),
    refreshRuntimeDependentState,
    dispose() {
      isDisposed = true
      stopRunEventListener()
    },
  }
}

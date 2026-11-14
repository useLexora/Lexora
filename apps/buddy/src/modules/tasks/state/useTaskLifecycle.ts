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
      const [restored] = await Promise.all([
        options.workspacePersistence.restore(navigationReady),
        navigationReady.then(() => refreshConversationContent(navigation)).catch((error) => {
          if (!isDisposed)
            options.onError(error)
        }),
      ])
      if (restored)
        restoreConversationModel(navigation, modelSelection)
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
      if (await restored) {
        restoreConversationModel(navigation, modelSelection)
        await refreshConversationContent(navigation)
      }
    }
    catch (error) {
      if (!isDisposed)
        options.onError(error)
    }
  }

  function restoreConversationModel(navigation: number, modelSelection: string) {
    if (!isDisposed && options.session.isCurrent(navigation) && options.session.activeConversationId.value
      && JSON.stringify(options.taskModels.currentSelection()) === modelSelection) {
      options.restoreScopeModel(options.activeConversation.value?.modelSelection ?? null)
    }
  }

  async function refreshConversationContent(navigation: number) {
    if (isDisposed || !options.session.isCurrent(navigation) || !options.session.activeConversationId.value)
      return
    const selected = options.session.activeBranchId.value
    const conversationId = options.session.activeConversationId.value
    const verifySelection = async () => {
      await options.refreshBranches()
      if (isDisposed || !options.session.isCurrent(navigation, conversationId) || options.session.activeBranchId.value !== selected)
        return
      const branches = options.session.branches.value
      if (selected && !branches.some(branch => branch.id === selected && branch.conversationId === conversationId))
        throw new Error('TASK_BRANCH_UNAVAILABLE')
      if (!selected) {
        const initial = options.activeConversation.value?.activeBranchId
        if (!initial || !branches.some(branch => branch.id === initial))
          throw new Error('TASK_BRANCH_UNAVAILABLE')
        options.session.setActiveBranch(initial)
      }
    }
    if (selected) {
      await Promise.all([verifySelection(), options.runSync.refreshActiveConversation()])
    }
    else {
      await verifySelection()
      if (!isDisposed && options.session.isCurrent(navigation, conversationId))
        await options.runSync.refreshActiveConversation()
    }
  }

  const sourceRevisions = new Map<string, number>()
  let contentRefresh: ReturnType<typeof setTimeout> | null = null
  function refreshCommittedContent(event: { sourceId: string, revision: number, conversationId: string }) {
    if (isDisposed || (sourceRevisions.get(event.sourceId) ?? 0) >= event.revision)
      return
    sourceRevisions.set(event.sourceId, event.revision)
    if (sourceRevisions.size > 16)
      sourceRevisions.delete(sourceRevisions.keys().next().value!)
    if (event.conversationId !== options.session.activeConversationId.value)
      return
    if (contentRefresh !== null)
      clearTimeout(contentRefresh)
    contentRefresh = setTimeout(() => {
      contentRefresh = null
      if (!isDisposed)
        void options.runSync.refreshActiveConversation().catch(options.onError)
    }, 100)
  }
  const stopTimeline = options.api.conversations.onTimelineChanged(refreshCommittedContent)
  const stopArtifacts = options.api.artifacts.onChanged(refreshCommittedContent)
  const stopChanges = options.api.changes.onChanged(refreshCommittedContent)
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
      stopTimeline()
      stopArtifacts()
      stopChanges()
      if (contentRefresh !== null)
        clearTimeout(contentRefresh)
      sourceRevisions.clear()
    },
  }
}

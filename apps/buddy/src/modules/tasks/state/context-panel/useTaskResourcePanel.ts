import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { UseTaskContextPanelOptions } from './typing'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { browserTabId, isBrowserArtifact } from '../../model/context-panel/taskContextPanel'
import { useTaskContextPanel } from './useTaskContextPanel'

interface TaskResourcePanelOptions extends UseTaskContextPanelOptions {
  closeView?: (id: string) => Promise<boolean>
  closeFiles?: (tabId: string) => Promise<boolean>
  browser: Pick<DesktopBrowserApi, 'ensureSession' | 'close' | 'openArtifact' | 'onStateChanged'>
}

export function useTaskResourcePanel(options: TaskResourcePanelOptions) {
  const taskContext = useTaskContextPanel(options)
  const browserStates = shallowRef<Readonly<Record<string, DesktopBrowserState>>>({})
  const activeBrowserState = computed(() => {
    const tab = taskContext.activeTab.value
    return tab?.kind === 'browser' ? browserStates.value[tab.id] ?? null : null
  })
  function updateBrowserState(state: DesktopBrowserState) {
    const entry = Object.entries(browserStates.value).find(([, previous]) => previous.sessionId === state.sessionId)
    if (entry)
      browserStates.value = { ...browserStates.value, [entry[0]]: state }
  }
  const stopBrowserState = options.browser.onStateChanged((state) => {
    const entry = Object.entries(browserStates.value).find(([, previous]) => previous.sessionId === state.sessionId)
    if (entry)
      browserStates.value = { ...browserStates.value, [entry[0]]: state }
  })
  let operation = 0
  let disposed = false
  watch(() => taskContext.activeTab.value?.id, () => {
    operation += 1
  }, { flush: 'sync' })
  watch(taskContext.isOpen, (open) => {
    if (!open)
      operation += 1
  }, { flush: 'sync' })
  onScopeDispose(() => {
    stopBrowserState()
    disposed = true
    operation += 1
    for (const [id, state] of Object.entries(browserStates.value)) {
      if (id !== browserTabId(state.conversationId))
        void options.browser.close(state.sessionId).catch(() => {})
    }
  })

  function retainBrowserSession(state: DesktopBrowserState, key?: string) {
    const id = browserTabId(state.conversationId, key)
    if (disposed || !taskContext.hasTab(id)) {
      if (key)
        void options.browser.close(state.sessionId).catch(() => {})
      return
    }
    if (!browserStates.value[id] || browserStates.value[id].sessionId !== state.sessionId)
      browserStates.value = { ...browserStates.value, [id]: state }
  }

  function act(action: () => void) {
    operation += 1
    action()
  }

  function currentOperation() {
    const version = operation
    const activeTabId = taskContext.activeTab.value?.id
    return () => !disposed && version === operation
      && taskContext.activeTab.value?.id === activeTabId
  }

  async function closeTab(tabId: string): Promise<boolean> {
    const tab = taskContext.allTabs.value.find(item => item.id === tabId)
    if (!tab)
      return false
    if (tab.kind === 'files' && options.closeFiles && !await options.closeFiles(tab.id))
      return false
    if (tab.kind === 'view' && options.closeView && !await options.closeView(tab.viewId))
      return false
    act(() => taskContext.closeTab(tabId))
    if (tab.kind !== 'browser' || (tab.browserKey && !browserStates.value[tab.id]))
      return true
    const isCurrent = currentOperation()
    try {
      const state = browserStates.value[tab.id] ?? await options.browser.ensureSession(tab.conversationId, tab.browserKey)
      if (!isCurrent() && !tab.browserKey)
        return false
      await options.browser.close(state.sessionId)
      if (browserStates.value[tab.id]?.sessionId === state.sessionId)
        browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([id]) => id !== tab.id))
      return true
    }
    catch {
      if (!disposed && (tab.browserKey || isCurrent()))
        taskContext.restoreTab(tab)
      return false
    }
  }

  async function openArtifact(target: string | LocalArtifact): Promise<void> {
    const artifact = typeof target === 'string'
      ? options.runOutputs.value.flatMap(output => output.artifacts).find(item => item.artifactId === target)
      : target
    if (!artifact)
      return
    const conversationId = artifact.conversationId
    if (!isBrowserArtifact(artifact)) {
      act(() => taskContext.openArtifact(artifact))
      return
    }
    act(() => taskContext.openBrowser({ conversationId, runId: artifact.runId }))
    const isCurrent = currentOperation()
    try {
      const state = await options.browser.ensureSession(conversationId)
      if (isCurrent())
        await options.browser.openArtifact(state.sessionId, artifact.artifactId)
    }
    catch {
      if (isCurrent())
        taskContext.openArtifact(artifact)
    }
  }

  return {
    ...taskContext,
    activeBrowserState,
    browserStates: readonly(browserStates),
    updateBrowserState,
    retainBrowserSession,
    addBrowser: () => act(taskContext.addBrowser),
    openFiles: (spaceId: string) => act(() => taskContext.openFiles(spaceId)),
    previewFile: (path: string) => act(() => taskContext.previewFile(path)),
    closeTab,
    discardDraft: (id: string) => {
      operation += 1
      const removedIds = new Set(taskContext.discardDraft(id).map(tab => tab.id))
      const sessions = Object.entries(browserStates.value).filter(([tabId]) => removedIds.has(tabId))
      browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([tabId]) => !removedIds.has(tabId)))
      return async () => {
        await Promise.all(sessions.map(([, state]) => options.browser.close(state.sessionId)))
      }
    },
    discardConversation: (id: string) => act(() => {
      const removedIds = new Set(taskContext.discardConversation(id).map(tab => tab.id))
      browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([tabId, state]) => {
        if (!removedIds.has(tabId) && state.conversationId !== id)
          return true
        if (state.conversationId === null)
          void options.browser.close(state.sessionId).catch(options.onError)
        return false
      }))
    }),
    openArtifact,
    openBrowser: () => act(taskContext.openBrowser),
    openChanges: (target?: Parameters<typeof taskContext.openChanges>[0]) => act(() => taskContext.openChanges(target)),
    selectTab: (id: string) => act(() => taskContext.selectTab(id)),
    toggle: () => act(taskContext.toggle),
  }
}

export type TaskResourcePanel = ReturnType<typeof useTaskResourcePanel>

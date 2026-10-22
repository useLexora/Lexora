import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { BrowserPreferences } from '@buddy-shared/browser/browserPreferences'
import type { ContextPanelSource } from '@buddy-shared/context-panel/contextPanel'
import type { Ref } from 'vue'
import type { UseTaskContextPanelOptions } from './typing'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { browserTabId, contextTabSource, isBrowserArtifact } from '../../model/context-panel/taskContextPanel'
import { resolveChatArtifactTarget } from '../../model/transcript/chatToolFileTarget'
import { useTaskContextPanel } from './useTaskContextPanel'

interface TaskResourcePanelOptions extends UseTaskContextPanelOptions {
  autoCollapse: Readonly<Ref<boolean>>
  linkOpening: Readonly<Ref<BrowserPreferences['linkOpening']>>
  closeView?: (id: string) => Promise<boolean>
  closeFiles?: (tabId: string) => Promise<boolean>
  browser: Pick<DesktopBrowserApi, 'ensureSession' | 'close' | 'openArtifact' | 'onStateChanged' | 'navigate'>
}

export function useTaskResourcePanel(options: TaskResourcePanelOptions) {
  const taskContext = useTaskContextPanel(options)
  const browserStates = shallowRef<Readonly<Record<string, DesktopBrowserState>>>({})
  const pendingSessions = new Map<string, Promise<DesktopBrowserState>>()
  const closingTabs = new Map<string, Promise<boolean>>()
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
  let interaction = 0
  let disposed = false
  watch(() => taskContext.activeTab.value?.id, (_, previous) => {
    operation += 1
    if (!previous || !closingTabs.has(previous) || taskContext.hasTab(previous))
      interaction += 1
  }, { flush: 'sync' })
  watch(taskContext.selectionScope, () => {
    operation += 1
    interaction += 1
  }, { flush: 'sync' })
  watch(taskContext.isOpen, (open) => {
    interaction += 1
    if (!open)
      operation += 1
  }, { flush: 'sync' })
  onScopeDispose(() => {
    stopBrowserState()
    disposed = true
    operation += 1
    interaction += 1
    for (const [id, state] of Object.entries(browserStates.value)) {
      if (id !== browserTabId(state.conversationId) && !closingTabs.has(id))
        void options.browser.close(state.sessionId).catch(() => {})
    }
  })

  function retainBrowserSession(state: DesktopBrowserState, key?: string) {
    const id = browserTabId(state.conversationId, key)
    if (disposed || !taskContext.hasTab(id)) {
      if (key && !closingTabs.has(id)) {
        void options.browser.close(state.sessionId).catch(() => {
          if (!disposed)
            options.onError()
        })
      }
      return
    }
    if (!browserStates.value[id] || browserStates.value[id].sessionId !== state.sessionId)
      browserStates.value = { ...browserStates.value, [id]: state }
  }

  function ensureBrowserSession(conversationId: string | null, key?: string): Promise<DesktopBrowserState> {
    const id = browserTabId(conversationId, key)
    if (disposed || !taskContext.hasTab(id))
      return Promise.reject(new Error('BROWSER_TAB_CLOSED'))
    const pending = pendingSessions.get(id)
    if (pending)
      return pending
    const request = options.browser.ensureSession(conversationId, key).finally(() => pendingSessions.delete(id))
    pendingSessions.set(id, request)
    return request
  }

  function act(action: () => void) {
    operation += 1
    interaction += 1
    action()
  }

  function currentOperation() {
    const version = operation
    const activeTabId = taskContext.activeTab.value?.id
    return () => !disposed && version === operation
      && taskContext.activeTab.value?.id === activeTabId
  }

  function closeTab(tabId: string): Promise<boolean> {
    const pending = closingTabs.get(tabId)
    if (pending)
      return pending
    const accepted = Promise.withResolvers<boolean>()
    closingTabs.set(tabId, accepted.promise)
    void closeResource(tabId).finally(() => closingTabs.delete(tabId)).then(accepted.resolve, accepted.reject)
    return accepted.promise
  }

  async function closeResource(tabId: string): Promise<boolean> {
    const tab = taskContext.allTabs.value.find(item => item.id === tabId)
    if (!tab)
      return false
    const closingScope = taskContext.selectionScope.value
    const closingSource = contextTabSource(tab) ?? taskContext.getSource()
    const wasVisible = taskContext.tabs.value.some(item => item.id === tabId)
    operation += 1
    const version = ++interaction
    if (tab.kind === 'files' && options.closeFiles && !await options.closeFiles(tab.id))
      return false
    if (tab.kind === 'view' && options.closeView && !await options.closeView(tab.viewId))
      return false
    if (tab.kind === 'browser') {
      try {
        const session = pendingSessions.get(tab.id) ?? browserStates.value[tab.id]
          ?? (!tab.browserKey ? ensureBrowserSession(tab.conversationId) : null)
        if (session) {
          const state = await session
          const current = taskContext.allTabs.value.find(item => item.id === tabId)
          if (current !== tab && (current || !tab.browserKey))
            return false
          if (current === tab)
            retainBrowserSession(state, tab.browserKey)
          await options.browser.close(state.sessionId)
          if (browserStates.value[tab.id]?.sessionId === state.sessionId)
            browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([id]) => id !== tab.id))
        }
      }
      catch {
        return false
      }
    }
    const current = taskContext.allTabs.value.find(item => item.id === tabId)
    if (current && current !== tab)
      return true
    operation += 1
    taskContext.closeTab(tabId)
    if (options.autoCollapse.value && wasVisible && !disposed && interaction === version
      && taskContext.selectionScope.value === closingScope && !taskContext.tabs.value.length) {
      await taskContext.closePanel(closingSource)
    }
    return true
  }

  function findArtifact(id: string) {
    const tab = taskContext.allTabs.value.find(tab => tab.kind === 'artifact' && tab.artifact.artifactId === id)
    return tab?.kind === 'artifact' ? tab.artifact : options.runOutputs.value.flatMap(output => output.artifacts).find(item => item.artifactId === id)
  }

  async function openArtifact(target: string | LocalArtifact): Promise<void> {
    const artifact = typeof target === 'string'
      ? findArtifact(target)
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
      const state = await ensureBrowserSession(conversationId)
      if (isCurrent())
        await options.browser.openArtifact(state.sessionId, artifact.artifactId)
    }
    catch {
      if (isCurrent())
        taskContext.openArtifact(artifact)
    }
  }

  async function openWebLink(url: string, source?: ContextPanelSource): Promise<void> {
    if (!/^https?:\/\//i.test(url))
      return
    if (options.linkOpening.value === 'system') {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    const conversationId = source?.conversationId ?? options.activeConversationId.value
    if (!conversationId)
      return
    act(() => taskContext.openBrowser(source))
    const isCurrent = currentOperation()
    try {
      const state = await ensureBrowserSession(conversationId)
      retainBrowserSession(state)
      if (isCurrent())
        updateBrowserState(await options.browser.navigate(state.sessionId, url))
    }
    catch {
      if (isCurrent())
        options.onError()
    }
  }

  function fileArtifact(path: string, source?: ContextPanelSource) {
    const conversationId = source?.conversationId ?? options.activeConversationId.value
    return resolveChatArtifactTarget(options.runOutputs.value.flatMap(output => output.artifacts)
      .filter(artifact => artifact.conversationId === conversationId), path)
  }

  function canPreviewFile(path: string) {
    return Boolean(fileArtifact(path)) || taskContext.canPreviewFile(path)
  }

  async function previewFile(path: string, source?: ContextPanelSource) {
    const artifact = fileArtifact(path, source)
    if (artifact)
      await openArtifact(artifact)
    else
      act(() => taskContext.previewFile(path, source))
  }

  return {
    ...taskContext,
    activeBrowserState,
    browserStates: readonly(browserStates),
    updateBrowserState,
    retainBrowserSession,
    ensureBrowserSession,
    addBrowser: () => act(taskContext.addBrowser),
    openFiles: (spaceId: string, directoryId?: string) => act(() => taskContext.openFiles(spaceId, directoryId)),
    locateFile: (...args: Parameters<typeof taskContext.locateFile>) => act(() => taskContext.locateFile(...args)),
    openWebLink,
    canPreviewFile,
    previewFile,
    closeTab,
    discardDraft: (id: string) => {
      operation += 1
      interaction += 1
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
    findArtifact,
    openArtifact,
    openBrowser: () => act(taskContext.openBrowser),
    openChanges: (...args: Parameters<typeof taskContext.openChanges>) => act(() => taskContext.openChanges(...args)),
    selectTab: (id: string) => act(() => taskContext.selectTab(id)),
    toggle: () => act(taskContext.toggle),
  }
}

export type TaskResourcePanel = ReturnType<typeof useTaskResourcePanel>

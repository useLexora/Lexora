import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { TaskBrowserContextTab } from '../../model/context-panel/taskContextPanel'
import type { useTaskContextPanel } from './useTaskContextPanel'
import type { BrowserGuestCatalog } from '@/platform/browser/BrowserGuestCatalog'
import { browserAgentTabId } from '@buddy-shared/browser/session'
import { onScopeDispose, readonly, shallowRef } from 'vue'
import { browserTabId, isAgentBrowserTab } from '../../model/context-panel/taskContextPanel'

export function useTaskBrowserSessions(options: {
  browser: Pick<DesktopBrowserApi, 'ensureSession' | 'close' | 'onStateChanged'>
  guestCatalog: BrowserGuestCatalog
  context: Pick<ReturnType<typeof useTaskContextPanel>, 'hasTab' | 'registerAgentBrowser' | 'closeTab' | 'allTabs'>
  closingTabs: ReadonlyMap<string, Promise<boolean>>
  onError: (error?: unknown) => void
}) {
  const { context: taskContext, closingTabs } = options
  const browserStates = shallowRef<Readonly<Record<string, DesktopBrowserState>>>({})
  const pendingSessions = new Map<string, Promise<DesktopBrowserState>>()
  const pendingAgentStates = new Map<string, DesktopBrowserState>()
  let guestRevision = 0
  let refreshingGuests = false
  let disposed = false
  function updateBrowserState(state: DesktopBrowserState) {
    const entry = Object.entries(browserStates.value).find(([, previous]) => previous.sessionId === state.sessionId)
    if (entry)
      browserStates.value = { ...browserStates.value, [entry[0]]: state }
  }
  const stopBrowserState = options.browser.onStateChanged((state) => {
    if (disposed)
      return
    if (state.owner && state.conversationId) {
      const id = browserTabId(state.conversationId, browserAgentTabId(state.owner.runId))
      if (closingTabs.has(id))
        return
      if (browserStates.value[id]?.sessionId !== state.sessionId) {
        pendingAgentStates.set(state.sessionId, state)
        scheduleGuestRefresh()
        return
      }
    }
    updateBrowserState(state)
  })
  const stopBrowserGuests = options.guestCatalog.onChanged(scheduleGuestRefresh)
  onScopeDispose(() => {
    stopBrowserState()
    stopBrowserGuests()
    disposed = true
    pendingAgentStates.clear()
    for (const [id, state] of Object.entries(browserStates.value)) {
      if (!state.owner && id !== browserTabId(state.conversationId) && !closingTabs.has(id))
        void options.browser.close(state.sessionId).catch(() => {})
    }
  })
  scheduleGuestRefresh()

  function scheduleGuestRefresh() {
    guestRevision += 1
    if (!disposed && !refreshingGuests)
      void refreshAgentSessions()
  }

  async function refreshAgentSessions() {
    refreshingGuests = true
    let revision = guestRevision
    try {
      do {
        revision = guestRevision
        const observed = Object.entries(browserStates.value)
        const guests = await options.guestCatalog.refresh()
        if (disposed)
          return
        if (revision !== guestRevision)
          continue
        const recovered = await Promise.all(guests.map(async (guest) => {
          if (!guest.owner || !guest.conversationId || pendingAgentStates.has(guest.sessionId))
            return null
          const key = browserAgentTabId(guest.owner.runId)
          const id = browserTabId(guest.conversationId, key)
          if (closingTabs.has(id) || browserStates.value[id]?.sessionId === guest.sessionId)
            return null
          const state = await requestBrowserSession(guest.conversationId, key).catch(() => null)
          return state?.sessionId === guest.sessionId && state.conversationId === guest.conversationId
            && state.owner?.runId === guest.owner.runId && state.owner.buddyId === guest.owner.buddyId
            ? state
            : null
        }))
        if (disposed)
          return
        if (revision !== guestRevision)
          continue
        const live = new Set(guests.map(guest => guest.sessionId))
        for (const state of [...recovered, ...pendingAgentStates.values()]) {
          if (!state?.owner || !state.conversationId || !live.has(state.sessionId))
            continue
          const id = browserTabId(state.conversationId, browserAgentTabId(state.owner.runId))
          if (closingTabs.has(id))
            continue
          taskContext.registerAgentBrowser({ conversationId: state.conversationId, runId: state.owner.runId })
          if (taskContext.hasTab(id))
            browserStates.value = { ...browserStates.value, [id]: state }
        }
        pendingAgentStates.clear()
        for (const [id, state] of observed) {
          if (!state.owner || live.has(state.sessionId) || browserStates.value[id]?.sessionId !== state.sessionId || closingTabs.has(id))
            continue
          browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([key]) => key !== id))
          taskContext.closeTab(id)
        }
      } while (revision !== guestRevision)
    }
    catch {
      if (revision === guestRevision)
        pendingAgentStates.clear()
    }
    finally {
      refreshingGuests = false
      if (!disposed && revision !== guestRevision)
        void refreshAgentSessions()
    }
  }

  function retainBrowserSession(state: DesktopBrowserState, key?: string) {
    const id = browserTabId(state.conversationId, state.owner ? browserAgentTabId(state.owner.runId) : key)
    if (disposed || !taskContext.hasTab(id)) {
      if (key && !state.owner && !closingTabs.has(id)) {
        void options.browser.close(state.sessionId).catch(() => {
          if (!disposed)
            options.onError()
        })
      }
      return
    }
    if (state.owner) {
      if (browserStates.value[id]?.sessionId !== state.sessionId && !closingTabs.has(id)) {
        pendingAgentStates.set(state.sessionId, state)
        scheduleGuestRefresh()
      }
    }
    else if (!browserStates.value[id] || browserStates.value[id].sessionId !== state.sessionId) {
      browserStates.value = { ...browserStates.value, [id]: state }
    }
  }

  function ensureBrowserSession(conversationId: string | null, key?: string): Promise<DesktopBrowserState> {
    const id = browserTabId(conversationId, key)
    if (disposed || !taskContext.hasTab(id))
      return Promise.reject(new Error('BROWSER_TAB_CLOSED'))
    return requestBrowserSession(conversationId, key)
  }

  function requestBrowserSession(conversationId: string | null, key?: string): Promise<DesktopBrowserState> {
    const id = browserTabId(conversationId, key)
    const pending = pendingSessions.get(id)
    if (pending)
      return pending
    const request = options.browser.ensureSession(conversationId, key).finally(() => {
      if (pendingSessions.get(id) === request)
        pendingSessions.delete(id)
    })
    pendingSessions.set(id, request)
    return request
  }

  async function close(tab: TaskBrowserContextTab): Promise<boolean> {
    const tabId = tab.id
    try {
      const session = pendingSessions.get(tab.id) ?? browserStates.value[tab.id]
        ?? (!tab.browserKey || isAgentBrowserTab(tab) ? ensureBrowserSession(tab.conversationId, tab.browserKey) : null)
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
    catch (error) {
      if (!isAgentBrowserTab(tab) || !tab.source)
        return false
      const source = tab.source
      const revision = guestRevision
      try {
        const guests = await options.guestCatalog.refresh()
        if (revision !== guestRevision || guests.some(guest => guest.conversationId === source.conversationId && guest.owner?.runId === source.runId)) {
          options.onError(error)
          return false
        }
      }
      catch (inspectionError) {
        options.onError(inspectionError)
        return false
      }
      for (const [sessionId, state] of pendingAgentStates) {
        if (state.conversationId === source.conversationId && state.owner?.runId === source.runId)
          pendingAgentStates.delete(sessionId)
      }
      browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([id]) => id !== tab.id))
    }
    return true
  }

  function detachTabs(removedIds: ReadonlySet<string>) {
    const sessions = Object.entries(browserStates.value).filter(([tabId]) => removedIds.has(tabId))
    browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([tabId]) => !removedIds.has(tabId)))
    return async () => {
      await Promise.all(sessions.map(([, state]) => options.browser.close(state.sessionId)))
    }
  }

  function discardConversation(id: string, removedIds: ReadonlySet<string>) {
    browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([tabId, state]) => {
      if (!removedIds.has(tabId) && state.conversationId !== id)
        return true
      if (state.conversationId === null)
        void options.browser.close(state.sessionId).catch(options.onError)
      return false
    }))
  }

  return { browserStates: readonly(browserStates), updateBrowserState, retainBrowserSession, ensureBrowserSession, close, detachTabs, discardConversation }
}

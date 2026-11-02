import type { DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import { browserAgentTabId } from '@buddy-shared/browser/session'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { browserTabId } from '../../../model/context-panel/taskContextPanel'
import { useTaskResourcePanel } from '../useTaskResourcePanel'
import { contextPanelFixture } from './contextPanelFixture'

type PanelOptions = Parameters<typeof useTaskResourcePanel>[0]

function agentState(runId: string, sessionId = runId, conversationId = 'task'): DesktopBrowserState {
  return {
    sessionId,
    conversationId,
    owner: { runId, buddyId: `buddy-${runId}` },
    pageId: `page-${sessionId}`,
    url: `https://example.com/${runId}`,
    title: runId,
    controller: 'agent',
    controlEpoch: 1,
    profileMode: 'default',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    security: { kind: 'secure', origin: 'https://example.com' },
    error: null,
    zoomFactor: 1,
    visible: false,
  }
}

function tabId(runId: string, conversationId = 'task') {
  return browserTabId(conversationId, browserAgentTabId(runId))
}

function fixture(mode: 'task' | 'space' | 'independent' = 'task') {
  const activeConversationId = shallowRef<string | null>('task')
  const f = contextPanelFixture({
    activeConversationId,
    mode: shallowRef(mode),
    scopeSpaceIds: shallowRef(new Map([['task:task', 'space'], ['task:other', 'space']])),
  })
  const sessions = new Map<string, DesktopBrowserState>()
  let stateListener: (state: DesktopBrowserState) => void = () => {}
  let guestListener = () => {}
  const browser: PanelOptions['browser'] = {
    onStateChanged: (listener) => {
      stateListener = listener
      return () => stateListener = () => {}
    },
    onGuestsChanged: (listener) => {
      guestListener = listener
      return () => guestListener = () => {}
    },
    listGuests: async () => [...sessions.values()].map(state => ({ sessionId: state.sessionId, partition: 'test', owner: state.owner, conversationId: state.conversationId ?? undefined })),
    ensureSession: async (conversationId, key) => {
      const state = [...sessions.values()].find(state => state.conversationId === conversationId && state.owner && browserAgentTabId(state.owner.runId) === key)
      if (!state)
        throw new Error('BROWSER_SESSION_NOT_FOUND')
      return state
    },
    close: async (sessionId) => {
      sessions.delete(sessionId)
      guestListener()
    },
    navigate: async () => { throw new Error('Unexpected navigation') },
    openArtifact: async () => { throw new Error('Unexpected artifact') },
    openFile: async () => { throw new Error('Unexpected file') },
  }
  const panelOptions: PanelOptions = {
    ...f.options,
    browser,
    autoCollapse: shallowRef(false),
    linkOpening: shallowRef('in-app'),
    files: { resolve: async () => { throw new Error('Unexpected file') } },
    openFile: async () => { throw new Error('Unexpected file') },
  }
  const panel = f.scope.run(() => useTaskResourcePanel(panelOptions))!
  return {
    ...f,
    panel,
    panelOptions,
    browser,
    sessions,
    activeConversationId,
    publish: (state: DesktopBrowserState) => {
      sessions.set(state.sessionId, state)
      stateListener(state)
    },
    lateState: (state: DesktopBrowserState) => stateListener(state),
    guestsChanged: () => guestListener(),
  }
}

describe('agent browser resources', () => {
  it('rediscovers live owner pages after remount without waiting for new state events', async () => {
    const f = fixture()
    const first = agentState('first')
    const second = agentState('second')
    f.publish(first)
    f.publish(second)
    await vi.waitFor(() => expect(f.panel.tabs.value).toHaveLength(2))
    f.scope.stop()
    const latest = { ...first, title: 'Changed while detached', controller: 'human' as const }
    f.sessions.set(first.sessionId, latest)
    const scope = effectScope()
    onTestFinished(() => scope.stop())
    const panel = scope.run(() => useTaskResourcePanel(f.panelOptions))!
    await vi.waitFor(() => expect(panel.tabs.value).toHaveLength(2))
    expect(panel.isOpen.value).toBe(false)
    expect(panel.activeTab.value).toBeNull()
    expect(f.operations).toEqual([])
    await panel.toggle()
    panel.selectTab(tabId('first'))
    expect(panel.activeBrowserState.value).toEqual(latest)
    panel.selectTab(tabId('second'))
    expect(panel.activeBrowserState.value).toEqual(second)
    expect([...f.sessions.keys()]).toEqual(['first', 'second'])
  })

  it('does not register a discovered page after its pending lookup is closed', async () => {
    const f = fixture()
    const state = agentState('run')
    f.sessions.set(state.sessionId, state)
    const lookup = deferred<DesktopBrowserState>()
    const entered = deferred<void>()
    f.browser.ensureSession = () => {
      entered.resolve()
      return lookup.promise
    }
    f.guestsChanged()
    await entered.promise
    await f.host.execute({ action: 'open', target: { kind: 'browser', source: { conversationId: 'task', runId: 'run' } } }, 'harness')
    const closing = f.panel.closeTab(tabId('run'))
    lookup.resolve(state)
    expect(await closing).toBe(true)
    await nextTick()
    f.lateState(state)
    await nextTick()
    expect(f.panel.tabs.value).toEqual([])
    expect(f.panel.activeBrowserState.value).toBeNull()
    expect(f.sessions.size).toBe(0)
  })

  it.each(['task', 'space', 'independent'] as const)('discovers owner pages without opening the panel or replacing the selected resource in %s mode', async (mode) => {
    const f = fixture(mode)
    const first = agentState('first')
    const second = agentState('second')
    f.publish(first)
    f.publish(second)
    await vi.waitFor(() => expect(f.panel.tabs.value).toHaveLength(2))
    expect(f.panel.activeTab.value).toBeNull()
    expect(f.panel.isOpen.value).toBe(false)
    expect(f.operations).toEqual([])

    await f.panel.toggle()
    f.panel.selectTab(tabId('first'))
    expect(f.panel.activeBrowserState.value).toEqual(first)
    expect(await f.panel.ensureBrowserSession('task', browserAgentTabId('first'))).toEqual(first)
    f.panel.selectTab(tabId('second'))
    expect(f.panel.activeBrowserState.value).toEqual(second)
    await f.panel.toggle()
    f.publish({ ...first, title: 'Updated in background' })
    await nextTick()
    expect(f.panel.isOpen.value).toBe(false)
    expect(f.panel.activeTab.value?.id).toBe(tabId('second'))
    await f.panel.toggle()
    expect(f.panel.activeBrowserState.value).toEqual(second)

    f.panel.openView('document', 'Report')
    f.publish(agentState('third'))
    f.publish(agentState('fourth', 'other-session', 'other'))
    await vi.waitFor(() => expect(f.panel.allTabs.value).toHaveLength(5))
    expect(f.panel.activeTab.value?.id).toBe('document')
    expect(f.panel.isOpen.value).toBe(true)
    expect(f.panel.browserStates.value['browser:task']).toBeUndefined()
    if (mode === 'task') {
      f.activeConversationId.value = 'other'
      expect(f.panel.tabs.value.map(tab => tab.id)).toEqual([tabId('fourth', 'other')])
      expect(f.panel.activeTab.value).toBeNull()
      f.panel.selectTab(tabId('fourth', 'other'))
      expect(f.panel.activeBrowserState.value?.sessionId).toBe('other-session')
    }
  })

  it('presents the requested run and keeps manual task browsers separate', async () => {
    const f = fixture()
    f.publish(agentState('first'))
    f.publish(agentState('second'))
    await vi.waitFor(() => expect(f.panel.tabs.value).toHaveLength(2))
    f.panel.openBrowser()
    expect(f.panel.activeTab.value?.id).toBe('browser:task')
    for (const runId of ['second', 'first']) {
      await f.host.execute({ action: 'open', target: { kind: 'browser', source: { conversationId: 'task', runId } } }, 'harness')
      expect(f.panel.activeTab.value?.id).toBe(tabId(runId))
      expect(f.panel.activeBrowserState.value?.sessionId).toBe(runId)
    }
    f.panel.openBrowser()
    expect(f.panel.activeTab.value?.id).toBe('browser:task')
    expect(f.panel.tabs.value).toHaveLength(3)
  })

  it('rejects late states and session results after close while allowing a new session for the same run', async () => {
    const f = fixture()
    const old = agentState('run', 'old')
    f.publish(old)
    await vi.waitFor(() => expect(f.panel.tabs.value).toHaveLength(1))
    f.panel.selectTab(tabId('run'))
    const pending = deferred<DesktopBrowserState>()
    f.browser.ensureSession = () => pending.promise
    const ensuring = f.panel.ensureBrowserSession('task', browserAgentTabId('run'))
    f.sessions.delete('old')
    f.guestsChanged()
    await vi.waitFor(() => expect(f.panel.tabs.value).toEqual([]))
    pending.resolve(old)
    f.panel.retainBrowserSession(await ensuring, browserAgentTabId('run'))
    f.lateState(old)
    await nextTick()
    expect(f.panel.tabs.value).toEqual([])
    expect(f.panel.activeBrowserState.value).toBeNull()

    const replacement = agentState('run', 'new')
    f.publish(replacement)
    await vi.waitFor(() => expect(f.panel.tabs.value).toHaveLength(1))
    f.panel.selectTab(tabId('run'))
    expect(f.panel.activeBrowserState.value?.sessionId).toBe('new')
    await f.panel.closeTab(tabId('run'))
    f.lateState(replacement)
    await nextTick()
    expect(f.panel.tabs.value).toEqual([])
    expect(f.sessions.size).toBe(0)
  })

  it('closes an explicitly presented owner page while its first registration is pending', async () => {
    const f = fixture()
    const snapshot = deferred<Awaited<ReturnType<typeof f.browser.listGuests>>>()
    const listGuests = f.browser.listGuests
    f.browser.listGuests = () => snapshot.promise
    const state = agentState('run')
    f.publish(state)
    await f.host.execute({ action: 'open', target: { kind: 'browser', source: { conversationId: 'task', runId: 'run' } } }, 'harness')
    expect(await f.panel.closeTab(tabId('run'))).toBe(true)
    f.browser.listGuests = listGuests
    snapshot.resolve([{ sessionId: state.sessionId, partition: 'test' }])
    await nextTick()
    await nextTick()
    expect(f.panel.tabs.value).toEqual([])
    expect(f.sessions.size).toBe(0)
  })

  it.each(['absent', 'live', 'unavailable'] as const)('closes an unbound restored tab only when its owner is confirmed absent: %s', async (inspection) => {
    const f = fixture()
    f.panel.restoreTab({
      id: tabId('restored'),
      kind: 'browser',
      scope: 'task:task',
      conversationId: 'task',
      browserKey: browserAgentTabId('restored'),
      source: { conversationId: 'task', runId: 'restored' },
    })
    f.browser.ensureSession = async () => {
      throw new Error('Lookup unavailable')
    }
    if (inspection === 'live')
      f.sessions.set('restored-session', agentState('restored', 'restored-session'))
    if (inspection === 'unavailable')
      f.browser.listGuests = async () => { throw new Error('Inspection unavailable') }
    expect(await f.panel.closeTab(tabId('restored'))).toBe(inspection === 'absent')
    expect(f.panel.hasTab(tabId('restored'))).toBe(inspection !== 'absent')
    if (inspection !== 'absent')
      expect(f.options.onError).toHaveBeenCalledOnce()
  })

  it('does not accept a stale live-guest snapshot after a close notification', async () => {
    const f = fixture()
    const snapshot = deferred<Awaited<ReturnType<typeof f.browser.listGuests>>>()
    const listGuests = f.browser.listGuests
    f.browser.listGuests = () => snapshot.promise
    const state = agentState('run')
    f.publish(state)
    f.sessions.clear()
    f.browser.listGuests = listGuests
    f.guestsChanged()
    snapshot.resolve([{ sessionId: state.sessionId, partition: 'test' }])
    await nextTick()
    await nextTick()
    expect(f.panel.tabs.value).toEqual([])
    expect(f.panel.activeTab.value).toBeNull()
  })

  it('keeps registered pages when guest inspection fails and retries registration on the next event', async () => {
    const f = fixture()
    f.publish(agentState('first'))
    await vi.waitFor(() => expect(f.panel.tabs.value).toHaveLength(1))
    f.panel.selectTab(tabId('first'))
    const listGuests = f.browser.listGuests
    f.browser.listGuests = async () => {
      throw new Error('Host unavailable')
    }
    f.publish(agentState('second'))
    f.guestsChanged()
    await nextTick()
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual([tabId('first')])
    expect(f.panel.activeBrowserState.value?.sessionId).toBe('first')
    f.browser.listGuests = listGuests
    f.publish(agentState('second'))
    await vi.waitFor(() => expect(f.panel.tabs.value).toHaveLength(2))
    expect(f.panel.activeBrowserState.value?.sessionId).toBe('first')
  })

  it('retains the selected resource through profile replacement and does not close owner sessions on disposal', async () => {
    const f = fixture()
    const original = agentState('run', 'original')
    f.publish(original)
    await vi.waitFor(() => expect(f.panel.tabs.value).toHaveLength(1))
    f.panel.selectTab(tabId('run'))
    f.sessions.delete('original')
    f.publish({ ...agentState('run', 'private'), profileMode: 'incognito', controller: 'human' })
    f.guestsChanged()
    await vi.waitFor(() => expect(f.panel.activeBrowserState.value?.sessionId).toBe('private'))
    expect(f.panel.activeTab.value?.id).toBe(tabId('run'))
    f.scope.stop()
    f.panel.retainBrowserSession(original, browserAgentTabId('run'))
    expect([...f.sessions.keys()]).toEqual(['private'])
  })

  it('never projects an unowned browser event into an agent or default resource', async () => {
    const f = fixture()
    const { owner: _owner, ...manual } = agentState('manual')
    f.publish(manual)
    await nextTick()
    expect(f.panel.tabs.value).toEqual([])
    expect(f.panel.browserStates.value).toEqual({})
  })
})

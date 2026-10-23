import type { DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { useTaskResourcePanel } from '../useTaskResourcePanel'
import { contextPanelFixture } from './contextPanelFixture'

type PanelOptions = Parameters<typeof useTaskResourcePanel>[0]

function fixture(overrides: Partial<PanelOptions> = {}) {
  const f = contextPanelFixture({ activeConversationId: shallowRef('task-a'), activeRunId: shallowRef('latest-run-a') })
  const options: PanelOptions = {
    ...f.options,
    autoCollapse: shallowRef(true),
    linkOpening: shallowRef('in-app'),
    files: { resolve: async () => { throw new Error('Unexpected file resolution') } },
    openFile: async () => { throw new Error('Unexpected file opening') },
    browser: {
      navigate: async () => state('session', 'task-a'),
      onStateChanged: () => () => {},
      ensureSession: async conversationId => state('session', conversationId),
      close: async () => {},
      openFile: async () => { throw new Error('Unexpected file link') },
      openArtifact: async () => state('session', 'task-a'),
    },
    ...overrides,
  }
  const panel = f.scope.run(() => useTaskResourcePanel(options))!
  return { ...f, options, panel }
}

function state(sessionId: string, conversationId: string | null = null) {
  return { sessionId, conversationId } as DesktopBrowserState
}

function manualBrowser(panel: ReturnType<typeof useTaskResourcePanel>) {
  panel.addBrowser()
  const tab = panel.activeTab.value!
  if (tab.kind !== 'browser')
    throw new Error('Expected a browser tab')
  return tab
}

function artifact(artifactId = 'report'): LocalArtifact {
  return {
    artifactId,
    conversationId: 'task-a',
    runId: 'source-run-a',
    kind: 'file',
    name: 'report.txt',
    path: '/fixture/report.txt',
    mimeType: 'text/plain',
    previewUrl: null,
    sizeBytes: 1,
    sourceArtifactId: null,
    sourceToolCallId: 'tool',
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
  }
}

describe('resource panel close', () => {
  it.each(['space', 'independent'] as const)('records a user close with the original source only after the last visible tab closes in %s mode', async (mode) => {
    const f = fixture({
      mode: shallowRef(mode),
      activeConversationId: shallowRef(mode === 'space' ? 'task-b' : 'task-a'),
      activeRunId: shallowRef('latest-run-b'),
      scopeSpaceIds: shallowRef(new Map([['task:task-a', 'space'], ['task:task-b', 'space']])),
    })
    await f.panel.openArtifact(artifact('first'))
    await f.panel.openArtifact(artifact('last'))
    await f.panel.closeTab('artifact:first')
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual(['artifact:last'])
    expect(f.host.getState().open).toBe(true)
    expect(await f.panel.closeTab('artifact:last')).toBe(true)
    expect(f.host.getState().open).toBe(false)
    expect(f.operations.map(({ action, actor, source }) => ({ action, actor, source }))).toEqual([
      { action: 'open', actor: 'user', source: { conversationId: 'task-a', runId: 'source-run-a' } },
      { action: 'close', actor: 'user', source: { conversationId: 'task-a', runId: 'source-run-a' } },
    ])
  })

  it('does not collapse after closing a resource outside the visible scope', async () => {
    const activeConversationId = shallowRef<string | null>('task-a')
    const f = fixture({ activeConversationId })
    await f.panel.openArtifact(artifact())
    activeConversationId.value = 'task-b'
    expect(f.panel.tabs.value).toEqual([])
    await f.panel.closeTab('artifact:report')
    expect(f.host.getState().open).toBe(true)
  })

  it('preserves a cancelled close and allows the view owner to remove its tab on retry', async () => {
    const f = fixture({ closeView: async () => false })
    f.panel.openView('view', 'View', { conversationId: 'task-a', runId: 'source-run-a' })
    expect(await f.panel.closeTab('view')).toBe(false)
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual(['view'])
    expect(f.host.getState().open).toBe(true)
    f.options.closeView = async (id) => {
      f.panel.removeView(id)
      return true
    }
    expect(await f.panel.closeTab('view')).toBe(true)
    expect(f.host.getState().open).toBe(false)
    expect(f.operations.at(-1)).toMatchObject({ action: 'close', actor: 'user', source: { runId: 'source-run-a' } })
  })

  it('preserves a manual reopen while a view close is pending', async () => {
    const gate = deferred<boolean>()
    const f = fixture({ closeView: () => gate.promise })
    f.panel.openView('view', 'View')
    const closing = f.panel.closeTab('view')
    f.panel.toggle()
    f.panel.toggle()
    gate.resolve(true)
    expect(await closing).toBe(true)
    expect(f.panel.tabs.value).toEqual([])
    expect(f.host.getState().open).toBe(true)
  })

  it('checks the current switch value after asynchronous close preparation', async () => {
    const gate = deferred<boolean>()
    const autoCollapse = shallowRef(true)
    const f = fixture({ autoCollapse, closeView: () => gate.promise })
    f.panel.openView('view', 'View')
    const closing = f.panel.closeTab('view')
    autoCollapse.value = false
    gate.resolve(true)
    await closing
    expect(f.host.getState().open).toBe(true)
  })

  it('does not collapse after leaving and returning to the same empty scope', async () => {
    const gate = deferred<boolean>()
    const activeConversationId = shallowRef<string | null>('task-a')
    const f = fixture({ activeConversationId, closeView: () => gate.promise })
    f.panel.openView('view', 'View')
    const closing = f.panel.closeTab('view')
    activeConversationId.value = 'task-b'
    activeConversationId.value = 'task-a'
    gate.resolve(true)
    await closing
    expect(f.host.getState().open).toBe(true)
  })

  it('waits for a manual browser to initialize and release before removing its tab', async () => {
    const creation = deferred<DesktopBrowserState>()
    const release = deferred<void>()
    const sessions = new Set<string>()
    const f = fixture()
    f.options.browser.ensureSession = () => creation.promise
    f.options.browser.close = async (id) => {
      await release.promise
      if (!sessions.delete(id))
        throw new Error('Session already released')
    }
    const tab = manualBrowser(f.panel)
    const starting = f.panel.ensureBrowserSession(null, tab.browserKey)
    const closing = f.panel.closeTab(tab.id)
    const duplicate = f.panel.closeTab(tab.id)
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual([tab.id])
    expect(f.host.getState().open).toBe(true)
    sessions.add('manual-session')
    creation.resolve(state('manual-session'))
    await starting
    await nextTick()
    expect(sessions.size).toBe(1)
    expect(f.host.getState().open).toBe(true)
    release.resolve()
    expect(await Promise.all([closing, duplicate])).toEqual([true, true])
    expect(sessions.size).toBe(0)
    expect(f.panel.tabs.value).toEqual([])
    expect(f.host.getState().open).toBe(false)
  })

  it('keeps the tab and panel when browser initialization fails', async () => {
    const creation = deferred<DesktopBrowserState>()
    const f = fixture()
    f.options.browser.ensureSession = () => creation.promise
    const tab = manualBrowser(f.panel)
    const starting = f.panel.ensureBrowserSession(null, tab.browserKey)
    const closing = f.panel.closeTab(tab.id)
    creation.reject(new Error('initialization failed'))
    await expect(starting).rejects.toThrow('initialization failed')
    expect(await closing).toBe(false)
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual([tab.id])
    expect(f.host.getState().open).toBe(true)
  })

  it('releases a late manual session after its task is discarded during close', async () => {
    const creation = deferred<DesktopBrowserState>()
    const sessions = new Set<string>()
    const f = fixture()
    f.options.browser.ensureSession = () => creation.promise
    f.options.browser.close = async (id) => {
      sessions.delete(id)
    }
    const tab = manualBrowser(f.panel)
    const starting = f.panel.ensureBrowserSession(null, tab.browserKey)
    const closing = f.panel.closeTab(tab.id)
    f.panel.discardConversation('task-a')
    sessions.add('late-session')
    creation.resolve(state('late-session'))
    await starting
    expect(await closing).toBe(true)
    expect(sessions.size).toBe(0)
    expect(f.panel.allTabs.value).toEqual([])
    expect(f.host.getState().open).toBe(true)
  })

  it('keeps the panel open while another browser close is pending or failed', async () => {
    const firstClose = deferred<void>()
    const secondClose = deferred<void>()
    const f = fixture()
    f.options.browser.close = id => id === 'first' ? firstClose.promise : secondClose.promise
    const first = manualBrowser(f.panel)
    const second = manualBrowser(f.panel)
    f.panel.retainBrowserSession(state('first'), first.browserKey)
    f.panel.retainBrowserSession(state('second'), second.browserKey)
    const closingFirst = f.panel.closeTab(first.id)
    const closingSecond = f.panel.closeTab(second.id)
    secondClose.resolve()
    expect(await closingSecond).toBe(true)
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual([first.id])
    expect(f.host.getState().open).toBe(true)
    firstClose.reject(new Error('release failed'))
    expect(await closingFirst).toBe(false)
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual([first.id])
    expect(f.host.getState().open).toBe(true)
  })
})

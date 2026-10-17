import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { LocalRunOutput } from '@buddy-shared/runs/runApi'
import { describe, expect, it } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { useTaskResourcePanel } from '@/modules/tasks/state/context-panel/useTaskResourcePanel'
import { deferred } from '../../../../../../__tests__/deferred'
import { contextPanelFixture } from './contextPanelFixture'

function fixture() {
  const activeConversationId = shallowRef<string | null>('conversation')
  const gate = deferred<DesktopBrowserState>()
  let sessionOpen = true
  const browser: Pick<DesktopBrowserApi, 'onStateChanged' | 'ensureSession' | 'close' | 'openArtifact' | 'navigate'> = {
    navigate: async (sessionId, url) => ({ sessionId, conversationId: 'conversation', url } as DesktopBrowserState),
    onStateChanged: () => () => {},
    ensureSession: () => gate.promise,
    close: async () => { sessionOpen = false },
    openArtifact: async () => { throw new Error('preview unavailable') },
  }
  const runOutputs = shallowRef<readonly LocalRunOutput[]>([{
    runId: 'run',
    createdAt: '2026-09-08T00:00:00.000Z',
    sourceToolCallId: 'tool',
    artifacts: [{ artifactId: 'html', conversationId: 'conversation', createdAt: '2026-09-08T00:00:00.000Z', kind: 'file', mimeType: 'text/html', name: 'page.html', path: '/workspace/page.html', previewUrl: null, runId: 'run', sizeBytes: 10, sourceArtifactId: null, sourceToolCallId: 'tool', updatedAt: '2026-09-08T00:00:00.000Z' }],
  }])
  const { scope, options } = contextPanelFixture({ activeConversationId })
  const panel = scope.run(() => useTaskResourcePanel({ ...options, autoCollapse: shallowRef(false), linkOpening: shallowRef('in-app'), spaces: shallowRef([]), activeRunId: shallowRef(null), browser, changeSets: shallowRef([]), runOutputs }))!
  const release = () => gate.resolve({ sessionId: 'session', conversationId: 'conversation' } as DesktopBrowserState)
  return { activeConversationId, browser, panel, release, runOutputs, scope, sessionOpen: () => sessionOpen }
}

describe('resource panel operations', () => {
  it('opens web links in their task session and retains the navigated state', async () => {
    const f = fixture()
    const opening = f.panel.openWebLink('http://127.0.0.1:8765/')
    f.release()
    await opening
    expect(f.panel.activeTab.value).toMatchObject({ kind: 'browser', conversationId: 'conversation' })
    expect(f.panel.activeBrowserState.value).toMatchObject({ sessionId: 'session', url: 'http://127.0.0.1:8765/' })
  })

  it('does not navigate a pending link after the user switches tasks', async () => {
    const f = fixture()
    let navigated = false
    f.browser.navigate = async () => {
      navigated = true
      throw new Error('unexpected navigation')
    }
    const opening = f.panel.openWebLink('https://example.com/')
    f.activeConversationId.value = 'other'
    f.release()
    await opening
    expect(navigated).toBe(false)
    expect(f.panel.activeTab.value).toBeNull()
  })

  it('opens a task HTML link in its browser without requiring a bound space', async () => {
    const f = fixture()
    let displayedArtifact: string | null = null
    f.browser.openArtifact = async (sessionId, artifactId) => {
      displayedArtifact = artifactId
      return { sessionId } as DesktopBrowserState
    }
    expect(f.panel.canPreviewFile('./page.html')).toBe(true)
    const opening = f.panel.previewFile('./page.html')
    f.release()
    await opening
    expect(displayedArtifact).toBe('html')
    expect(f.panel.activeTab.value).toMatchObject({ kind: 'browser', conversationId: 'conversation', source: { runId: 'run' } })
    f.activeConversationId.value = 'other'
    expect(f.panel.canPreviewFile('page.html')).toBe(false)
  })

  it('does not guess between artifacts with the same relative path', () => {
    const f = fixture()
    const output = f.runOutputs.value[0]!
    const artifact = output.artifacts[0]!
    f.runOutputs.value = [{ ...output, artifacts: [artifact, { ...artifact, artifactId: 'other-html', path: '/other/page.html' }] }]
    expect(f.panel.canPreviewFile('page.html')).toBe(false)
    expect(f.panel.canPreviewFile('/workspace/page.html')).toBe(true)
    expect(f.panel.canPreviewFile('file:///workspace/page.html')).toBe(true)
    expect(f.panel.canPreviewFile('https://example.com/page.html')).toBe(false)
    expect(f.panel.canPreviewFile('../workspace/page.html')).toBe(false)
    expect(f.panel.canPreviewFile('/unknown/page.html')).toBe(false)
  })

  it('updates the owning manual session across task changes without changing another tab', async () => {
    const f = fixture()
    f.activeConversationId.value = null
    f.panel.addBrowser()
    const first = f.panel.activeTab.value!
    f.panel.addBrowser()
    const second = f.panel.activeTab.value!
    if (first.kind !== 'browser' || second.kind !== 'browser')
      throw new Error('Expected browser tabs')
    const firstState = { conversationId: null, sessionId: 'first-session', title: 'First' } as DesktopBrowserState
    const secondState = { conversationId: null, sessionId: 'second-session', title: 'Second' } as DesktopBrowserState
    f.activeConversationId.value = 'other'
    f.panel.retainBrowserSession(firstState, first.browserKey)
    f.panel.retainBrowserSession(secondState, second.browserKey)
    f.panel.updateBrowserState({ ...firstState, title: 'Late first update' })
    await nextTick()
    expect(f.panel.activeBrowserState.value).toBeNull()
    expect(f.panel.tabs.value).toEqual([])
    f.activeConversationId.value = null
    expect(f.panel.activeBrowserState.value).toEqual(secondState)
    f.panel.selectTab(first.id)
    expect(f.panel.activeBrowserState.value).toEqual({ ...firstState, title: 'Late first update' })
    expect(f.sessionOpen()).toBe(true)
  })

  it('restores a failed manual close after changing tasks without taking focus', async () => {
    const f = fixture()
    const closing = deferred<void>()
    f.browser.close = () => closing.promise
    f.panel.addBrowser()
    const tab = f.panel.activeTab.value!
    if (tab.kind !== 'browser')
      throw new Error('Expected a browser tab')
    f.panel.retainBrowserSession({ conversationId: null, sessionId: 'manual-session' } as DesktopBrowserState, tab.browserKey)
    const result = f.panel.closeTab(tab.id)
    f.activeConversationId.value = 'other'
    f.panel.addBrowser()
    const selected = f.panel.activeTab.value
    closing.reject(new Error('close failed'))
    expect(await result).toBe(false)
    expect(f.panel.activeTab.value).toEqual(selected)
    expect(f.panel.tabs.value.map(tab => tab.id)).not.toContain(tab.id)
    f.activeConversationId.value = 'conversation'
    expect(f.panel.activeTab.value?.id).toBe(tab.id)
  })

  it('releases task-owned manual sessions on deletion and rejects late results for the deleted task', async () => {
    const f = fixture()
    const sessions = new Set(['first-session', 'second-session', 'late-session'])
    f.browser.close = async (id?: string) => {
      sessions.delete(id!)
    }
    f.panel.addBrowser()
    const first = f.panel.activeTab.value!
    f.panel.addBrowser()
    const late = f.panel.activeTab.value!
    f.activeConversationId.value = 'other'
    f.panel.addBrowser()
    const second = f.panel.activeTab.value!
    if (first.kind !== 'browser' || second.kind !== 'browser' || late.kind !== 'browser')
      throw new Error('Expected browser tabs')
    f.panel.retainBrowserSession({ conversationId: null, sessionId: 'first-session' } as DesktopBrowserState, first.browserKey)
    f.panel.retainBrowserSession({ conversationId: null, sessionId: 'second-session' } as DesktopBrowserState, second.browserKey)
    f.panel.discardConversation('conversation')
    f.panel.retainBrowserSession({ conversationId: null, sessionId: 'late-session' } as DesktopBrowserState, late.browserKey)
    f.panel.restoreTab(first)
    await nextTick()
    expect([...sessions]).toEqual(['second-session'])
    expect(f.panel.tabs.value).toEqual([second])
    f.activeConversationId.value = 'conversation'
    expect(f.panel.tabs.value).toEqual([])
  })

  it('closes an uninitialized manual tab and releases its late session without restoring the tab', async () => {
    const f = fixture()
    f.panel.addBrowser()
    const tab = f.panel.activeTab.value!
    expect(await f.panel.closeTab(tab.id)).toBe(true)
    if (tab.kind !== 'browser')
      throw new Error('Expected a browser tab')
    f.panel.retainBrowserSession({ sessionId: 'session', conversationId: null } as DesktopBrowserState, tab.browserKey)
    await nextTick()
    expect(f.sessionOpen()).toBe(false)
    expect(f.panel.tabs.value).toEqual([])
  })

  it('does not close a browser reopened while its old close awaits the session', async () => {
    const f = fixture()
    f.panel.openBrowser()
    const closing = f.panel.closeTab('browser:conversation')
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual(['browser:conversation'])
    f.panel.openBrowser()
    f.release()
    expect(await closing).toBe(false)
    expect(f.sessionOpen()).toBe(true)
    expect(f.panel.activeTab.value?.id).toBe('browser:conversation')
  })

  it('does not let failed artifact loading reopen a collapsed panel', async () => {
    const f = fixture()
    const opening = f.panel.openArtifact('html')
    f.panel.toggle()
    f.release()
    await opening
    expect(f.panel.isOpen.value).toBe(false)
    expect(f.panel.tabs.value.map(tab => tab.kind)).toEqual(['browser'])
  })

  it('finishes an explicit close across navigation when its tab has not been reopened', async () => {
    const f = fixture()
    f.panel.openBrowser()
    const closing = f.panel.closeTab('browser:conversation')
    f.activeConversationId.value = 'other'
    f.activeConversationId.value = 'conversation'
    f.release()
    await closing
    await nextTick()
    expect(f.sessionOpen()).toBe(false)
    expect(f.panel.tabs.value).toEqual([])
  })

  it('preserves the browser on close failure and keeps the HTML fallback selected on retry', async () => {
    const f = fixture()
    f.browser.close = async () => {
      throw new Error('close failed')
    }
    f.panel.openBrowser()
    const closing = f.panel.closeTab('browser:conversation')
    f.release()
    expect(await closing).toBe(false)
    expect(f.panel.activeTab.value?.kind).toBe('browser')
    await f.panel.openArtifact('html')
    expect(f.panel.activeTab.value?.kind).toBe('artifact')
    expect(await f.panel.closeTab('browser:conversation')).toBe(false)
    expect(f.panel.activeTab.value?.kind).toBe('artifact')
    expect(f.panel.tabs.value.map(tab => tab.kind).sort()).toEqual(['artifact', 'browser'])
  })
})

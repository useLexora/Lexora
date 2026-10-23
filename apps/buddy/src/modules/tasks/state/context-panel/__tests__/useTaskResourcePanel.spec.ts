import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { TaskFile } from '@buddy-shared/files/taskFileApi'
import type { LocalRunOutput } from '@buddy-shared/runs/runApi'
import { resolveBuiltinFileOpening } from '@buddy-shared/files/fileOpening'
import { describe, expect, it, vi } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { useTaskResourcePanel } from '@/modules/tasks/state/context-panel/useTaskResourcePanel'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { deferred } from '../../../../../../__tests__/deferred'
import { contextPanelFixture } from './contextPanelFixture'

function fixture() {
  const activeConversationId = shallowRef<string | null>('conversation')
  const gate = deferred<DesktopBrowserState>()
  let sessionOpen = true
  const browser: Pick<DesktopBrowserApi, 'onStateChanged' | 'ensureSession' | 'close' | 'openArtifact' | 'openFile' | 'navigate'> = {
    navigate: async (sessionId, url) => ({ sessionId, conversationId: 'conversation', url } as DesktopBrowserState),
    onStateChanged: () => () => {},
    ensureSession: () => gate.promise,
    close: async () => { sessionOpen = false },
    openFile: async () => { throw new Error('Unexpected file link') },
    openArtifact: async () => { throw new Error('preview unavailable') },
  }
  const runOutputs = shallowRef<readonly LocalRunOutput[]>([{
    runId: 'run',
    createdAt: '2026-09-08T00:00:00.000Z',
    sourceToolCallId: 'tool',
    artifacts: [{ artifactId: 'html', conversationId: 'conversation', createdAt: '2026-09-08T00:00:00.000Z', kind: 'file', mimeType: 'text/html', name: 'page.html', path: '/workspace/page.html', previewUrl: null, runId: 'run', sizeBytes: 10, sourceArtifactId: null, sourceToolCallId: 'tool', updatedAt: '2026-09-08T00:00:00.000Z' }],
  }])
  const mode = shallowRef<'task' | 'space' | 'independent'>('task')
  const { scope, options } = contextPanelFixture({ activeConversationId, mode, scopeSpaceIds: shallowRef(new Map([['task:conversation', 'space'], ['task:other', 'space']])) })
  const files = { resolve: async ({ conversationId, href }: { conversationId: string, href: string }): Promise<TaskFile> => ({ target: { conversationId, path: `/workspace/${href}` }, name: href, kind: 'file', mimeType: 'application/octet-stream', sizeBytes: 10, updatedAt: '2026-09-08T00:00:00.000Z' }) }
  const documents: string[] = []
  const fileOpening = { ensureReady: async () => {}, resolve: resolveBuiltinFileOpening, open: vi.fn(async () => {}) }
  const openFile = vi.fn<Parameters<typeof useTaskResourcePanel>[0]['openFile']>(async (file, _source, provider) => {
    documents.push(`${file.name}:${provider?.id}`)
  })
  const panel = scope.run(() => useTaskResourcePanel({ ...options, autoCollapse: shallowRef(false), linkOpening: shallowRef('in-app'), spaces: shallowRef([]), activeRunId: shallowRef(null), browser, changeSets: shallowRef([]), runOutputs, files, fileOpening, openFile }))!
  const release = () => gate.resolve({ sessionId: 'session', conversationId: 'conversation' } as DesktopBrowserState)
  return { activeConversationId, mode, browser, panel, release, runOutputs, scope, files, documents, fileOpening, openFile, onError: options.onError, sessionOpen: () => sessionOpen }
}

describe('resource panel operations', () => {
  it.each(['web', 'file'] as const)('does not open a pending %s link in another task', async (kind) => {
    const f = fixture()
    f.runOutputs.value = []
    let navigated = false
    f.browser[kind === 'web' ? 'navigate' : 'openFile'] = async () => {
      navigated = true
      throw new Error('unexpected navigation')
    }
    const opening = kind === 'web' ? f.panel.openWebLink('https://example.com/') : f.panel.previewFile('page.html')
    f.activeConversationId.value = 'other'
    f.release()
    await opening
    expect(navigated).toBe(false)
    expect(f.panel.activeTab.value).toBeNull()
    expect(f.panel.activeBrowserState.value).toBeNull()
  })

  it('opens an unregistered task HTML link without a bound space', async () => {
    const f = fixture()
    f.runOutputs.value = []
    f.browser.openFile = async (sessionId, target) => ({ sessionId, conversationId: 'conversation', url: `file://${target.path}` } as DesktopBrowserState)
    expect(f.panel.canPreviewFile('page.html')).toBe(true)
    const opening = f.panel.previewFile('page.html')
    f.release()
    await opening
    expect(f.panel.activeBrowserState.value?.url).toBe('file:///workspace/page.html')
  })

  it.each(['page.html', '/previous-workspace/page.html', 'file:///previous-workspace/page.html'])('opens a registered HTML link by its artifact identity: %s', async (href) => {
    const f = fixture()
    const output = f.runOutputs.value[0]!
    const artifact = { ...output.artifacts[0]!, path: '/previous-workspace/page.html' }
    f.runOutputs.value = [{ ...output, artifacts: [artifact] }]
    f.browser.openArtifact = async (sessionId, artifactId) => {
      if (artifactId !== artifact.artifactId)
        throw new Error('Unknown artifact')
      return { sessionId, conversationId: artifact.conversationId, url: `file://${artifact.path}` } as DesktopBrowserState
    }
    const opening = f.panel.previewFile(href)
    f.release()
    await opening
    expect(f.panel.activeTab.value).toMatchObject({ kind: 'browser', source: { conversationId: artifact.conversationId, runId: artifact.runId } })
    expect(f.panel.activeBrowserState.value?.url).toBe(`file://${artifact.path}`)
  })

  it('opens an artifact supplied by a child execution without a transcript lookup', async () => {
    const f = fixture()
    const artifact = { ...f.runOutputs.value[0]!.artifacts[0]!, runId: 'child-run' }
    f.runOutputs.value = []
    f.browser.openArtifact = async (sessionId, artifactId) => ({ sessionId, conversationId: 'conversation', url: `file:///workspace/${artifactId}.html` } as DesktopBrowserState)
    const opening = f.panel.openArtifact(artifact)
    f.release()
    await opening
    expect(f.panel.activeTab.value).toMatchObject({ kind: 'browser', source: { runId: 'child-run' } })
    expect(f.panel.activeBrowserState.value?.url).toBe('file:///workspace/html.html')
  })

  it('does not guess between document artifacts with the same relative path', () => {
    const f = fixture()
    const output = f.runOutputs.value[0]!
    const artifact = { ...output.artifacts[0]!, name: 'report.md', path: '/workspace/report.md', mimeType: 'text/markdown' }
    f.runOutputs.value = [{ ...output, artifacts: [artifact, { ...artifact, artifactId: 'other', path: '/other/report.md' }] }]
    expect(f.panel.fileArtifact('report.md')).toBeNull()
    expect(f.panel.canPreviewFile('report.md')).toBe(true)
    expect(f.panel.canPreviewFile('/workspace/report.md')).toBe(true)
    expect(f.panel.canPreviewFile('file:///workspace/report.md')).toBe(true)
    expect(f.panel.canPreviewFile('https://example.com/report.md')).toBe(false)
    expect(f.panel.canPreviewFile('../workspace/report.md')).toBe(true)
  })

  it.each(['report.md', 'page.html', 'data.xxx'])('uses the host-selected opener for an unregistered %s link', async (name) => {
    const f = fixture()
    f.runOutputs.value = []
    const selected = resolveBuiltinFileOpening('report.txt', 'standalone').provider!
    f.fileOpening.resolve = () => ({ ...resolveBuiltinFileOpening(name, 'standalone'), provider: selected })
    await f.panel.previewFile(name)
    expect(f.documents).toEqual([`${name}:lexora.text`])
    expect(f.panel.activeTab.value).toBeNull()
  })

  it.each(['task', 'space', 'independent'] as const)('discards a late file resolution after changing tasks in %s mode', async (mode) => {
    const f = fixture()
    f.mode.value = mode
    const pending = deferred<TaskFile>()
    f.files.resolve = () => pending.promise
    const opening = f.panel.previewFile('report.md')
    f.activeConversationId.value = 'other'
    pending.resolve({ target: { conversationId: 'conversation', path: '/workspace/report.md' }, name: 'report.md', kind: 'file', mimeType: 'text/markdown', sizeBytes: 8, updatedAt: '2026-09-08T00:00:00.000Z' })
    await opening
    expect(f.documents).toEqual([])
    expect(f.panel.tabs.value).toEqual([])
  })

  it.each(['task change', 'panel close'])('cancels a file open queued behind another view close after %s', async (action) => {
    const f = fixture()
    f.panel.toggle()
    const registry = new ContributionRegistry()
    registry.register('files', scope => scope.view({ id: 'file', renderer: 'file', label: 'File', locations: ['context'], supports: () => true, multiple: true }))
    const entered = deferred<void>()
    const gate = deferred<boolean>()
    const controller = new WorkbenchController(registry, async () => {
      entered.resolve()
      return gate.promise
    })
    const old = (await controller.open({ scheme: 'task-file', id: 'old', data: {} }, 'Old', { location: 'context' }))!
    const closing = controller.close(old)
    await entered.promise
    const queued = deferred<void>()
    f.openFile.mockImplementation(async (file, _source, _provider, _current, signal) => {
      const pending = controller.open({ scheme: 'task-file', id: file.target.path, data: {} }, file.name, { location: 'context', signal })
      queued.resolve()
      await pending
    })
    const opening = f.panel.previewFile('report.md')
    await queued.promise
    if (action === 'task change')
      f.activeConversationId.value = 'other'
    else
      f.panel.toggle()
    gate.resolve(true)
    await Promise.all([closing, opening])
    expect(Object.values(controller.layout.views)).toEqual([])
    expect(f.onError).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('reports a missing file without creating a resource tab', async () => {
    const f = fixture()
    const error = new Error('LEXORA_LOCAL_CHAT_ERROR:FILE_NOT_FOUND:0')
    f.files.resolve = async () => {
      throw error
    }
    await f.panel.previewFile('missing.md')
    expect(f.onError).toHaveBeenCalledWith(error)
    expect(f.documents).toEqual([])
    expect(f.panel.tabs.value).toEqual([])
  })

  it('applies an explicit opener to registered HTML without changing the host default', async () => {
    const f = fixture()
    await f.panel.previewFile('page.html', undefined, 'lexora.text')
    expect(f.panel.activeTab.value).toMatchObject({ kind: 'artifact', providerId: 'lexora.text' })
    expect(f.fileOpening.resolve('page.html', 'standalone').provider?.id).toBe('lexora.browser')
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
    await vi.waitFor(() => expect(f.panel.isOpen.value).toBe(true))
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

  it('preserves the browser on close failure and reports a failed open without changing the selected opener', async () => {
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
    expect(f.onError).toHaveBeenCalled()
    expect(f.panel.activeTab.value?.kind).toBe('browser')
    expect(await f.panel.closeTab('browser:conversation')).toBe(false)
    expect(f.panel.activeTab.value?.kind).toBe('browser')
    expect(f.panel.tabs.value.map(tab => tab.kind)).toEqual(['browser'])
  })
})

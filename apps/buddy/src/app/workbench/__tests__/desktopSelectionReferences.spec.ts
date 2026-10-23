import type { DesktopBrowserApi } from '@buddy-shared/browser/browserDesktopApi'
import type { BuddyViewQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { TaskWorkspacePool } from '../TaskWorkspacePool'
import type { TaskCapability } from '@/modules/tasks'
import type { TaskResourcePanel } from '@/modules/tasks/contracts'
import type { TaskArtifactContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { artifactQuote, selectionArtifact } from '@buddy-shared/artifacts/__tests__/artifactSelectionFixture'
import { browserQuote } from '@buddy-shared/browser/__tests__/browserSelectionFixture'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { chatComposerDocumentToUserContent, userContentToChatComposerDocument } from '@/modules/prompt-input'
import { useChatDrafts } from '@/modules/tasks/state/drafts/useChatDrafts'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { createDesktopSelectionReferences } from '../createDesktopSelectionReferences'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
async function fixture() {
  const registry = new ContributionRegistry()
  registry.register('test', (scope) => {
    scope.view({ id: 'task', renderer: 'task', label: 'Task', locations: ['main'], multiple: true, supports: resource => resource.scheme === 'task' })
    scope.view({ id: 'file', renderer: 'file', label: 'File', locations: ['context'], multiple: true, supports: resource => resource.scheme === 'file' })
  })
  const controller = new WorkbenchController(registry)
  const a = (await controller.open({ scheme: 'task', id: 'a', data: {} }, 'Same title'))!
  const pane = controller.layout.activePane
  const b = (await controller.open({ scheme: 'task', id: 'b', data: {} }, 'Same title', { paneId: pane, direction: 'right' }))!
  const file = { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'auth.ts' }
  const fileId = (await controller.open({ scheme: 'file', id: 'auth', data: file }, 'auth.ts', { state: { contextTabId: 'files-a' }, focus: false }))!
  const scope = effectScope()
  const keyA = shallowRef('conversation:a:branch-a')
  const keyB = shallowRef('conversation:b:branch-b')
  const draftsA = scope.run(() => useChatDrafts({ targetKey: keyA as never, onChange: () => {} }))!
  const draftsB = scope.run(() => useChatDrafts({ targetKey: keyB as never, onChange: () => {} }))!
  function task(id: string, drafts: typeof draftsA) {
    return { session: { navigationVersion: () => 0 }, workspace: {
      restoration: { state: shallowRef('ready') },
      status: { isClosing: shallowRef(false) },
      execution: { isSending: shallowRef(false), isMutatingBranch: shallowRef(false) },
      session: { currentTitle: shallowRef('Same title'), activeConversationId: shallowRef(id) },
      composer: { draftId: drafts.draftId, editorKey: drafts.editorKey, composerContent: drafts.composerContent, updateComposerContent: drafts.updateComposerContent, target: shallowRef({ kind: 'conversation', conversationId: id, branchId: 'branch' }) },
    } } as unknown as TaskCapability
  }
  const tasks = new Map([['a', task('a', draftsA)], ['b', task('b', draftsB)]])
  const pool = { peek: (resource: { id: string }) => tasks.get(resource.id) } as unknown as TaskWorkspacePool
  let independent = false
  const locateFile = vi.fn(async () => {})
  const openFile = vi.fn(async () => fileId)
  const browserStates = shallowRef({ 'browser-a': { sessionId: browserQuote.source.sessionId, pageId: browserQuote.source.pageId, documentVersion: browserQuote.source.documentVersion, url: browserQuote.source.url, status: 'ready' } })
  const artifactTab: TaskArtifactContextTab = { id: 'artifact:artifact-a', kind: 'artifact', scope: 'task:a', artifact: selectionArtifact, label: selectionArtifact.name, viewMode: 'preview' }
  const browserTab = { id: 'browser-a', kind: 'browser' as const, scope: 'task:a' }
  const allTabs = shallowRef([{ id: 'files-a', scope: 'task:a' }, browserTab, artifactTab])
  const visibleTabs = shallowRef<(TaskArtifactContextTab | typeof browserTab)[]>([artifactTab])
  const activeTab = shallowRef({ id: 'browser-a' })
  const selectTab = vi.fn((id: string) => activeTab.value = { id })
  let version = 0
  const reveal = vi.fn(async () => true)
  const selectionScope = shallowRef('task:a')
  const resources = { allTabs, tabs: visibleTabs, activeTab, browserStates, selectTab, selectionScope, isOpen: shallowRef(true), findArtifact: () => selectionArtifact, openArtifact: async () => activeTab.value = artifactTab, setArtifactViewMode: (_id: string, mode: 'preview' | 'source') => artifactTab.viewMode = mode } as unknown as TaskResourcePanel
  let ready = true
  const locateElement = vi.fn(async () => true)
  const browser = { locateElement } as unknown as DesktopBrowserApi
  const host = scope.run(() => createDesktopSelectionReferences({ controller, pool, language: shallowRef('zh-CN'), resources: () => resources, independent: () => independent, ready: () => ready, locateFile, openFile, browser, navigationVersion: () => version }))!
  host.registerReveal(fileId, reveal)
  host.registerReveal(artifactTab.id, reveal)
  cleanups.push(() => {
    scope.stop()
    void controller.dispose()
  })
  const quote = { id: 'q', text: 'Frozen file text', source: { kind: 'file' as const, title: 'auth.ts', file, format: 'source' as const } }
  return { a, b, fileId, controller, host, quote, resources, selectionScope, browserStates, draftsA, draftsB, tasks, keyA, locateFile, openFile, locateElement, artifactTab, browserTab, allTabs, visibleTabs, activeTab, selectTab, reveal, navigate: () => version++, independent: () => independent = true, unavailable: () => ready = false, stop: () => scope.stop() }
}

describe('desktop resource quote adapter', () => {
  it('binds artifact references to their owning task and permits one explicit alternative target', async () => {
    const f = await fixture()
    f.activeTab.value = { id: f.artifactTab.id }
    f.controller.focus(f.b)
    const request = f.host.capture(f.artifactTab.id, artifactQuote)!
    expect(request.defaultId).toBe(f.a)
    f.draftsB.updateComposerContent('Newer question', userContentToChatComposerDocument(createBuddyUserContent('Newer question')))
    expect(f.host.add(request, f.b)).toBe('added')
    expect(chatComposerDocumentToUserContent(f.draftsA.composerContent.value).resourceQuotes).toBeUndefined()
    expect(chatComposerDocumentToUserContent(f.draftsB.composerContent.value).resourceQuotes).toEqual([artifactQuote])
    expect(f.draftsB.draft.value).toBe('Newer question')
  })

  it('requires explicit file and artifact targets in independent mode', async () => {
    const f = await fixture()
    f.activeTab.value = { id: f.artifactTab.id }
    f.independent()
    expect(f.host.capture(f.artifactTab.id, artifactQuote)?.defaultId).toBeNull()
    expect(f.host.capture(f.fileId, f.quote)?.defaultId).toBeNull()
  })

  it.each(['version', 'path', 'mode', 'scope', 'close', 'switch', 'independent'])('rejects an artifact operation after a %s source change', async (change) => {
    const f = await fixture()
    f.activeTab.value = { id: f.artifactTab.id }
    const request = f.host.capture(f.artifactTab.id, artifactQuote)!
    if (change === 'version')
      f.artifactTab.artifact = { ...selectionArtifact, updatedAt: '2026-10-03T00:00:01.000Z' }
    if (change === 'path')
      f.artifactTab.artifact = { ...selectionArtifact, path: 'C:\\fixtures\\renamed.md' }
    if (change === 'mode')
      f.artifactTab.viewMode = 'source'
    if (change === 'scope')
      f.artifactTab.scope = 'task:b'
    if (change === 'close')
      f.allTabs.value = f.allTabs.value.filter(tab => tab.id !== f.artifactTab.id)
    if (change === 'switch')
      f.activeTab.value = { id: 'browser-a' }
    if (change === 'independent')
      f.independent()
    expect(f.host.add(request, f.a)).toBe('unavailable')
    expect(chatComposerDocumentToUserContent(f.draftsA.composerContent.value).resourceQuotes).toBeUndefined()
  })

  it('does not capture binary or directory artifact placeholders', async () => {
    const f = await fixture()
    f.activeTab.value = { id: f.artifactTab.id }
    for (const artifact of [{ ...selectionArtifact, mimeType: 'application/pdf', name: 'report.pdf' }, { ...selectionArtifact, kind: 'directory' as const }]) {
      f.artifactTab.artifact = artifact
      expect(f.host.capture(f.artifactTab.id, artifactQuote)).toBeNull()
    }
  })

  it('reopens artifact sources, selects the recorded representation and reports actual highlight failure', async () => {
    const f = await fixture()
    f.visibleTabs.value = []
    f.artifactTab.viewMode = 'source'
    expect(await f.host.locate(artifactQuote)).toBe(true)
    expect(f.activeTab.value.id).toBe(f.artifactTab.id)
    expect(f.artifactTab.viewMode).toBe('preview')
    f.reveal.mockResolvedValueOnce(false)
    expect(await f.host.locate(artifactQuote)).toBe(false)
  })

  it('rejects a late file lookup after navigation without opening the old source', async () => {
    const f = await fixture()
    const lookup = Promise.withResolvers<void>()
    f.locateFile.mockReturnValueOnce(lookup.promise)
    const pending = f.host.locate(f.quote)
    f.navigate()
    lookup.resolve()
    expect(await pending).toBe(false)
    expect(f.openFile).not.toHaveBeenCalled()
  })

  it('invalidates a pending reveal when another locate request supersedes it', async () => {
    const f = await fixture()
    const reveal = Promise.withResolvers<boolean>()
    let current!: () => boolean
    f.host.registerReveal(f.fileId, async (_quote, isCurrent) => {
      current = isCurrent
      await reveal.promise
      return current()
    })
    const pending = f.host.locate(f.quote)
    await vi.waitFor(() => expect(current).toBeDefined())
    const next = f.host.locate(artifactQuote)
    await nextTick()
    expect(current()).toBe(false)
    reveal.resolve(true)
    expect(await pending).toBe(false)
    expect(await next).toBe(true)
  })

  it('associates browser tabs with their owning draft, not the focused pane', async () => {
    const f = await fixture()
    f.controller.focus(f.b)
    const request = f.host.capture('browser:browser-a', browserQuote)!
    expect(request.defaultId).toBe(f.a)
    expect(f.host.add(request, f.a)).toBe('added')
    expect(chatComposerDocumentToUserContent(f.draftsB.composerContent.value).resourceQuotes).toBeUndefined()
  })

  it('invalidates browser operations on same-URL document changes and requires independent multi-target choice', async () => {
    const f = await fixture()
    const request = f.host.capture('browser:browser-a', browserQuote)!
    f.browserStates.value['browser-a'] = { ...f.browserStates.value['browser-a'], documentVersion: 2 }
    expect(f.host.add(request, f.a)).toBe('unavailable')
    f.independent()
    expect(f.host.capture('browser:browser-a', browserQuote)?.defaultId).toBeNull()
  })

  it('routes through the owning tab rather than active pane and preserves the selected draft body', async () => {
    const f = await fixture()
    f.draftsA.updateComposerContent('Keep latest A input', userContentToChatComposerDocument(createBuddyUserContent('Keep latest A input')))
    f.controller.focus(f.b)
    const request = f.host.capture(f.fileId, f.quote)!
    expect(request.defaultId).toBe(f.a)
    expect(f.host.add(request, f.a)).toBe('added')
    expect(f.draftsA.draft.value).toBe('Keep latest A input')
    expect(chatComposerDocumentToUserContent(f.draftsA.composerContent.value).resourceQuotes).toEqual([f.quote])
    expect(chatComposerDocumentToUserContent(f.draftsB.composerContent.value).resourceQuotes).toBeUndefined()
  })

  it('uses the actual layout for split status, not the writable target count', async () => {
    const f = await fixture()
    f.tasks.get('b')!.workspace.execution.isSending = shallowRef(true)
    const request = f.host.capture(f.fileId, f.quote)!
    expect(request.targets).toHaveLength(1)
    expect(request.isSplit).toBe(true)
    await f.controller.close(f.b)
    expect(f.host.capture(f.fileId, f.quote)?.isSplit).toBe(false)
  })

  it('invalidates a target after branch rebinding', async () => {
    const f = await fixture()
    const request = f.host.capture(f.fileId, f.quote)!
    f.keyA.value = 'conversation:a:other-branch'
    f.tasks.get('a')!.workspace.composer.target = shallowRef({ kind: 'conversation', conversationId: 'a', branchId: 'other-branch' }) as never
    expect(f.host.add(request, f.a)).toBe('unavailable')
  })

  it('rejects navigation away and back even when the same draft is restored', async () => {
    const f = await fixture()
    const request = f.host.capture(f.fileId, f.quote)!
    f.tasks.get('a')!.session.navigationVersion = () => 2
    expect(f.host.add(request, f.a)).toBe('unavailable')
  })

  it.each(['scope', 'tab', 'independent', 'ready', 'dispose'] as const)('rejects an in-flight file open after a %s boundary changes', async (change) => {
    const f = await fixture()
    const lookup = Promise.withResolvers<void>()
    f.locateFile.mockReturnValueOnce(lookup.promise)
    const pending = f.host.locate(f.quote)
    if (change === 'scope')
      f.selectionScope.value = 'task:b'
    if (change === 'tab')
      f.activeTab.value = { id: 'other-tab' }
    if (change === 'independent')
      f.independent()
    if (change === 'ready')
      f.unavailable()
    if (change === 'dispose')
      f.stop()
    lookup.resolve()
    expect(await pending).toBe(false)
    expect(f.openFile).not.toHaveBeenCalled()
    expect(f.reveal).not.toHaveBeenCalled()
  })

  it.each(['version', 'mode', 'path'] as const)('fences file reveal after its source %s changes', async (change) => {
    const f = await fixture()
    const deferred = Promise.withResolvers<boolean>()
    let current!: () => boolean
    f.host.registerReveal(f.fileId, async (_quote, active) => {
      current = active
      return deferred.promise
    })
    const pending = f.host.locate(f.quote)
    await vi.waitFor(() => expect(current).toBeDefined())
    const view = f.controller.layout.views[f.fileId]!
    if (change === 'mode')
      f.controller.updateView(f.fileId, { state: { ...view.state, mode: 'preview' } })
    else
      f.controller.updateView(f.fileId, { resource: { ...view.resource, data: { ...view.resource.data, [change === 'version' ? 'revision' : 'path']: change === 'version' ? 2 : 'other.ts' } } })
    expect(current()).toBe(false)
    deferred.resolve(true)
    expect(await pending).toBe(false)
  })

  it('accepts a registered view provider without routing its locator through built-in file or browser handlers', async () => {
    const f = await fixture()
    const quote: BuddyViewQuote = { id: 'view-quote', text: 'Frozen custom selection', source: { kind: 'view', title: 'Custom document', provider: 'example.document', target: { id: 'doc-1' } }, locator: { version: 1, data: { block: 'first' } } }
    expect(await f.host.locate(quote)).toBe(false)
    let located: unknown
    const unregister = f.host.registerProvider('example.document', {
      captureSource: viewId => viewId === 'custom-view' ? { identity: 'doc-1:revision-1', owner: 'task:a' } : null,
      resolveLocate: reference => reference.source.kind === 'view' && reference.source.provider === 'example.document'
        ? async ({ current }) => {
          located = 'locator' in reference ? reference.locator : undefined
          return current()
        }
        : null,
    })
    const request = f.host.capture('custom-view', quote)!
    expect(request.defaultId).toBe(f.a)
    expect(f.host.add(request, f.a)).toBe('added')
    expect(chatComposerDocumentToUserContent(f.draftsA.composerContent.value).resourceQuotes).toContainEqual(quote)
    expect(await f.host.locate(quote)).toBe(true)
    expect(located).toEqual(quote.locator)
    expect(f.locateFile).not.toHaveBeenCalled()
    expect(f.locateElement).not.toHaveBeenCalled()
    unregister()
    expect(f.host.add(request, f.b)).toBe('unavailable')
    expect(await f.host.locate(quote)).toBe(false)
  })

  it('selects the owning browser only after a successful element locate', async () => {
    const f = await fixture()
    f.visibleTabs.value = [f.browserTab, f.artifactTab]
    f.activeTab.value = { id: f.artifactTab.id }
    expect(await f.host.locate(browserQuote)).toBe(true)
    expect(f.activeTab.value.id).toBe(f.browserTab.id)
    f.activeTab.value = { id: f.artifactTab.id }
    f.locateElement.mockResolvedValueOnce(false)
    expect(await f.host.locate(browserQuote)).toBe(false)
    expect(f.activeTab.value.id).toBe(f.artifactTab.id)
  })

  it.each(['document', 'closed', 'tab'] as const)('does not select a browser tab after its pending locator becomes stale: %s', async (change) => {
    const f = await fixture()
    f.visibleTabs.value = [f.browserTab, f.artifactTab]
    const deferred = Promise.withResolvers<boolean>()
    f.locateElement.mockReturnValueOnce(deferred.promise)
    const pending = f.host.locate(browserQuote)
    if (change === 'document')
      f.browserStates.value['browser-a'] = { ...f.browserStates.value['browser-a'], documentVersion: 2 }
    if (change === 'closed')
      f.allTabs.value = f.allTabs.value.filter(tab => tab.id !== 'browser-a')
    if (change === 'tab')
      f.activeTab.value = { id: f.artifactTab.id }
    deferred.resolve(true)
    expect(await pending).toBe(false)
    expect(f.selectTab).not.toHaveBeenCalled()
  })

  it('checks existing file authorization before opening a quote source', async () => {
    const f = await fixture()
    f.locateFile.mockRejectedValueOnce(new Error('revoked directory'))
    expect(await f.host.locate(f.quote)).toBe(false)
    expect(f.openFile).not.toHaveBeenCalled()
    expect(await f.host.locate(f.quote)).toBe(true)
    expect(f.locateFile).toHaveBeenCalledWith(f.quote.source.file)
  })
})

// @vitest-environment jsdom
import type { LocalArtifact, LocalArtifactText } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetDetail, LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { Ref } from 'vue'
import type { WorkspaceFilesApi } from '../useWorkspaceFilePreview'
import type { TaskChangesContextTab, TaskFilesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, shallowRef } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { useArtifactPreview } from '../useArtifactPreview'
import { useContextChanges } from '../useContextChanges'
import { useWorkspaceFilePreview } from '../useWorkspaceFilePreview'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function own<T>(setup: () => T) {
  const scope = effectScope()
  scopes.push(scope)
  return { state: scope.run(setup)!, stop: () => scope.stop() }
}

describe('resource previews', () => {
  it('releases closed preview views while retaining another task tab', async () => {
    const first: TaskChangesContextTab = { id: 'changes:first', scope: 'task:first', conversationId: 'first', kind: 'changes', changeSet: createChanges('first'), branchId: 'branch', revision: '1' }
    const second: TaskChangesContextTab = { ...first, id: 'changes:second', scope: 'task:second', conversationId: 'second', changeSet: createChanges('second') }
    const tab = shallowRef<TaskChangesContextTab | null>(first)
    const retained = shallowRef(new Set([first.id, second.id]))
    const { state } = own(() => useContextChanges({ hasTab: id => retained.value.has(id), tab, getChangeSet: async id => createChanges(id), getOverview: async () => createChanges('all') }))
    await nextTick()
    const previous = state.current.value!
    previous.treeWidth = 350
    tab.value = second
    await nextTick()
    retained.value = new Set([second.id])
    await nextTick()
    expect(state.current.value?.source.id).toBe(second.id)
    retained.value = new Set([first.id, second.id])
    tab.value = first
    await nextTick()
    expect(state.current.value?.treeWidth).not.toBe(previous.treeWidth)
  })

  it('stops directory pagination after its tab closes and discards late results', async () => {
    const value = filesTab()
    const tab = shallowRef<TaskFilesContextTab | null>(value)
    const retained = shallowRef(true)
    const page = deferred<{ entries: [], nextCursor: string | null }>()
    const listDirectory = vi.fn().mockReturnValueOnce(page.promise).mockResolvedValue({ entries: [], nextCursor: null })
    const { state } = openFiles(tab, listDirectory, () => retained.value)
    tab.value = null
    retained.value = false
    await nextTick()
    page.resolve({ entries: [], nextCursor: 'another-page' })
    await nextTick()
    expect(listDirectory).toHaveBeenCalledTimes(1)
    retained.value = true
    tab.value = value
    await nextTick()
    expect(state.current.value?.nodes).toEqual([])
  })

  it('refreshes root and expanded directories on focus while preserving valid expanded keys', async () => {
    const value = filesTab()
    const tab = shallowRef<TaskFilesContextTab | null>(value)
    const listDirectory = vi.fn().mockImplementation(async ({ path }: { path: string }) => {
      if (path === '') {
        return {
          entries: [
            { name: 'src', path: 'src', kind: 'directory', unavailable: false },
            { name: 'README.md', path: 'README.md', kind: 'file', unavailable: false },
          ],
          nextCursor: null,
        }
      }
      if (path === 'src') {
        return {
          entries: [
            { name: 'index.ts', path: 'src/index.ts', kind: 'file', unavailable: false },
          ],
          nextCursor: null,
        }
      }
      throw new Error('Not found')
    })
    const { state } = openFiles(tab, listDirectory)
    await Promise.resolve()
    await nextTick()
    expect(state.current.value?.nodes).toHaveLength(2)

    state.current.value!.expandedKeys = ['src', 'deleted-folder']
    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(state.current.value?.expandedKeys).toEqual(['src']))
    const srcNode = state.current.value?.nodes.find(node => node.key === 'src')
    expect(srcNode?.children).toHaveLength(1)
    expect(srcNode?.children?.[0].key).toBe('src/index.ts')
    expect(state.current.value?.treeFailed).toBe(false)
  })

  it('marks treeFailed when root refresh fails and recovers on next successful refresh', async () => {
    const value = filesTab()
    const tab = shallowRef<TaskFilesContextTab | null>(value)
    let shouldFail = false
    const listDirectory = vi.fn().mockImplementation(async () => {
      if (shouldFail)
        throw new Error('Disk unreadable')
      return { entries: [{ name: 'file.txt', path: 'file.txt', kind: 'file', unavailable: false }], nextCursor: null }
    })
    const { state } = openFiles(tab, listDirectory)
    await nextTick()
    expect(state.current.value?.treeFailed).toBe(false)

    shouldFail = true
    await state.refresh()
    expect(state.current.value?.treeFailed).toBe(true)

    shouldFail = false
    await state.refresh()
    expect(state.current.value?.treeFailed).toBe(false)
    expect(state.current.value?.nodes).toHaveLength(1)
  })

  it('automatically reveals and loads ancestor directories when a nested file path is selected', async () => {
    const value = filesTab()
    const tab = shallowRef<TaskFilesContextTab | null>(value)
    const listDirectory = vi.fn().mockImplementation(async ({ path }: { path: string }) => {
      if (path === '')
        return { entries: [{ name: 'src', path: 'src', kind: 'directory', unavailable: false }], nextCursor: null }
      if (path === 'src')
        return { entries: [{ name: 'utils', path: 'src/utils', kind: 'directory', unavailable: false }], nextCursor: null }
      if (path === 'src/utils')
        return { entries: [{ name: 'math.ts', path: 'src/utils/math.ts', kind: 'file', unavailable: false }], nextCursor: null }
      return { entries: [], nextCursor: null }
    })
    const { state } = openFiles(tab, listDirectory)
    await Promise.resolve()
    await nextTick()

    tab.value = { ...value, target: { ...value.target, path: 'src/utils/math.ts' } }
    await vi.waitFor(() => expect(state.current.value?.expandedKeys).toEqual(['src', 'src/utils']))
    await vi.waitFor(() => expect(state.current.value?.nodes[0]?.children?.[0]?.children?.[0]?.key).toBe('src/utils/math.ts'))
  })

  it('publishes directory pages before completion and preserves folders expanded during pagination', async () => {
    const value = filesTab()
    const tab = shallowRef<TaskFilesContextTab | null>(value)
    const nextPage = deferred<{ entries: { name: string, path: string, kind: 'file', unavailable: boolean }[], nextCursor: null }>()
    const listDirectory = vi.fn().mockImplementation(async ({ path, cursor }: { path: string, cursor?: string }) => {
      if (cursor)
        return nextPage.promise
      if (path === 'src')
        return { entries: [{ name: 'nested.ts', path: 'src/nested.ts', kind: 'file', unavailable: false }], nextCursor: null }
      return { entries: [{ name: 'src', path: 'src', kind: 'directory', unavailable: false }], nextCursor: 'src' }
    })
    const { state } = openFiles(tab, listDirectory)
    await vi.waitFor(() => expect(state.current.value?.nodes[0]?.key).toBe('src'))
    expect(state.current.value?.loadingKeys.has('')).toBe(true)
    state.current.value!.expandedKeys = ['src']
    await state.load(state.current.value!.nodes[0]!)
    expect(state.current.value?.nodes[0]?.children?.[0]?.key).toBe('src/nested.ts')
    nextPage.resolve({ entries: [{ name: 'last.txt', path: 'last.txt', kind: 'file', unavailable: false }], nextCursor: null })
    await vi.waitFor(() => expect(state.current.value?.loadingKeys.size).toBe(0))
    expect(state.current.value?.nodes.map(node => node.key)).toEqual(['src', 'last.txt'])
    expect(state.current.value?.nodes[0]?.children?.[0]?.key).toBe('src/nested.ts')
  })

  it('keeps refreshed root entries visible while a child loads and ignores superseded pages', async () => {
    const value = filesTab()
    const tab = shallowRef<TaskFilesContextTab | null>(value)
    const child = deferred<{ entries: [], nextCursor: string | null }>()
    let version = 'before.txt'
    const listDirectory = vi.fn().mockImplementation(async ({ path }: { path: string }) => path === 'src'
      ? child.promise
      : {
          entries: [{ name: 'src', path: 'src', kind: 'directory', unavailable: false }, { name: version, path: version, kind: 'file', unavailable: false }],
          nextCursor: null,
        })
    const { state } = openFiles(tab, listDirectory)
    await vi.waitFor(() => expect(state.current.value?.loadingKeys.size).toBe(0))
    state.current.value!.expandedKeys = ['src']
    const oldLoad = state.load(state.current.value!.nodes[0]!)
    version = 'after.txt'
    const refresh = state.refresh()
    await vi.waitFor(() => expect(state.current.value?.nodes[1]?.key).toBe('after.txt'))
    expect(state.current.value?.loadingKeys.has('src')).toBe(true)
    tab.value = { ...value, target: { ...value.target, revision: 2 } }
    await vi.waitFor(() => expect(state.current.value?.loadingKeys.size).toBe(0))
    child.resolve({ entries: [], nextCursor: 'old-page' })
    await Promise.all([oldLoad, refresh])
    expect(state.current.value?.nodes[0]?.children).toBeUndefined()
    expect(listDirectory.mock.calls.some(([input]) => input.cursor === 'old-page')).toBe(false)
  })

  it('refreshes only visible directories and restores nested expansion when a parent reopens', async () => {
    const value = filesTab()
    const tab = shallowRef<TaskFilesContextTab | null>(value)
    const listDirectory = vi.fn().mockImplementation(async ({ path }: { path: string }) => ({ entries: [
      path === ''
        ? { name: 'src', path: 'src', kind: 'directory', unavailable: false }
        : path === 'src'
          ? { name: 'deep', path: 'src/deep', kind: 'directory', unavailable: false }
          : { name: 'note.txt', path: 'src/deep/note.txt', kind: 'file', unavailable: false },
    ], nextCursor: null }))
    const { state } = openFiles(tab, listDirectory)
    await vi.waitFor(() => expect(state.current.value?.loadingKeys.size).toBe(0))
    state.current.value!.expandedKeys = ['src', 'src/deep']
    await state.load(state.current.value!.nodes[0]!)
    state.current.value!.expandedKeys = ['src/deep']
    listDirectory.mockClear()
    await state.refresh()
    expect(listDirectory.mock.calls.map(([input]) => input.path)).toEqual([''])
    expect(state.current.value?.expandedKeys).toEqual(['src/deep'])
    state.current.value!.expandedKeys = ['src', 'src/deep']
    await state.load(state.current.value!.nodes[0]!)
    expect(state.current.value?.nodes[0]?.children?.[0]?.children?.[0]?.key).toBe('src/deep/note.txt')
  })

  it('reads legacy Markdown artifacts without requiring their stored MIME type to change', async () => {
    const artifact = { ...createArtifact('legacy'), name: 'legacy.markdown', mimeType: 'application/octet-stream' }
    const text = { artifactId: artifact.artifactId, language: 'markdown', text: '# Original document' }
    const { state } = own(() => useArtifactPreview({ artifact: () => artifact, readText: () => async () => text }))
    expect(state.textPreviewLoading.value).toBe(true)
    await nextTick()
    expect(state.textPreview.value).toEqual(text)
    expect(state.textPreviewLoading.value).toBe(false)
  })

  it('ignores late text success and failure after switching artifacts or closing the preview', async () => {
    const first = deferred<LocalArtifactText>()
    const second = deferred<LocalArtifactText>()
    const artifact = shallowRef(createArtifact('first'))
    const readText = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue({ artifactId: 'current', language: null, text: 'current' })
    const { state, stop } = own(() => useArtifactPreview({ artifact: () => artifact.value, readText: () => readText }))
    artifact.value = createArtifact('second')
    artifact.value = createArtifact('current')
    await nextTick()
    first.resolve({ artifactId: 'first', language: null, text: 'old' })
    second.reject(new Error('old failure'))
    await nextTick()
    expect(state.textPreview.value?.text).toBe('current')
    expect(state.textPreviewFailed.value).toBe(false)
    const pending = deferred<LocalArtifactText>()
    readText.mockReturnValueOnce(pending.promise)
    artifact.value = createArtifact('disposed')
    stop()
    pending.resolve({ artifactId: 'disposed', language: null, text: 'disposed' })
    await nextTick()
    expect(state.textPreview.value).toBeNull()
  })

  it('ignores image errors from a previously selected artifact', () => {
    const artifact = shallowRef({ ...createArtifact('image-a'), mimeType: 'image/png' })
    const { state } = own(() => useArtifactPreview({ artifact: () => artifact.value, readText: () => vi.fn() }))
    const oldImage = document.createElement('img')
    oldImage.setAttribute('src', state.previewUrl.value!)
    artifact.value = { ...createArtifact('image-b'), mimeType: 'image/png' }
    state.failImage({ target: oldImage } as unknown as Event)
    expect(state.previewUrl.value).toContain('image-b')
  })

  it('preserves selection and updates file counts when the same change set refreshes', async () => {
    const changeSet = shallowRef<LocalChangeSetSummary>(createChanges('set-a'))
    const refresh = deferred<LocalChangeSetDetail>()
    const getDetail = vi.fn().mockResolvedValueOnce(createChanges('set-a')).mockReturnValueOnce(refresh.promise)
    const { state } = own(() => useContextChanges({ hasTab: () => true, tab: computed<TaskChangesContextTab>(() => ({ id: 'changes:conversation', scope: 'task:conversation', conversationId: 'conversation', kind: 'changes', changeSet: changeSet.value, branchId: 'branch', revision: changeSet.value.updatedAt })), getChangeSet: getDetail, getOverview: async () => createChanges('all') }))
    await nextTick()
    state.current.value!.selectedFileId = 'second'
    changeSet.value = { ...changeSet.value, updatedAt: '2026-09-09T00:00:00.000Z' }
    expect(state.current.value?.selectedFileId).toBe('second')
    expect(state.current.value?.loading).toBe(false)
    const refreshed = createChanges('set-a')
    refresh.resolve({ ...refreshed, files: refreshed.files.map((file, index) => index === 0 ? { ...file, afterText: 'updated\nextra\n' } : file) })
    await nextTick()
    expect(state.current.value?.selectedFileId).toBe('second')
    expect(state.nodes.value.map(node => node.lineCounts)).toEqual([{ added: 2, deleted: 1 }, { added: 1, deleted: 1 }])
    expect(state.counts.value).toEqual({ added: 3, deleted: 2 })
    getDetail.mockResolvedValueOnce({ ...createChanges('set-a'), files: createChanges('set-a').files.slice(0, 1) })
    changeSet.value = { ...changeSet.value, updatedAt: '2026-09-10T00:00:00.000Z' }
    await nextTick()
    expect(state.current.value?.selectedFileId).toBe('first')
  })

  it('invalidates change loads across A to B to A and disposal', async () => {
    const pending = deferred<LocalChangeSetDetail>()
    const changeSet = shallowRef<LocalChangeSetSummary>(createChanges('a'))
    const getDetail = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(createChanges('current'))
    const { state, stop } = own(() => useContextChanges({ hasTab: () => true, tab: computed<TaskChangesContextTab>(() => ({ id: 'changes:conversation', scope: 'task:conversation', conversationId: 'conversation', kind: 'changes', changeSet: changeSet.value, branchId: 'branch', revision: changeSet.value.updatedAt })), getChangeSet: getDetail, getOverview: async () => createChanges('all') }))
    changeSet.value = createChanges('b')
    changeSet.value = createChanges('a')
    await nextTick()
    pending.reject(new Error('old a'))
    await nextTick()
    expect(state.current.value?.detail?.files[0]?.path).toBe('current-first.ts')
    expect(state.current.value?.failed).toBe(false)
    const last = deferred<LocalChangeSetDetail>()
    getDetail.mockReturnValueOnce(last.promise)
    changeSet.value = createChanges('last')
    stop()
    last.resolve(createChanges('last'))
    await nextTick()
    expect(state.current.value).toBeNull()
  })
})

function filesTab(): TaskFilesContextTab {
  return { id: 'files:first', scope: 'task:first', kind: 'files', rootName: 'fixture', target: { spaceId: 'space', directoryId: 'directory', revision: 1, path: '' } }
}

function openFiles(tab: Ref<TaskFilesContextTab | null>, listDirectory: WorkspaceFilesApi['listDirectory'], hasTab = () => true) {
  return own(() => useWorkspaceFilePreview(tab, { listDirectory, readFile: vi.fn(), revealFile: vi.fn(), onFilesChanged: () => () => {}, fileHistory: async () => [], acknowledgeFileOperation: vi.fn(), cancelFileOperation: async () => null }, hasTab))
}

function createArtifact(id: string): LocalArtifact {
  return { artifactId: id, conversationId: 'conversation', createdAt: '2026-09-08T00:00:00.000Z', kind: 'file', mimeType: 'text/plain', name: `${id}.txt`, path: `/workspace/${id}.txt`, previewUrl: null, runId: 'run', sizeBytes: 10, sourceArtifactId: null, sourceToolCallId: 'tool', updatedAt: '2026-09-08T00:00:00.000Z' }
}
function createChanges(setId: string): LocalChangeSetDetail {
  return { changeSetId: setId, conversationId: 'conversation', coverage: 'complete', fileCount: 2, runId: 'run', status: 'completed', updatedAt: '2026-09-08T00:00:00.000Z', files: ['first', 'second'].map(id => ({ afterSizeBytes: 1, afterText: 'b', beforeSizeBytes: 1, beforeText: 'a', changeType: 'modified', id, language: 'typescript', path: `${setId}-${id}.ts`, preview: 'text', redacted: false })) }
}

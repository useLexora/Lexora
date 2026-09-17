// @vitest-environment jsdom
import type { LocalArtifact, LocalArtifactText } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetDetail, LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { TaskChangesContextTab, TaskFilesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, shallowRef } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { isMarkdownArtifact, resolveArtifactDisplayMode } from '../artifactContextPresentation'
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
    expect(state.current.value).not.toBe(previous)
    expect(state.current.value?.treeWidth).toBe(220)
  })

  it('stops directory pagination after its tab closes and discards late results', async () => {
    const value: TaskFilesContextTab = { id: 'files:first', scope: 'task:first', kind: 'files', rootName: 'fixture', target: { spaceId: 'space', directoryId: 'directory', revision: 1, path: '' } }
    const tab = shallowRef<TaskFilesContextTab | null>(value)
    const retained = shallowRef(true)
    const page = deferred<{ entries: [], nextCursor: string | null }>()
    const listDirectory = vi.fn().mockReturnValueOnce(page.promise).mockResolvedValue({ entries: [], nextCursor: null })
    const { state } = own(() => useWorkspaceFilePreview(tab, { listDirectory, readFile: vi.fn(), revealFile: vi.fn() }, () => retained.value))
    const previous = state.current.value!
    tab.value = null
    retained.value = false
    await nextTick()
    page.resolve({ entries: [], nextCursor: 'another-page' })
    await nextTick()
    expect(listDirectory).toHaveBeenCalledTimes(1)
    retained.value = true
    tab.value = value
    await nextTick()
    expect(state.current.value).not.toBe(previous)
    expect(state.current.value?.nodes).toEqual([])
  })

  it.each([
    ['report.md', 'text/markdown', 'file', true],
    ['REPORT.MD', 'text/plain', 'file', true],
    ['report.markdown', 'application/octet-stream', 'file', true],
    ['report', 'text/markdown', 'file', true],
    ['report.txt', 'text/plain', 'file', false],
    ['report.md', 'inode/directory', 'directory', false],
  ] as const)('recognizes Markdown for %s (%s, %s)', (name, mimeType, kind, expected) => {
    expect(isMarkdownArtifact({ name, mimeType, kind })).toBe(expected)
  })

  it.each([
    ['report.md', 'text/markdown', 'file', 'preview', 'preview'],
    ['report.md', 'text/markdown', 'file', 'source', 'source'],
    ['legacy.markdown', 'application/octet-stream', 'file', 'preview', 'preview'],
    ['notes.txt', 'text/plain', 'file', 'preview', 'source'],
    ['data.json', 'application/json', 'file', 'preview', 'source'],
    ['image.png', 'image/png', 'file', 'source', 'preview'],
    ['drawing.svg', 'image/svg+xml', 'file', 'source', 'preview'],
    ['report.pdf', 'application/pdf', 'file', 'preview', 'file'],
    ['archive.zip', 'application/zip', 'file', 'source', 'file'],
    ['folder.md', 'inode/directory', 'directory', 'source', 'directory'],
  ] as const)('selects the display mode for %s (%s, %s, requested %s)', (name, mimeType, kind, requested, expected) => {
    expect(resolveArtifactDisplayMode({ name, mimeType, kind }, requested)).toBe(expected)
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

  it.each(['resolve', 'reject'] as const)('ignores an old text request that finishes with %s', async (outcome) => {
    const first = deferred<LocalArtifactText>()
    const artifact = shallowRef(createArtifact('first'))
    const readText = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ artifactId: 'second', language: null, text: 'current' })
    const { state, stop } = own(() => useArtifactPreview({ artifact: () => artifact.value, readText: () => readText }))
    artifact.value = createArtifact('second')
    await nextTick()
    if (outcome === 'resolve')
      first.resolve({ artifactId: 'first', language: null, text: 'old' })
    else
      first.reject(new Error('old failure'))
    await nextTick()
    expect(state.textPreview.value?.text).toBe('current')
    expect(state.textPreviewFailed.value).toBe(false)
    const pending = deferred<LocalArtifactText>()
    readText.mockReturnValueOnce(pending.promise)
    artifact.value = createArtifact('third')
    stop()
    pending.resolve({ artifactId: 'third', language: null, text: 'disposed' })
    await nextTick()
    expect(state.textPreview.value).toBeNull()
  })

  it('reacts to a replacement reader and ignores old image errors', async () => {
    const artifact = shallowRef(createArtifact('first'))
    const reader = shallowRef(async () => ({ artifactId: 'first', language: null, text: 'before' }))
    const { state } = own(() => useArtifactPreview({ artifact: () => artifact.value, readText: () => reader.value }))
    await nextTick()
    reader.value = async () => ({ artifactId: 'first', language: null, text: 'after' })
    await nextTick()
    expect(state.textPreview.value?.text).toBe('after')
    artifact.value = { ...createArtifact('image-a'), mimeType: 'image/png' }
    const oldImage = document.createElement('img')
    oldImage.setAttribute('src', state.previewUrl.value!)
    artifact.value = { ...createArtifact('image-b'), mimeType: 'image/png' }
    state.failImage({ target: oldImage } as unknown as Event)
    expect(state.previewUrl.value).toContain('image-b')
  })

  it('keeps the selected change file and visible detail while the same set refreshes', async () => {
    const changeSet = shallowRef<LocalChangeSetSummary>(createChanges('set-a'))
    const refresh = deferred<LocalChangeSetDetail>()
    const getDetail = vi.fn().mockResolvedValueOnce(createChanges('set-a')).mockReturnValueOnce(refresh.promise)
    const { state } = own(() => useContextChanges({ hasTab: () => true, tab: computed<TaskChangesContextTab>(() => ({ id: 'changes:conversation', scope: 'task:conversation', conversationId: 'conversation', kind: 'changes', changeSet: changeSet.value, branchId: 'branch', revision: changeSet.value.updatedAt })), getChangeSet: getDetail, getOverview: async () => createChanges('all') }))
    await nextTick()
    state.current.value!.selectedFileId = 'second'
    changeSet.value = { ...changeSet.value, updatedAt: '2026-09-09T00:00:00.000Z' }
    expect(state.current.value?.selectedFileId).toBe('second')
    expect(state.current.value?.loading).toBe(false)
    refresh.resolve(createChanges('set-a'))
    await nextTick()
    expect(state.current.value?.selectedFileId).toBe('second')
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

  it('keeps file, tree and total counts consistent when captured content refreshes', async () => {
    const tab = shallowRef<TaskChangesContextTab>({ id: 'changes:conversation', scope: 'task:conversation', conversationId: 'conversation', kind: 'changes', changeSet: createChanges('a'), branchId: 'branch', revision: '1' })
    const getDetail = vi.fn().mockResolvedValue(createChanges('a'))
    const { state } = own(() => useContextChanges({ hasTab: () => true, tab, getChangeSet: getDetail, getOverview: getDetail }))
    await nextTick()
    expect(state.counts.value).toEqual({ added: 2, deleted: 2 })
    const next = createChanges('a')
    getDetail.mockResolvedValueOnce({
      ...next,
      files: next.files.map((file, index) => index === 0 ? { ...file, afterText: 'updated\nextra\n' } : file),
    })
    tab.value = { ...tab.value, revision: '2' }
    await nextTick()
    expect(state.current.value?.detail?.files.map(file => file.lineCounts)).toEqual([{ added: 2, deleted: 1 }, { added: 1, deleted: 1 }])
    expect(state.nodes.value.map(node => node.lineCounts)).toEqual([{ added: 2, deleted: 1 }, { added: 1, deleted: 1 }])
    expect(state.counts.value).toEqual({ added: 3, deleted: 2 })
  })
})

function createArtifact(id: string): LocalArtifact {
  return { artifactId: id, conversationId: 'conversation', createdAt: '2026-09-08T00:00:00.000Z', kind: 'file', mimeType: 'text/plain', name: `${id}.txt`, path: `/workspace/${id}.txt`, previewUrl: null, runId: 'run', sizeBytes: 10, sourceArtifactId: null, sourceToolCallId: 'tool', updatedAt: '2026-09-08T00:00:00.000Z' }
}
function createChanges(setId: string): LocalChangeSetDetail {
  return { changeSetId: setId, conversationId: 'conversation', coverage: 'complete', fileCount: 2, runId: 'run', status: 'completed', updatedAt: '2026-09-08T00:00:00.000Z', files: ['first', 'second'].map(id => ({ afterSizeBytes: 1, afterText: 'b', beforeSizeBytes: 1, beforeText: 'a', changeType: 'modified', id, language: 'typescript', path: `${setId}-${id}.ts`, preview: 'text', redacted: false })) }
}

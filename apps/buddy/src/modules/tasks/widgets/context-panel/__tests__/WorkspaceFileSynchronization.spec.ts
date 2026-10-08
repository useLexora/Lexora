// @vitest-environment jsdom
import type { TaskFilesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import type { WorkspaceEntryChange } from '@/modules/tasks/model/context-panel/workspaceFilesApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useWorkspaceFilePreview } from '../useWorkspaceFilePreview'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
async function flush() {
  await Promise.resolve()
  await nextTick()
}
function tab(id = 'one', directoryId = 'directory'): TaskFilesContextTab {
  return { id: `files:${id}`, scope: 'workspace', kind: 'files', rootName: 'fixture', target: { spaceId: 'space', directoryId, revision: 1, path: '' } }
}
function own<T>(setup: () => T) {
  const scope = effectScope()
  scopes.push(scope)
  return { state: scope.run(setup)!, stop: () => scope.stop() }
}

describe('workspace file tree synchronization', () => {
  it('invalidates related tabs, prunes only the removed boundary and refreshes inactive tabs on activation', async () => {
    const first = tab()
    const second = tab('two')
    const unrelated = tab('other', 'another-directory')
    const active = shallowRef<TaskFilesContextTab | null>(first)
    let changed!: (event: WorkspaceEntryChange) => void
    let renamed = false
    const unsubscribe = vi.fn()
    const listDirectory = vi.fn(async ({ path }: { path: string }) => ({ entries: path ? [] : [renamed ? 'renamed' : 'src', 'src-other', 'keep'].map(name => ({ name, path: name, kind: 'directory' as const, unavailable: false })), nextCursor: null }))
    const { state, stop } = own(() => useWorkspaceFilePreview(active, { listDirectory, readFile: vi.fn(), revealFile: vi.fn(), onEntriesChanged: (listener) => {
      changed = listener
      return unsubscribe
    } }, () => true))
    await flush()
    const firstView = state.current.value!
    firstView.expandedKeys = ['src', 'src/inner', 'src-other', 'keep']
    firstView.selectedKey = 'src/file.ts'
    active.value = second
    await flush()
    const secondView = state.current.value!
    secondView.expandedKeys = ['src']
    active.value = unrelated
    await flush()
    const calls = listDirectory.mock.calls.length
    renamed = true
    changed({ target: first.target, removedPath: 'src' })
    expect(listDirectory).toHaveBeenCalledTimes(calls)
    expect(firstView.expandedKeys).toEqual(['src-other', 'keep'])
    expect(firstView.selectedKey).toBeNull()
    expect(secondView.expandedKeys).toEqual([])
    expect(firstView.stale).toBe(true)
    expect(secondView.stale).toBe(true)
    expect(state.current.value?.stale).toBe(false)
    active.value = second
    await flush()
    expect(secondView.stale).toBe(false)
    expect(secondView.nodes.map(node => node.key)).toEqual(['renamed', 'src-other', 'keep'])
    active.value = first
    await flush()
    await flush()
    await flush()
    expect(firstView.stale).toBe(false)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('discards an obsolete initial page and stops its pagination after a newer refresh', async () => {
    const active = shallowRef<TaskFilesContextTab | null>(tab())
    const pending = deferred<{ entries: [], nextCursor: string | null }>()
    const listDirectory = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ entries: [{ name: 'new.md', path: 'new.md', kind: 'file', unavailable: false }], nextCursor: null })
    const { state } = own(() => useWorkspaceFilePreview(active, { listDirectory, readFile: vi.fn(), revealFile: vi.fn() }, () => true))
    expect(await state.refresh()).toBe(true)
    pending.resolve({ entries: [], nextCursor: 'obsolete-next-page' })
    await flush()
    expect(state.current.value?.nodes[0]?.key).toBe('new.md')
    expect(listDirectory).toHaveBeenCalledTimes(2)
  })
  it('keeps junction descendants read-only through both lazy loading and expanded refresh', async () => {
    const active = shallowRef<TaskFilesContextTab | null>(tab())
    const listDirectory = vi.fn(async ({ path }: { path: string }) => ({ entries: path ? [{ name: 'child.md', path: `${path}/child.md`, kind: 'file' as const, unavailable: false, writable: true }] : [{ name: 'link', path: 'link', kind: 'directory' as const, unavailable: false, writable: false }], nextCursor: null }))
    const { state } = own(() => useWorkspaceFilePreview(active, { listDirectory, readFile: vi.fn(), revealFile: vi.fn() }, () => true))
    await flush()
    await state.load(state.current.value!.nodes[0]!)
    expect(state.current.value?.nodes[0]?.children?.[0]?.writable).toBe(false)
    state.current.value!.expandedKeys = ['link']
    await state.refresh()
    expect(state.current.value?.nodes[0]?.children?.[0]?.writable).toBe(false)
  })
})

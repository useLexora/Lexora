import type { SpaceFileMutationResult } from '@buddy-shared/spaces/spaceFileApi'
import type { DirtyFileChoice } from '../WorkspaceFileOperations'
import type { ResourceRef } from '@/workbench/common/workbench'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkingCopyBackup } from '@/workbench/services/WorkingCopyBackup'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { WorkspaceFileMutationGuard } from '../WorkspaceFileMutationGuard'
import { WorkspaceFileOperations } from '../WorkspaceFileOperations'

const target = { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'src' }
function resource(path = 'src/note.md', scheme = 'file'): ResourceRef {
  return { scheme, id: JSON.stringify([target.directoryId, target.revision, path]), data: { ...target, path } }
}
function fixture() {
  const guard = new WorkspaceFileMutationGuard()
  const read = vi.fn(async () => ({ text: 'disk', etag: 'a' }))
  const save = vi.fn(async (_: ResourceRef, document: { text: string, etag: string }) => ({ status: 'saved' as 'saved' | 'conflict', document }))
  const copies = new WorkingCopyService({ canAccess: value => guard.allowed(value), read, save })
  const backups = new WorkingCopyBackup(copies, async () => {})
  const registry = new ContributionRegistry()
  registry.register('fixture', scope => scope.view({ id: 'file', renderer: 'file', label: 'File', locations: ['context'], multiple: true, supports: () => true }))
  const controller = new WorkbenchController(registry, async view => guard.allowed(view.resource), undefined, value => guard.allowed(value))
  const mutate = vi.fn(async (): Promise<SpaceFileMutationResult> => ({ status: 'completed', path: 'renamed', kind: 'directory' }))
  const confirmDirty = vi.fn(async (): Promise<DirtyFileChoice> => 'discard')
  const flush = vi.fn(async () => {})
  const changed = vi.fn()
  const synchronize = vi.fn()
  const report = vi.fn()
  const operations = new WorkspaceFileOperations({ guard, copies, controller, mutate, confirmDirty, flush, changed, synchronize, report, retain: () => () => {} })
  async function open(path = 'src/note.md', dirty = false, scheme = 'file') {
    const ref = resource(path, scheme)
    if (scheme === 'file') {
      await copies.open(ref)
      if (dirty)
        copies.edit(ref, 'unsaved')
    }
    const id = await controller.open(ref, path, { duplicate: true })
    return { ref, id: id! }
  }
  return { operations, copies, backups, controller, mutate, confirmDirty, read, save, flush, changed, synchronize, report, open, guard }
}

describe('opened workspace file operations', () => {
  it('renames dirty descendants and every view, retaining text, base, etag and backups at the new path', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    const b = await f.open()
    const other = await f.open('src-other/note.md', true)
    const preview = await f.open('src/image.png', false, 'file-preview')
    expect(await f.operations.mutate({ ...target, operation: 'rename', name: 'renamed' })).toMatchObject({ status: 'completed' })
    expect(f.copies.get(a.ref)).toBeUndefined()
    const renamed = resource('renamed/note.md')
    expect(f.copies.get(renamed)).toMatchObject({ text: 'unsaved', baseText: 'disk', etag: 'a', dirty: true, blocked: false })
    for (const id of [a.id, b.id]) expect(f.controller.layout.views[id]).toMatchObject({ resource: renamed, title: 'note.md' })
    expect(f.controller.layout.views[preview.id]?.resource.data.path).toBe('renamed/image.png')
    expect(f.copies.get(other.ref)?.text).toBe('unsaved')
    expect(f.backups.snapshot().backups.map(copy => copy.resource)).toContainEqual(renamed)
    expect(f.backups.snapshot().backups.map(copy => copy.resource)).not.toContainEqual(a.ref)
    expect(f.confirmDirty).not.toHaveBeenCalled()
    await f.copies.save(renamed)
    expect(f.save).toHaveBeenCalledWith(renamed, { text: 'unsaved', etag: 'a' })
  })
  it('keeps all editor state and paths after a failed rename', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    f.mutate.mockResolvedValue({ status: 'failed', reason: 'exists' })
    expect(await f.operations.mutate({ ...target, operation: 'rename', name: 'renamed' })).toMatchObject({ reason: 'exists' })
    expect(f.copies.get(a.ref)).toMatchObject({ text: 'unsaved', dirty: true, blocked: false })
    expect(f.controller.layout.views[a.id]?.resource).toEqual(a.ref)
    expect(f.changed).not.toHaveBeenCalled()
  })
  it('cancels trash without saving, deleting, discarding or closing', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    f.confirmDirty.mockResolvedValue('cancel')
    expect(await f.operations.mutate({ ...target, operation: 'trash' })).toEqual({ status: 'cancelled' })
    expect(f.mutate).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
    expect(f.copies.get(a.ref)).toMatchObject({ text: 'unsaved', dirty: true, blocked: false })
    expect(f.controller.layout.views[a.id]).toBeTruthy()
  })
  it('discards only after trash succeeds, then closes every descendant view', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    const b = await f.open('src/two.md', true)
    const outside = await f.open('src-other/file.md')
    const done = deferred<SpaceFileMutationResult>()
    f.mutate.mockReturnValue(done.promise)
    const pending = f.operations.mutate({ ...target, operation: 'trash' })
    await vi.waitFor(() => expect(f.mutate).toHaveBeenCalled())
    expect(f.copies.get(a.ref)?.text).toBe('unsaved')
    expect(f.controller.layout.views[a.id]).toBeTruthy()
    expect(await f.controller.close(a.id)).toMatchObject({ committed: false })
    done.resolve({ status: 'completed', path: '', kind: 'directory' })
    expect(await pending).toMatchObject({ status: 'completed' })
    expect(f.controller.layout.views[a.id]).toBeUndefined()
    expect(f.controller.layout.views[b.id]).toBeUndefined()
    expect(f.controller.layout.views[outside.id]).toBeTruthy()
    expect(f.copies.get(a.ref)).toBeUndefined()
    expect(f.backups.snapshot().backups).toHaveLength(0)
    expect(f.save).not.toHaveBeenCalled()
  })
  it('retains discarded-but-not-yet-deleted text when trash fails', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    f.mutate.mockResolvedValue({ status: 'failed', reason: 'permission' })
    expect(await f.operations.mutate({ ...target, operation: 'trash' })).toMatchObject({ reason: 'permission' })
    expect(f.copies.get(a.ref)).toMatchObject({ text: 'unsaved', dirty: true, blocked: false })
    expect(f.controller.layout.views[a.id]).toBeTruthy()
  })
  it('saves dirty copies before trash and preserves successful saves if trash fails', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    f.confirmDirty.mockResolvedValue('save')
    f.mutate.mockImplementation(async () => {
      expect(f.copies.get(a.ref)?.dirty).toBe(false)
      return { status: 'failed', reason: 'busy' }
    })
    expect(await f.operations.mutate({ ...target, operation: 'trash' })).toMatchObject({ reason: 'busy' })
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.copies.get(a.ref)).toMatchObject({ text: 'unsaved', dirty: false, blocked: false })
    expect(f.controller.layout.views[a.id]).toBeTruthy()
  })
  it('aborts trash on save conflict without losing local content', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    f.confirmDirty.mockResolvedValue('save')
    f.save.mockResolvedValue({ status: 'conflict', document: { text: 'external', etag: 'b' } })
    expect(await f.operations.mutate({ ...target, operation: 'trash' })).toMatchObject({ reason: 'save-conflict' })
    expect(f.mutate).not.toHaveBeenCalled()
    expect(f.copies.get(a.ref)).toMatchObject({ text: 'unsaved', dirty: true, conflict: { text: 'external' }, blocked: false })
  })
  it('aborts trash on save failure without closing editors', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    f.confirmDirty.mockResolvedValue('save')
    f.save.mockRejectedValue(new Error('disk full'))
    expect(await f.operations.mutate({ ...target, operation: 'trash' })).toMatchObject({ reason: 'save-failed' })
    expect(f.mutate).not.toHaveBeenCalled()
    expect(f.controller.layout.views[a.id]).toBeTruthy()
    expect(f.copies.get(a.ref)?.dirty).toBe(true)
  })
  it('fences open/edit/save/discard/conflict resolution and both rename paths while pending', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    const done = deferred<SpaceFileMutationResult>()
    f.mutate.mockReturnValue(done.promise)
    const pending = f.operations.mutate({ ...target, operation: 'rename', name: 'renamed' })
    await vi.waitFor(() => expect(f.mutate).toHaveBeenCalled())
    f.copies.edit(a.ref, 'lost edit')
    f.copies.discard(a.ref)
    expect(f.copies.get(a.ref)?.text).toBe('unsaved')
    expect(await f.copies.save(a.ref)).toMatchObject({ reason: 'blocked' })
    await expect(f.copies.open(a.ref)).rejects.toThrow('WORKING_COPY_BLOCKED')
    expect(await f.controller.open(resource('renamed/note.md'), 'New')).toBeNull()
    expect(await f.operations.mutate({ ...target, operation: 'trash' })).toMatchObject({ reason: 'busy' })
    done.resolve({ status: 'completed', path: 'renamed', kind: 'directory' })
    await pending
    expect(f.copies.canAccess(resource('renamed/note.md'))).toBe(true)
  })
  it.each(['loading', 'saving'] as const)('does not mutate while a copy is %s', async (state) => {
    const f = fixture()
    const done = deferred<{ text: string, etag: string }>()
    let pending: Promise<unknown>
    if (state === 'loading') {
      f.read.mockReturnValue(done.promise)
      pending = f.copies.open(resource())
    }
    else {
      await f.open(undefined, true)
      f.save.mockImplementation(async () => ({ status: 'saved', document: await done.promise }))
      pending = f.copies.save(resource())
    }
    expect(await f.operations.mutate({ ...target, operation: 'rename', name: 'renamed' })).toMatchObject({ reason: 'busy' })
    expect(f.mutate).not.toHaveBeenCalled()
    done.resolve({ text: 'disk', etag: 'a' })
    await pending
  })
  it('does not overwrite a destination working copy', async () => {
    const f = fixture()
    await f.open(undefined, true)
    const destination = await f.open('renamed/note.md', true)
    expect(await f.operations.mutate({ ...target, operation: 'rename', name: 'renamed' })).toMatchObject({ reason: 'destination-open' })
    expect(f.mutate).not.toHaveBeenCalled()
    expect(f.copies.get(destination.ref)?.text).toBe('unsaved')
  })
  it('retains recovery content and fences stale writes on an uncertain outcome', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    f.mutate.mockRejectedValue(new Error('transport disconnected'))
    expect(await f.operations.mutate({ ...target, operation: 'rename', name: 'renamed' })).toMatchObject({ reason: 'result-unknown' })
    expect(f.copies.get(a.ref)).toMatchObject({ text: 'unsaved', dirty: true, blocked: true })
    expect(await f.copies.save(a.ref)).toMatchObject({ reason: 'blocked' })
    expect(f.controller.layout.views[a.id]).toBeTruthy()
    expect(f.backups.snapshot().backups).toHaveLength(1)
  })
  it('does not touch disk when recovery persistence fails', async () => {
    const f = fixture()
    const a = await f.open(undefined, true)
    f.flush.mockRejectedValue(new Error('backup failed'))
    expect(await f.operations.mutate({ ...target, operation: 'trash' })).toMatchObject({ reason: 'failed' })
    expect(f.mutate).not.toHaveBeenCalled()
    expect(f.copies.get(a.ref)).toMatchObject({ text: 'unsaved', blocked: false })
  })
  it('does not report a retryable failure if post-commit persistence fails', async () => {
    const f = fixture()
    await f.open(undefined, true)
    f.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('backup failed'))
    expect(await f.operations.mutate({ ...target, operation: 'rename', name: 'renamed' })).toMatchObject({ status: 'completed' })
    expect(f.copies.get(resource('renamed/note.md'))?.dirty).toBe(true)
    expect(f.report).toHaveBeenCalled()
  })
})

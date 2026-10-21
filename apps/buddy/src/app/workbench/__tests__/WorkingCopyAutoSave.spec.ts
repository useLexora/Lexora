import type { ResourceRef } from '@/workbench/common/workbench'
import type { TextDocument, WorkingCopyProvider } from '@/workbench/services/WorkingCopyService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@/workbench/common/workbench'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { WorkingCopyAutoSave } from '../WorkingCopyAutoSave'

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})
function resource(path = 'notes.md', revision = 1): ResourceRef {
  return { scheme: 'file', id: `${revision}:${path}`, data: { directoryId: 'directory', spaceId: 'space', path, revision } }
}
function fixture(options: { enabled?: boolean, start?: boolean } = {}) {
  const registry = new ContributionRegistry()
  registry.register('files', scope => scope.configuration({ id: 'files.autoSave', defaultValue: 'afterDelay', validate: value => value === 'off' || value === 'afterDelay' }))
  const controller = new WorkbenchController(registry)
  const disk = new Map<string, TextDocument>()
  const pending: Array<{ finish: () => void }> = []
  const state = { fail: false, conflict: false, defer: false }
  const save = vi.fn<WorkingCopyProvider['save']>(async (target, document): ReturnType<WorkingCopyProvider['save']> => {
    if (state.fail)
      throw new Error('DISK_UNAVAILABLE')
    if (state.conflict)
      return { status: 'conflict', document: { text: 'external', etag: 'external-version' } }
    if (state.defer) {
      const gate = Promise.withResolvers<void>()
      pending.push({ finish: () => gate.resolve() })
      await gate.promise
    }
    const saved = { text: document.text, etag: `saved-${save.mock.calls.length}` }
    disk.set(resourceKey(target), saved)
    return { status: 'saved', document: saved }
  })
  const copies = new WorkingCopyService({
    read: async target => disk.get(resourceKey(target)) ?? { text: 'base', etag: 'initial' },
    save,
  })
  const autoSave = new WorkingCopyAutoSave(copies, controller.configuration)
  if (options.enabled === false)
    autoSave.setEnabled(false)
  if (options.start !== false)
    autoSave.start()
  cleanups.push(async () => {
    autoSave.dispose()
    pending.forEach(value => value.finish())
    await copies.dispose()
    await controller.dispose()
    registry.dispose()
  })
  return { registry, controller, copies, autoSave, save, disk, state, pending }
}
async function tick(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('working-copy auto save', () => {
  it('defaults to enabled, debounces the last edit, and writes through the existing save provider', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    expect(f.autoSave.enabled).toBe(true)
    f.copies.edit(r, 'first')
    expect(f.autoSave.status(r)).toBe('waiting')
    await tick(700)
    f.copies.edit(r, 'latest')
    await tick(999)
    expect(f.save).not.toHaveBeenCalled()
    await tick(1)
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(f.disk.get(resourceKey(r))?.text).toBe('latest')
    expect(f.copies.dirty(r)).toBe(false)
    expect(f.autoSave.status(r)).toBe('idle')
  })

  it('does not auto save while disabled and keeps manual save working', async () => {
    const f = fixture({ enabled: false })
    const r = resource()
    await f.copies.open(r)
    f.copies.edit(r, 'manual')
    await tick(5000)
    expect(f.save).not.toHaveBeenCalled()
    expect(f.autoSave.status(r)).toBe('off')
    await f.copies.save(r)
    expect(f.disk.get(resourceKey(r))?.text).toBe('manual')
    f.copies.edit(r, 'pending')
    f.autoSave.setEnabled(true)
    await tick()
    expect(f.disk.get(resourceKey(r))?.text).toBe('pending')
  })

  it('never forces a max-wait save during continuous typing', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    for (let i = 0; i < 12; i++) {
      f.copies.edit(r, `input ${i}`)
      await tick(600)
    }
    expect(f.save).not.toHaveBeenCalled()
    await tick(400)
    expect(f.save).toHaveBeenCalledTimes(1)
  })

  it('debounces separate resource identities independently and shares one working-copy task', async () => {
    const f = fixture()
    const a = resource('same.md', 1)
    const b = resource('same.md', 2)
    await Promise.all([f.copies.open(a), f.copies.open(a), f.copies.open(b)])
    f.copies.edit(a, 'A')
    await tick(500)
    f.copies.edit(b, 'B')
    await tick(500)
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(f.disk.get(resourceKey(a))?.text).toBe('A')
    expect(f.copies.dirty(b)).toBe(true)
    await tick(500)
    expect(f.save).toHaveBeenCalledTimes(2)
  })

  it.each([200, 1500])('serializes newer edits when an in-flight write finishes after %i ms', async (elapsed) => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.state.defer = true
    f.copies.edit(r, 'first')
    await tick()
    expect(f.autoSave.status(r)).toBe('saving')
    f.copies.edit(r, 'newer')
    expect(f.autoSave.status(r)).toBe('saving-dirty')
    await tick(elapsed)
    expect(f.save).toHaveBeenCalledTimes(1)
    f.state.defer = false
    f.pending[0]!.finish()
    await tick(0)
    if (elapsed < 1000) {
      expect(f.save).toHaveBeenCalledTimes(1)
      expect(f.copies.dirty(r)).toBe(true)
      await tick(1000 - elapsed)
    }
    expect(f.save).toHaveBeenCalledTimes(2)
    expect(f.disk.get(resourceKey(r))?.text).toBe('newer')
    expect(f.copies.dirty(r)).toBe(false)
  })

  it('cancels stale deadlines after a manual save', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.copies.edit(r, 'manual')
    await f.copies.save(r)
    await tick(3000)
    expect(f.save).toHaveBeenCalledTimes(1)
  })

  it('cancels pending work and does not supplement an in-flight save after disabling', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.copies.edit(r, 'cancel')
    f.autoSave.setEnabled(false)
    await tick(2000)
    expect(f.save).not.toHaveBeenCalled()
    f.autoSave.setEnabled(true)
    f.state.defer = true
    await tick()
    f.copies.edit(r, 'keep unsaved')
    f.autoSave.setEnabled(false)
    f.pending[0]!.finish()
    await tick(3000)
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(f.copies.dirty(r)).toBe(true)
  })

  it('pauses failures across edits and switch toggles, allows other files, and resumes explicitly', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.state.fail = true
    f.copies.edit(r, 'failed')
    await tick()
    expect(f.autoSave.status(r)).toBe('failed')
    f.state.fail = false
    f.copies.edit(r, 'new after failure')
    f.autoSave.setEnabled(false)
    f.autoSave.setEnabled(true)
    const other = resource('other.txt')
    await f.copies.open(other)
    f.copies.edit(other, 'other content')
    await tick(4000)
    expect(f.save).toHaveBeenCalledTimes(2)
    expect(f.copies.dirty(r)).toBe(true)
    await f.autoSave.retry(r)
    expect(f.autoSave.status(r)).toBe('idle')
    expect(f.disk.get(resourceKey(r))?.text).toBe('new after failure')
    f.copies.edit(r, 'resumed')
    await tick()
    expect(f.disk.get(resourceKey(r))?.text).toBe('resumed')
  })

  it('resumes newer edits after a successful manual retry, and after resolving a manual retry conflict', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.state.fail = true
    f.copies.edit(r, 'failed')
    await tick()
    f.state.fail = false
    f.state.conflict = true
    await f.copies.save(r)
    f.state.conflict = false
    f.copies.resolveConflict(r, 'local')
    await tick()
    expect(f.copies.dirty(r)).toBe(false)
    f.state.fail = true
    f.copies.edit(r, 'failed again')
    await tick()
    f.state.fail = false
    f.state.defer = true
    const manual = f.copies.save(r)
    f.copies.edit(r, 'new during manual retry')
    await tick(1500)
    f.state.defer = false
    f.pending[0]!.finish()
    await manual
    await tick(0)
    expect(f.disk.get(resourceKey(r))?.text).toBe('new during manual retry')
    expect(f.autoSave.status(r)).toBe('idle')
  })

  it.each(['disk', 'local'] as const)('never overwrites a conflict and respects the %s choice', async (choice) => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.state.conflict = true
    f.copies.edit(r, 'local')
    await tick()
    expect(f.autoSave.status(r)).toBe('conflict')
    await tick(5000)
    expect(f.save).toHaveBeenCalledTimes(1)
    f.state.conflict = false
    f.copies.resolveConflict(r, choice)
    await tick()
    expect(f.save).toHaveBeenCalledTimes(choice === 'local' ? 2 : 1)
    expect(f.copies.get(r)?.text).toBe(choice === 'local' ? 'local' : 'external')
  })

  it('does not write before startup or silently save a restored draft after loading and further edits', async () => {
    const f = fixture({ start: false })
    const r = resource()
    f.copies.restore([{ key: resourceKey(r), resource: JSON.parse(JSON.stringify(r)), text: 'recovered', baseText: 'base', etag: 'initial', savedAt: '2026-10-21T00:00:00Z' }])
    await f.copies.open(r)
    await tick(3000)
    f.autoSave.start()
    f.copies.edit(r, 'continued draft')
    f.autoSave.setEnabled(false)
    f.autoSave.setEnabled(true)
    await tick(3000)
    expect(f.autoSave.status(r)).toBe('recovered')
    expect(f.save).not.toHaveBeenCalled()
    await f.autoSave.retry(r)
    expect(f.disk.get(resourceKey(r))?.text).toBe('continued draft')
    expect(f.autoSave.status(r)).toBe('idle')
  })

  it('accepts a manual save of recovered content without changing global settings', async () => {
    const f = fixture()
    const r = resource()
    f.copies.restore([{ key: resourceKey(r), resource: JSON.parse(JSON.stringify(r)), text: 'recovered', baseText: 'base', etag: 'initial', savedAt: '2026-10-21T00:00:00Z' }])
    await f.copies.open(r)
    await f.copies.save(r)
    expect(f.autoSave.status(r)).toBe('idle')
    f.copies.edit(r, 'next edit')
    await tick()
    expect(f.save).toHaveBeenCalledTimes(2)
  })

  it('obeys file-operation guards and waits again after the guard is released', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    const spy = vi.spyOn(f.copies, 'save')
    f.copies.edit(r, 'guarded')
    const release = f.copies.guard(() => true)
    await tick(3000)
    expect(f.autoSave.status(r)).toBe('blocked')
    expect(f.save).not.toHaveBeenCalled()
    release()
    await tick(999)
    expect(f.save).not.toHaveBeenCalled()
    await tick(1)
    expect(spy).toHaveBeenCalledWith(r)
    expect(spy.mock.calls.every(call => call.length === 1)).toBe(true)
  })

  it('migrates the task to the latest resource without writing the old path', async () => {
    const f = fixture()
    const old = resource('old.md')
    const moved = resource('new.md')
    await f.copies.open(old)
    f.copies.edit(old, 'moved content')
    await tick(500)
    f.copies.move(old, moved)
    await tick(999)
    expect(f.save).not.toHaveBeenCalled()
    await tick(1)
    expect(f.save.mock.calls[0]?.[0]).toEqual(moved)
    expect(f.disk.has(resourceKey(old))).toBe(false)
  })

  it('keeps recovery and failure pauses when a resource is moved', async () => {
    const f = fixture()
    const old = resource('old.md')
    f.copies.restore([{ key: resourceKey(old), resource: JSON.parse(JSON.stringify(old)), text: 'recovered', baseText: 'base', etag: 'initial', savedAt: '2026-10-21T00:00:00Z' }])
    await f.copies.open(old)
    const moved = resource('new.md')
    f.copies.move(old, moved)
    await tick(3000)
    expect(f.autoSave.status(moved)).toBe('recovered')
    f.state.fail = true
    await f.autoSave.retry(moved)
    const again = resource('again.md')
    f.copies.move(moved, again)
    f.state.fail = false
    await tick(3000)
    expect(f.autoSave.status(again)).toBe('failed')
    expect(f.save).toHaveBeenCalledTimes(1)
  })

  it('does not let a discarded/released instance save a replacement at the same key', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    const incarnation = f.copies.get(r)!.incarnation
    f.copies.edit(r, 'old')
    f.copies.discard(r)
    expect(f.copies.release(r)).toBe(true)
    await f.copies.open(r)
    expect(f.copies.get(r)?.incarnation).not.toBe(incarnation)
    await tick(3000)
    expect(f.save).not.toHaveBeenCalled()
    f.copies.edit(r, 'replacement')
    await tick()
    expect(f.disk.get(resourceKey(r))?.text).toBe('replacement')
  })

  it('holds the close pause through discard cleanup, and cancellation resumes normal scheduling', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.copies.edit(r, 'discard me')
    const gate = Promise.withResolvers<void>()
    const preparing = f.autoSave.prepareClose(r, async () => {
      await gate.promise
      return { complete: () => f.copies.discard(r) }
    })
    await tick(3000)
    expect(f.autoSave.status(r)).toBe('paused')
    expect(f.save).not.toHaveBeenCalled()
    gate.resolve()
    const plan = await preparing
    if (typeof plan === 'boolean')
      throw new Error('Expected a close plan')
    await tick(2000)
    expect(f.save).not.toHaveBeenCalled()
    await plan.complete?.({ revision: 1 })
    await tick(2000)
    expect(f.save).not.toHaveBeenCalled()
    f.copies.edit(r, 'cancel close')
    expect(await f.autoSave.prepareClose(r, async () => false)).toBe(false)
    await tick()
    expect(f.disk.get(resourceKey(r))?.text).toBe('cancel close')
  })

  it('releases a stale close plan pause and a failed preparation without losing pending edits', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.copies.edit(r, 'keep')
    const plan = await f.autoSave.prepareClose(r, async () => ({ validate: () => false }))
    if (typeof plan === 'boolean')
      throw new Error('Expected a close plan')
    plan.cancel?.()
    await tick()
    expect(f.save).toHaveBeenCalledTimes(1)
    f.copies.edit(r, 'after failed close')
    await expect(f.autoSave.prepareClose(r, async () => {
      throw new Error('CLOSE_FAILED')
    })).rejects.toThrow('CLOSE_FAILED')
    await tick()
    expect(f.disk.get(resourceKey(r))?.text).toBe('after failed close')
  })

  it('waits for an in-flight write before preparing a close decision', async () => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.state.defer = true
    f.copies.edit(r, 'saving')
    await tick()
    const confirm = vi.fn(async () => true)
    const preparing = f.autoSave.prepareClose(r, confirm)
    await tick(1000)
    expect(confirm).not.toHaveBeenCalled()
    f.pending[0]!.finish()
    const plan = await preparing
    expect(confirm).toHaveBeenCalledTimes(1)
    if (typeof plan !== 'boolean')
      await plan.complete?.({ revision: 1 })
  })

  it.each(['cancel', 'discard', 'save', 'stale'] as const)('coordinates a real controller close with the %s decision', async (choice) => {
    const f = fixture()
    const r = resource()
    await f.copies.open(r)
    f.copies.edit(r, 'close content')
    f.registry.register('view', scope => scope.view({ id: 'files.editor', renderer: 'file', label: 'File', locations: ['main'], multiple: true, supports: () => true }))
    const gate = Promise.withResolvers<void>()
    const controller = new WorkbenchController(f.registry, view => f.autoSave.prepareClose(view.resource, async () => {
      const accepted = f.copies.get(r)!
      await gate.promise
      if (choice === 'cancel')
        return false
      if (choice === 'save') {
        await f.copies.save(r)
        return { validate: () => !f.copies.dirty(r) }
      }
      return { validate: () => f.copies.isCurrent(accepted), complete: () => f.copies.discard(r) }
    }))
    try {
      const id = (await controller.open(r, 'Notes'))!
      const closing = controller.close(id)
      await tick(3000)
      expect(f.save).not.toHaveBeenCalled()
      if (choice === 'stale')
        f.copies.edit(r, 'edited while confirming')
      gate.resolve()
      const result = await closing
      expect(result.committed).toBe(choice === 'discard' || choice === 'save')
      await tick()
      expect(f.save).toHaveBeenCalledTimes(choice === 'discard' ? 0 : 1)
      if (choice === 'stale')
        expect(f.disk.get(resourceKey(r))?.text).toBe('edited while confirming')
    }
    finally {
      gate.resolve()
      await controller.dispose()
    }
  })

  it('persists an explicit off preference through the existing workbench snapshot', async () => {
    const f = fixture()
    const snapshots: unknown[] = []
    const persistence = new WorkbenchPersistence({ read: async () => null, write: async (value) => {
      snapshots.push(value)
    } }, f.controller, f.copies, () => {})
    await persistence.restore()
    f.autoSave.setEnabled(false)
    await persistence.flush()
    expect(snapshots.at(-1)).toMatchObject({ configuration: { 'files.autoSave': 'off' } })
    const restored = fixture({ start: false })
    restored.controller.configuration.restore(f.controller.configuration.snapshot())
    restored.autoSave.start()
    expect(restored.autoSave.enabled).toBe(false)
    await persistence.dispose()
  })

  it('never auto saves preview resources and stops pending and post-save work on disposal', async () => {
    const f = fixture()
    const preview = { ...resource(), scheme: 'file-preview' }
    await f.copies.open(preview)
    f.copies.edit(preview, 'readonly')
    await tick(2000)
    expect(f.save).not.toHaveBeenCalled()
    const r = resource()
    await f.copies.open(r)
    f.copies.edit(r, 'first')
    f.state.defer = true
    await tick()
    f.copies.edit(r, 'not flushed on shutdown')
    f.autoSave.dispose()
    f.pending[0]!.finish()
    await tick(5000)
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(f.copies.dirty(r)).toBe(true)
    expect(f.copies.backups().some(backup => backup.text === 'not flushed on shutdown')).toBe(true)
  })
})

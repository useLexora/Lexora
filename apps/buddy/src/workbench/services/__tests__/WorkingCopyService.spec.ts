import type { WorkingCopyChange, WorkingCopyProvider } from '../WorkingCopyService'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { WorkingCopyBackup } from '../WorkingCopyBackup'
import { WorkingCopyService } from '../WorkingCopyService'

const resource = { scheme: 'file', id: 'document', data: { path: 'document.md', metadata: { tags: ['one'] } } }
function provider(): WorkingCopyProvider {
  return { read: async () => ({ text: 'disk', etag: 'a' }), save: async (_, document) => ({ status: 'saved', document: { ...document, etag: 'b' } }) }
}

describe('working copy ownership and save facts', () => {
  it('reports the written version while retaining newer dirty content and its backup', async () => {
    const write = deferred<Awaited<ReturnType<WorkingCopyProvider['save']>>>()
    const copies = new WorkingCopyService({ ...provider(), save: () => write.promise })
    const backups = new WorkingCopyBackup(copies, async () => {})
    const saved: WorkingCopyChange[] = []
    const dirty: boolean[] = []
    copies.onDidSave(event => saved.push(event))
    copies.onDidChangeDirty(event => dirty.push(event.copy.dirty))
    await copies.open(resource)
    copies.edit(resource, 'first')
    const accepted = copies.get(resource)!
    const saving = copies.save(resource)
    expect(copies.save(resource)).toBe(saving)
    copies.edit(resource, 'second')
    write.resolve({ status: 'saved', document: { text: 'first', etag: 'b' } })
    expect(await saving).toMatchObject({ status: 'saved', savedVersion: accepted.contentVersion, currentVersion: accepted.contentVersion + 1, dirtyAfter: true })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ savedVersion: accepted.contentVersion, copy: { text: 'second', baseText: 'first', dirty: true } })
    expect(backups.snapshot().backups).toMatchObject([{ text: 'second', baseText: 'first', etag: 'b' }])
    expect(dirty).toEqual([true])
    copies.discard(resource)
    expect(await copies.save(resource)).toMatchObject({ status: 'unchanged', dirtyAfter: false })
    expect(saved).toHaveLength(1)
    expect(dirty).toEqual([true, false])
    expect(backups.snapshot().backups).toEqual([])
    backups.dispose()
    await copies.dispose()
  })

  it('detaches registration, provider, query, event and backup objects from write authority', async () => {
    const input = structuredClone(resource)
    const conflict = { text: 'external', etag: 'c' }
    const copies = new WorkingCopyService({ ...provider(), save: async () => ({ status: 'conflict', document: conflict }) })
    const loaded = await copies.open(input)
    input.data.metadata.tags.push('outside')
    copies.edit(input, 'local')
    await copies.save(input)
    conflict.text = 'mutated later'
    const snapshot = copies.get(input)!
    expect(snapshot.conflict?.text).toBe('external')
    expect(snapshot.resource.data.metadata).toEqual({ tags: ['one'] })
    expect(Reflect.set(snapshot, 'text', 'bypassed')).toBe(false)
    expect(Reflect.set(snapshot.resource.data, 'path', 'other')).toBe(false)
    expect(() => (copies.copies as unknown as Map<string, unknown>).set(snapshot.key, { text: 'bypassed' })).toThrow()
    const backup = copies.backups()[0]!
    backup.text = 'bypassed'
    expect(copies.get(input)?.text).toBe('local')
    expect(loaded.text).toBe('disk')
    expect(snapshot.conflict?.text).toBe('external')
    await copies.dispose()
  })

  it('delivers immutable commits in order while queries observe newer reentrant edits', async () => {
    const failures: unknown[] = []
    const copies = new WorkingCopyService(provider(), error => failures.push(error))
    await copies.open(resource)
    const versions: Array<[number, string, string | undefined]> = []
    copies.onDidChangeContent((event) => {
      if (event.copy.text === 'first') {
        copies.edit(resource, 'second')
        throw new Error('isolated observer')
      }
    })
    copies.onDidChangeContent(event => versions.push([event.copy.contentVersion, event.copy.text, copies.get(resource)?.text]))
    const backups = new WorkingCopyBackup(copies, async () => {})
    copies.edit(resource, 'first')
    expect(versions).toEqual([[2, 'first', 'second'], [3, 'second', 'second']])
    expect(backups.snapshot().backups[0]?.text).toBe('second')
    expect(failures).toHaveLength(1)
    const revision = copies.revision
    copies.edit(resource, 'second')
    expect(copies.revision).toBe(revision)
    backups.dispose()
    await copies.dispose()
  })

  it('fences a released read from the replacement incarnation', async () => {
    const first = deferred<{ text: string, etag: string }>()
    const second = deferred<{ text: string, etag: string }>()
    let reads = 0
    const copies = new WorkingCopyService({ ...provider(), read: () => ++reads === 1 ? first.promise : second.promise })
    const old = copies.open(resource)
    const firstIdentity = copies.get(resource)!
    expect(copies.release(resource)).toBe(true)
    const reopened = copies.open(resource)
    expect(copies.get(resource)?.incarnation).not.toBe(firstIdentity.incarnation)
    second.resolve({ text: 'current', etag: 'new' })
    await reopened
    first.resolve({ text: 'stale', etag: 'old' })
    expect(await old).toMatchObject({ error: 'WORKING_COPY_RELEASED' })
    expect(copies.get(resource)).toMatchObject({ text: 'current', etag: 'new', loading: false })
    expect(copies.isCurrent(firstIdentity)).toBe(false)
    await copies.dispose()
  })

  it('does not replay older queued changes over a backup resync snapshot', async () => {
    const copies = new WorkingCopyService(provider())
    await copies.open(resource)
    let backups!: WorkingCopyBackup
    copies.onDidChangeContent((event) => {
      if (event.copy.text === 'first') {
        copies.edit(resource, 'second')
        backups.resync()
      }
    })
    backups = new WorkingCopyBackup(copies, async () => {})
    const projected: Array<string | undefined> = []
    backups.onDidChange(() => projected.push(backups.snapshot().backups[0]?.text))
    copies.edit(resource, 'first')
    expect(projected).toEqual(['second'])
    expect(backups.snapshot().backups[0]?.text).toBe('second')
    backups.dispose()
    await copies.dispose()
  })

  it('drains accepted saves before disposing observers and refuses new edits during stop', async () => {
    const write = deferred<Awaited<ReturnType<WorkingCopyProvider['save']>>>()
    const copies = new WorkingCopyService({ ...provider(), save: () => write.promise })
    const saved: WorkingCopyChange[] = []
    copies.onDidSave(event => saved.push(event))
    await copies.open(resource)
    copies.edit(resource, 'first')
    const saving = copies.save(resource)
    copies.edit(resource, 'newer')
    const disposing = copies.dispose()
    copies.edit(resource, 'too late')
    expect(await copies.save(resource)).toMatchObject({ status: 'unavailable', reason: 'disposed' })
    expect(copies.release(resource)).toBe(false)
    write.resolve({ status: 'saved', document: { text: 'first', etag: 'b' } })
    expect(await saving).toMatchObject({ status: 'saved', dirtyAfter: true })
    await disposing
    expect(saved).toHaveLength(1)
    expect(copies.backups()).toMatchObject([{ text: 'newer', baseText: 'first' }])
  })

  it('preserves recovery data when a restore collides with current edits or disk changes', async () => {
    const copies = new WorkingCopyService(provider())
    copies.restore([{ key: JSON.stringify(['file', 'document']), resource, text: 'recovered', baseText: 'previous disk', etag: 'previous', savedAt: '2026-01-01' }])
    await copies.open(resource)
    expect(copies.get(resource)).toMatchObject({ text: 'recovered', baseText: 'previous disk', conflict: { text: 'disk', etag: 'a' } })
    copies.edit(resource, 'edited recovery')
    copies.restore([{ ...copies.backups()[0]!, text: 'stale recovery' }])
    expect(copies.get(resource)?.text).toBe('edited recovery')
    copies.resolveConflict(resource, 'local')
    expect(copies.get(resource)).toMatchObject({ text: 'edited recovery', baseText: 'disk', etag: 'a', conflict: null })
    await copies.dispose()
  })

  it('classifies provider failures without publishing saved or exposing raw diagnostics', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    const copies = new WorkingCopyService({ ...provider(), save: async () => {
      throw new Error('private body and path')
    } })
    const saved: WorkingCopyChange[] = []
    copies.onDidSave(event => saved.push(event))
    copies.onDidStartSaving(() => {
      throw new Error('private observer content')
    })
    try {
      await copies.open(resource)
      copies.edit(resource, 'local')
      expect(await copies.save(resource)).toMatchObject({ status: 'failed', error: 'FILE_SAVE_FAILED', dirtyAfter: true })
      expect(saved).toEqual([])
      expect(output.mock.calls).toEqual([['WORKING_COPY_OBSERVER_FAILED']])
      expect(copies.get(resource)?.error).toBe('FILE_SAVE_FAILED')
    }
    finally {
      output.mockRestore()
      await copies.dispose()
    }
  })
})

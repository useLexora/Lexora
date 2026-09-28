import type { WorkbenchState, WorkbenchStateApi } from '@buddy-shared/workbench/workbenchState'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLayout } from '../../common/workbench'
import { ContributionRegistry } from '../ContributionRegistry'
import { WorkbenchController } from '../WorkbenchController'
import { WorkbenchPersistence } from '../WorkbenchPersistence'
import { WorkingCopyService } from '../WorkingCopyService'

const resource = { scheme: 'file', id: 'document', data: { path: 'document.md' } }
const disposals: Array<() => Promise<void>> = []
function setup(api: WorkbenchStateApi) {
  const registry = new ContributionRegistry()
  registry.register('files', scope => scope.view({ locations: ['context'], id: 'text', renderer: 'text', label: 'Text', supports: input => input.scheme === 'file', multiple: true }))
  const controller = new WorkbenchController(registry)
  const copies = new WorkingCopyService({ read: async () => ({ text: 'disk', etag: 'a' }), save: async (_, document) => ({ status: 'saved', document: { ...document, etag: 'b' } }) })
  const persistence = new WorkbenchPersistence(api, controller, copies, () => {})
  disposals.push(async () => {
    await copies.dispose()
    await persistence.dispose()
    controller.dispose()
    registry.dispose()
  })
  return { controller, copies, persistence }
}
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
  vi.useRealTimers()
})

describe('working copy backup watermarks', () => {
  it('acknowledges only the snapshot actually written while later edits remain pending', async () => {
    vi.useFakeTimers()
    const firstWrite = deferred<void>()
    const snapshots: WorkbenchState[] = []
    const { copies, persistence } = setup({ read: async () => null, write: async (state) => {
      snapshots.push(state)
      if (snapshots.length === 1)
        await firstWrite.promise
    } })
    await persistence.restore()
    await copies.open(resource)
    copies.edit(resource, 'first')
    const version = copies.get(resource)!
    const target = persistence.backups.revision
    const flushing = persistence.backups.flushThrough(target)
    await Promise.resolve()
    await Promise.resolve()
    copies.edit(resource, 'second')
    const nextTarget = persistence.backups.revision
    firstWrite.resolve()
    await flushing
    expect(persistence.backups.savedRevision).toBe(target)
    expect(persistence.backups.revision).toBe(nextTarget)
    expect(snapshots[0]?.backups).toMatchObject([{ text: 'first' }])
    expect(copies.isCurrent(version)).toBe(false)
    await persistence.backups.flushThrough(nextTarget)
    expect(snapshots.at(-1)?.backups).toMatchObject([{ text: 'second' }])
    expect(persistence.backups.savedRevision).toBe(nextTarget)
  })

  it('retains a failed backup revision for retry and never reports observation as durability', async () => {
    vi.useFakeTimers()
    let fail = true
    const { copies, persistence } = setup({ read: async () => null, write: async () => {
      if (fail)
        throw new Error('write failed')
    } })
    await persistence.restore()
    await copies.open(resource)
    copies.edit(resource, 'recoverable')
    const target = persistence.backups.revision
    await expect(persistence.backups.flushThrough(target)).rejects.toThrow('write failed')
    expect(persistence.backups.savedRevision).toBe(0)
    expect(persistence.backups.status.health).toBe('degraded')
    expect(persistence.backups.snapshot().backups[0]?.text).toBe('recoverable')
    fail = false
    await persistence.backups.flushThrough(target)
    expect(persistence.backups.status).toMatchObject({ savedRevision: target, health: 'ready' })
  })

  it('persists layout, raw configuration and content through one serialized writer', async () => {
    vi.useFakeTimers()
    const snapshots: WorkbenchState[] = []
    const { controller, copies, persistence } = setup({ read: async () => null, write: async (state) => {
      snapshots.push(state)
    } })
    controller.registry.register('settings', scope => scope.configuration({ id: 'wordWrap', defaultValue: false, validate: value => typeof value === 'boolean' }))
    await persistence.restore()
    await copies.open(resource)
    copies.edit(resource, 'local')
    await controller.open(resource, 'Document')
    controller.configuration.set('wordWrap', true)
    const target = persistence.capture()
    await Promise.all([persistence.flushThrough(target), persistence.backups.flushThrough(target.backupRevision)])
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ configuration: { wordWrap: true }, backups: [{ text: 'local' }] })
    expect(persistence.savedRevision).toEqual(target)
    const writes = snapshots.length
    copies.edit(resource, 'local')
    await persistence.flush()
    expect(snapshots).toHaveLength(writes)
  })

  it('keeps layout-independent recovery through restore and write without changing its disk baseline', async () => {
    vi.useFakeTimers()
    const state: WorkbenchState = { version: 1, layout: createLayout() as never, configuration: {}, backups: [{ key: JSON.stringify(['file', 'document']), resource, text: 'unsaved', baseText: 'previous', etag: 'old', savedAt: '2026-01-01' }] }
    const snapshots: WorkbenchState[] = []
    const { copies, persistence } = setup({ read: async () => state, write: async (value) => {
      snapshots.push(value)
    } })
    await persistence.restore(async (layout) => {
      layout.auxiliary.prepared = true
    })
    state.backups[0]!.text = 'caller mutation'
    await copies.open(resource)
    await persistence.flush()
    expect(snapshots.at(-1)?.backups).toMatchObject([{ text: 'unsaved', baseText: 'previous', etag: 'old' }])
    expect(copies.get(resource)?.conflict).toEqual({ text: 'disk', etag: 'a' })
  })

  it('does not complete a delayed restore after disposal or silently accept an unready flush', async () => {
    const read = deferred<WorkbenchState | null>()
    const { copies, persistence } = setup({ read: () => read.promise, write: async () => {} })
    await expect(persistence.flush()).rejects.toThrow('WORKBENCH_PERSISTENCE_NOT_READY')
    const restoring = persistence.restore()
    await persistence.dispose()
    read.resolve({ version: 1, layout: createLayout() as never, configuration: {}, backups: [] })
    await expect(restoring).rejects.toThrow('WORKBENCH_PERSISTENCE_DISPOSED')
    expect(persistence.ready).toBe(false)
    expect(copies.copies.size).toBe(0)
  })
})

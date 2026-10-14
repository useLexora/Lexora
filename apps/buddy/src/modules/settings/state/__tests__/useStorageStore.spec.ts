import type { StorageSummary } from '@buddy-shared/storage/storageApi'
import { deferred } from '@buddy-tests/deferred'
import { expect, it, vi } from 'vitest'
import { useStorageStore } from '../useStorageStore'
import { useStorageUsageStore } from '../useStorageUsageStore'

const current: StorageSummary = { root: '/fixture', defaultRoot: '/fixture', identity: { version: 1, layoutVersion: 1, dataId: 'fixture', generation: 'fixture' }, pending: null, history: [] }

it('does not let an older read put a cancelled operation back into shared settings state', async () => {
  const old = deferred<StorageSummary>()
  const store = useStorageStore({
    summary: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(current),
    snapshots: async () => ({ snapshots: [], unreadableIds: [] }),
    onProgress: () => () => {},
  }, { onChanged: () => () => {} }, useStorageUsageStore({ usage: async () => ({ scannedAt: 'fixture', categories: [], missing: 0 }) }))
  const loading = store.ensureLoaded()
  const cancellation = deferred<void>()
  const operation = store.run(() => cancellation.promise)
  expect(store.busy.value).toBe(true)
  cancellation.resolve()
  await operation
  expect(store.summary.value?.pending).toBeNull()
  expect(store.busy.value).toBe(false)
  old.resolve({ ...current, pending: { id: 'old', kind: 'relocate', phase: 'pending', source: '/fixture', target: '/elsewhere', createdAt: 'fixture', error: null } })
  await loading
  expect(store.summary.value?.pending).toBeNull()
  store.dispose()
})

it('keeps the overview usable when the backup directory cannot be read and retries on reopening', async () => {
  const catalog = { snapshots: [], unreadableIds: ['damaged-backup'] }
  const store = useStorageStore({
    summary: async () => current,
    snapshots: vi.fn().mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue(catalog),
    onProgress: () => () => {},
  }, { onChanged: () => () => {} }, useStorageUsageStore({ usage: async () => ({ scannedAt: 'fixture', categories: [], missing: 0 }) }))
  await expect(store.ensureLoaded()).rejects.toThrow('EACCES')
  expect(store.summary.value).toEqual(current)
  expect(store.loading.value).toBe(false)
  await store.ensureLoaded()
  expect(store.catalog.value).toEqual(catalog)
  store.dispose()
})

it('shows a persisted restore request even when the subsequent restart fails', async () => {
  const requested: StorageSummary = { ...current, pending: { id: 'restore', kind: 'restore', phase: 'pending', source: current.root, target: current.root, createdAt: 'fixture', error: null } }
  const store = useStorageStore({
    summary: vi.fn().mockResolvedValueOnce(current).mockResolvedValue(requested),
    snapshots: async () => ({ snapshots: [], unreadableIds: [] }),
    onProgress: () => () => {},
  }, { onChanged: () => () => {} }, useStorageUsageStore({ usage: async () => ({ scannedAt: 'fixture', categories: [], missing: 0 }) }))
  await store.ensureLoaded()
  await expect(store.run(async () => {
    throw new Error('restart failed')
  })).rejects.toThrow('restart failed')
  expect(store.summary.value?.pending).toEqual(requested.pending)
  expect(store.busy.value).toBe(false)
  store.dispose()
})

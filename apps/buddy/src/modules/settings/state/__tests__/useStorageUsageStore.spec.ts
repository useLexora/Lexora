import type { StorageUsage } from '@buddy-shared/storage/storageApi'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useStorageUsageStore } from '../useStorageUsageStore'

function usage(bytes: number): StorageUsage {
  return { scannedAt: '2026-10-14T00:00:00.000Z', categories: [{ id: 'data', bytes, files: 1, details: [{ id: 'database', bytes, files: 1 }] }], missing: 0 }
}

describe('storage usage session cache', () => {
  it('loads on demand, shares an in-flight scan, and keeps the result when the page leaves', async () => {
    const scan = deferred<StorageUsage>()
    const read = vi.fn(() => scan.promise)
    const store = useStorageUsageStore({ usage: read })
    expect(read).not.toHaveBeenCalled()
    const page = effectScope()
    const first = page.run(() => store.refresh({ background: true }))
    expect(store.loading.value).toBe(true)
    const second = store.ensureLoaded()
    expect(read).toHaveBeenCalledTimes(1)
    page.stop()
    scan.resolve(usage(1024))
    await Promise.all([first, second])
    expect(store.usage.value).toEqual(usage(1024))
    expect(store.loading.value).toBe(false)
    await store.ensureLoaded()
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.usage.value).toEqual(usage(1024))
  })

  it('keeps the last result during a failed refresh and replaces it on retry', async () => {
    const refresh = deferred<StorageUsage>()
    const read = vi.fn().mockResolvedValueOnce(usage(1024)).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(usage(2048))
    const store = useStorageUsageStore({ usage: read })
    await store.ensureLoaded()
    const pending = store.refresh()
    expect(store.loading.value).toBe(true)
    expect(store.usage.value).toEqual(usage(1024))
    refresh.reject(new Error('read failed'))
    await pending
    expect(store.failed.value).toBe(true)
    expect(store.usage.value).toEqual(usage(1024))
    await store.refresh()
    expect(store.failed.value).toBe(false)
    expect(store.usage.value).toEqual(usage(2048))
  })

  it('can retry an initial failure without starting an automatic retry loop', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(usage(0))
    const store = useStorageUsageStore({ usage: read })
    await store.ensureLoaded()
    expect(store.usage.value).toBeNull()
    expect(store.failed.value).toBe(true)
    expect(store.loading.value).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
    await store.ensureLoaded()
    expect(store.usage.value).toEqual(usage(0))
    expect(store.failed.value).toBe(false)
  })

  it('updates cached usage silently after backup operations and shows loading for a manual refresh', async () => {
    const background = deferred<StorageUsage>()
    const manual = deferred<StorageUsage>()
    const read = vi.fn().mockResolvedValueOnce(usage(1024)).mockReturnValueOnce(background.promise).mockReturnValueOnce(manual.promise)
    const store = useStorageUsageStore({ usage: read })
    await store.ensureLoaded()
    const update = store.refresh({ background: true })
    expect(store.loading.value).toBe(false)
    expect(store.usage.value).toEqual(usage(1024))
    await store.ensureLoaded()
    expect(store.loading.value).toBe(false)
    background.resolve(usage(2048))
    await update
    expect(store.usage.value).toEqual(usage(2048))
    const backgroundRefresh = store.refresh({ background: true })
    expect(store.loading.value).toBe(false)
    const refresh = store.refresh()
    expect(read).toHaveBeenCalledTimes(3)
    expect(store.loading.value).toBe(true)
    manual.resolve(usage(4096))
    await Promise.all([backgroundRefresh, refresh])
    expect(store.loading.value).toBe(false)
    expect(store.usage.value).toEqual(usage(4096))
  })
})

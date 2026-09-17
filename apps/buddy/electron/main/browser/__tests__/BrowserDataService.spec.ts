import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserDataService } from '../BrowserDataService'
import { BROWSER_DEFAULT_PARTITION } from '../BrowserHost'
import { BrowserOperationGuard } from '../BrowserOperationGuard'
import { createFixture } from './browserHostFixture'

const { fromPartition } = vi.hoisted(() => ({ fromPartition: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition } }))

function createPartition(domains: string[] = ['.example.com'], bytes = 100) {
  const data = { domains, cache: bytes, cacheStorage: true, authenticated: true }
  return {
    data,
    getCacheSize: async () => data.cache,
    cookies: { get: async () => data.domains.map(domain => ({ domain })) },
    clearData: async () => {
      data.domains = []
    },
    clearAuthCache: async () => {
      data.authenticated = false
    },
    clearCache: async () => {
      data.cache = 0
    },
    clearStorageData: async () => {
      data.cacheStorage = false
    },
  }
}

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function setup() {
  const operations = new BrowserOperationGuard()
  const fixture = createFixture({ operations })
  const partitions = new Map<string, ReturnType<typeof createPartition>>()
  fromPartition.mockImplementation((name: string) => {
    const existing = partitions.get(name)
    if (existing)
      return existing
    const partition = createPartition()
    partitions.set(name, partition)
    return partition
  })
  cleanups.push(() => fixture.host.dispose())
  return { ...fixture, partitions, service: new BrowserDataService(() => fixture.host, operations) }
}

describe('browser data ownership', () => {
  it('counts shared partitions once and clears only the selected browser data', async () => {
    const { host, partitions, service } = setup()
    host.ensureSession(null, 'first')
    host.ensureSession(null, 'second')
    const third = host.ensureSession(null, 'third')
    const incognito = await host.setProfileMode(third.sessionId, 'incognito')
    const saved = createPartition(['.example.com', 'example.com'], 100)
    const privateData = createPartition(['example.com', '.private.example'], 200)
    const desktop = createPartition(['desktop.example'], 50)
    partitions.set(BROWSER_DEFAULT_PARTITION, saved)
    partitions.set(host.getGuestDescriptor(incognito.sessionId).partition, privateData)
    partitions.set('desktop', desktop)

    expect(await service.getSummary()).toEqual({ cacheBytes: 300, cookieSiteCount: 2 })
    expect(await service.clear({ siteData: false, cache: true })).toEqual({ ok: true })
    expect(await service.getSummary()).toEqual({ cacheBytes: 0, cookieSiteCount: 2 })
    expect(saved.data).toMatchObject({ authenticated: true, cacheStorage: false })
    expect(privateData.data).toMatchObject({ authenticated: true, cacheStorage: false })

    saved.data.cache = 80
    expect(await service.clear({ siteData: true, cache: false })).toEqual({ ok: true })
    expect(await service.getSummary()).toEqual({ cacheBytes: 80, cookieSiteCount: 0 })
    expect(saved.data.authenticated).toBe(false)
    expect(privateData.data.authenticated).toBe(false)
    expect(desktop.data).toEqual({ domains: ['desktop.example'], cache: 50, cacheStorage: true, authenticated: true })
  })

  it('rejects clearing while an agent owns a page and allows clearing after release', async () => {
    const { host, service } = setup()
    const state = host.ensureSession('conversation')
    const lease = host.acquireControl({ sessionId: state.sessionId, pageId: state.pageId })
    expect(await service.clear({ siteData: true, cache: true })).toEqual({ ok: false, code: 'BROWSER_IN_USE' })
    expect(await service.getSummary()).toEqual({ cacheBytes: 100, cookieSiteCount: 1 })
    host.releaseControl(lease)
    expect(await service.clear({ siteData: true, cache: true })).toEqual({ ok: true })
    expect(await service.getSummary()).toEqual({ cacheBytes: 0, cookieSiteCount: 0 })
  })

  it('waits for every partition after a failure and releases maintenance for retry', async () => {
    const { host, partitions, service } = setup()
    const initial = host.ensureSession(null, 'private')
    const incognito = await host.setProfileMode(initial.sessionId, 'incognito')
    const saved = createPartition()
    const privateData = createPartition()
    const pending = deferred<void>()
    const originalClear = saved.clearCache
    saved.clearCache = () => {
      throw new Error('cache unavailable')
    }
    privateData.clearCache = async () => {
      await pending.promise
      privateData.data.cache = 0
    }
    partitions.set(BROWSER_DEFAULT_PARTITION, saved)
    partitions.set(host.getGuestDescriptor(incognito.sessionId).partition, privateData)

    let finished = false
    const clearing = service.clear({ siteData: false, cache: true }).then((result) => {
      finished = true
      return result
    })
    expect(await service.clear({ siteData: true, cache: true })).toEqual({ ok: false, code: 'BROWSER_IN_USE' })
    expect(finished).toBe(false)
    expect(() => host.ensureSession(null, 'during-clear')).toThrowError(expect.objectContaining({ code: 'BROWSER_IN_USE' }))
    expect(host.getState(incognito.sessionId).profileMode).toBe('incognito')
    pending.resolve()
    expect(await clearing).toEqual({ ok: false, code: 'BROWSER_CLEAR_FAILED' })
    expect(privateData.data).toMatchObject({ cache: 0, cacheStorage: false, domains: ['.example.com'] })
    expect(saved.data).toMatchObject({ cache: 100, cacheStorage: false })

    saved.clearCache = originalClear
    expect(host.ensureSession(null, 'after-clear').status).toBe('idle')
    expect(await service.clear({ siteData: false, cache: true })).toEqual({ ok: true })
    expect(await service.getSummary()).toEqual({ cacheBytes: 0, cookieSiteCount: 1 })
  })
})

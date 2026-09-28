import type { DesktopNetworkChange } from '../DesktopNetwork'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopNetwork } from '../DesktopNetwork'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  resolver: { setProxy: vi.fn(async () => {}), resolveProxy: vi.fn(async () => 'DIRECT'), closeAllConnections: vi.fn(async () => {}) },
  defaultSession: { setProxy: vi.fn(async () => {}) },
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  app: {
    on: (event: string, handler: (...args: unknown[]) => void) => mocks.handlers.set(event, handler),
    off: (event: string) => mocks.handlers.delete(event),
    setProxy: vi.fn(async () => {}),
  },
  session: { fromPartition: () => mocks.resolver, defaultSession: mocks.defaultSession },
}))
vi.mock('../OutboundProxy', () => ({
  OutboundProxy: class {
    url = 'http://fixture.invalid'
    sandboxUrl = this.url
    address = this.url
    start = mocks.start
    stop = mocks.stop
    disconnect() {}
  },
  toElectronProxyConfig: (value: unknown) => value,
}))
afterEach(() => {
  vi.clearAllMocks()

  mocks.handlers.clear()
})

describe('desktop network state ownership', () => {
  it('reports degraded startup without exposing the upstream error message', async () => {
    mocks.start.mockRejectedValueOnce(new Error('private-upstream-token'))
    const network = new DesktopNetwork()
    const facts: DesktopNetworkChange[] = []
    network.onDidChange(change => facts.push(change))
    await network.start({ mode: 'system', server: '' })
    expect(network.snapshot).toMatchObject({ status: 'degraded' })
    expect(facts.at(-1)).toMatchObject({ kind: 'lifecycle', status: 'degraded' })
    expect(JSON.stringify(facts)).not.toContain('private-upstream-token')
    await network.stop()
    expect(facts.at(-1)).toMatchObject({ status: 'stopped' })
  })

  it('recovers a failed new-session configuration through explicit reconciliation', async () => {
    const network = new DesktopNetwork()
    const facts: DesktopNetworkChange[] = []
    network.onDidChange(change => facts.push(change))
    await network.start({ mode: 'system', server: '' })
    const created = { setProxy: vi.fn().mockRejectedValueOnce(new Error('private-proxy-error')).mockResolvedValue(undefined) }
    mocks.handlers.get('session-created')!(created)
    await vi.waitFor(() => expect(network.snapshot.failedSessions).toBe(1))
    expect(network.snapshot).toMatchObject({ status: 'degraded', pendingSessions: 0 })
    await network.reconcileSessions()
    expect(network.snapshot).toMatchObject({ status: 'ready', failedSessions: 0, pendingSessions: 0 })
    expect(facts.filter(change => change.kind === 'session').map(change => change.status)).toEqual(['failed', 'applied'])
    await network.stop()
  })

  it('retains a failed-stop snapshot when the proxy close rejects', async () => {
    const network = new DesktopNetwork()
    await network.start({ mode: 'direct', server: '' })
    mocks.stop.mockRejectedValueOnce(new Error('close failed'))
    await expect(network.stop()).rejects.toThrow('NETWORK_STOP_FAILED')
    expect(network.snapshot.status).toBe('stop-failed')
    expect(mocks.resolver.closeAllConnections).toHaveBeenCalledOnce()
  })
})

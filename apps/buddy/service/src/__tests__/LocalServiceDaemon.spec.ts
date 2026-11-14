import type { RuntimeRequestHandler } from '../../../shared/runtime/rpcPeer'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceRpcChannel } from '../../../platform/service/ServiceRpcChannel'
import { Emitter } from '../../../shared/events/Emitter'
import { startLocalServiceDaemon } from '../LocalServiceDaemon'

const fixture = vi.hoisted(() => ({
  servers: [] as any[],
  children: [] as any[],
  phases: [] as string[],
  failures: new Set<number>(),
  cleanupFailures: new Set<number>(),
  unready: new Set<number>(),
  ownerReleased: false,
  disposed: false,
  suspended: 0,
  resumed: 0,
  resume: undefined as (() => Promise<void>) | undefined,
}))

class Frames {
  readonly messages = new Emitter<unknown>(() => {})
  readonly closes = new Emitter<Error>(() => {})
  readonly onDidClose = this.closes.event
  opposite!: Frames
  closed = false
  transport() {
    return {
      postMessage: (message: unknown) => this.opposite.messages.fire(message),
      subscribe: (listener: (message: unknown) => void) => this.messages.event(listener).dispose,
    }
  }

  close(error: Error) {
    if (this.closed)
      return
    this.closed = true
    this.closes.fire(error)
    this.opposite.close(error)
  }
}

vi.mock('../../../platform/ipc/localTransport', () => ({ localTransports: new Proxy({}, { get: () => (address: string) => ({ address }) }) }))
vi.mock('../../../platform/native/nativeHost', () => ({ createBuddyNativeEnvironment: () => ({}), resolveBuddyProcessControl: () => '/fixture/helper' }))
vi.mock('../../../platform/service/serviceFiles', () => ({ readServiceLaunch: async () => ({ profileRoot: '/fixture/profile', resourcesRoot: '/fixture/resources', hostExecutable: '/fixture/host', hostArguments: [], profile: 'test', storageAuthority: 'sqlite' }) }))
vi.mock('../validateServiceRelease', () => ({ validateServiceRelease: async () => {} }))
vi.mock('../platform/createRpcRuntimePlatform', () => ({ createRpcRuntimePlatform: () => ({}) }))
vi.mock('../platform/nodeServiceConfig', () => ({ prepareNodeService: async () => [] }))
vi.mock('../startServiceRuntime', () => ({ startServiceRuntime: async () => ({
  startMaintenance() {},
  async dispose() { fixture.disposed = true },
  async suspendPlatform() { fixture.suspended++ },
  async resumePlatform() {
    fixture.resumed++
    await fixture.resume?.()
  },
}) }))
vi.mock('../../../platform/service/ServiceProfileOwner', () => ({ ServiceProfileOwner: { acquire: async () => ({
  discovery: { protocol: 1, profileId: 'profile', serviceInstanceId: '09f1e2ae-4b53-4730-b4e9-160bd5b14da3', buildId: 'a'.repeat(64), sessionId: 'session', userId: 'user', managementEndpoint: '/fixture/management.sock', productEndpoint: '/fixture/product.sock', phase: 'starting' },
  managementSecret: 'b'.repeat(64),
  productSecret: 'c'.repeat(64),
  async publish(phase: string) {
    this.discovery.phase = phase
    fixture.phases.push(phase)
  },
  async dispose() { fixture.ownerReleased = true },
}) } }))
vi.mock('../../../platform/service/LocalServiceServer', () => ({ LocalServiceServer: class {
  disposed = false
  readonly options: any
  constructor(options: any) {
    this.options = options
    fixture.servers.push(this)
  }

  async listen() {}
  async dispose() { this.disposed = true }
} }))
vi.mock('../../../platform/service/ServiceChildProcess', () => ({ ServiceChildProcess: class {
  readonly ordinal = fixture.children.length
  readonly exited: Promise<{ code: number, signal: null }>
  exit!: () => void
  peer?: ServiceRpcChannel
  clean = false
  constructor() {
    fixture.children.push(this)
    this.exited = new Promise(resolve => this.exit = () => resolve({ code: 1, signal: null }))
  }

  async ready(bootstrap: any) {
    if (fixture.unready.has(this.ordinal))
      return
    if (fixture.failures.has(this.ordinal))
      throw new Error('PLATFORM_HOST_START_FAILED')
    const service = new Frames()
    const client = new Frames()
    service.opposite = client
    client.opposite = service
    this.peer = new ServiceRpcChannel(client as never)
    fixture.servers.find(server => server.options.endpoint.address === bootstrap.endpoint).options.connected(service)
    this.peer.onRequest('host.stop', (() => ({ accepted: true })) satisfies RuntimeRequestHandler)
    await this.peer.request('host.ready', { hostInstanceId: bootstrap.hostInstanceId, preferences: { cacheWarming: 'off', codemode: 'off', codemodeWorkerLimit: 2, codemodeOverflow: 'wait', modelRetryLimit: 2 }, display: true, proxy: { httpProxy: 'http://127.0.0.1:10000', httpsProxy: 'http://127.0.0.1:10000', noProxy: '' } })
  }

  async stopAndVerify() {
    if (fixture.cleanupFailures.has(this.ordinal))
      throw new Error('SERVICE_CHILD_CLEANUP_UNCONFIRMED')
    this.clean = true
    this.exit()
    this.peer?.close(new Error('HOST_STOPPED'))
  }
} }))

let daemon: Awaited<ReturnType<typeof startLocalServiceDaemon>> | undefined
let exitCode: typeof process.exitCode
let environment: NodeJS.ProcessEnv
beforeEach(() => {
  exitCode = process.exitCode
  environment = { ...process.env }
  Object.assign(fixture, { servers: [], children: [], phases: [], failures: new Set(), cleanupFailures: new Set(), unready: new Set(), ownerReleased: false, disposed: false, suspended: 0, resumed: 0, resume: undefined })
})
afterEach(async () => {
  await daemon?.stop().catch(() => {})
  daemon = undefined
  process.exitCode = exitCode
  process.env = environment
})

const readyAgain = () => expect.poll(() => fixture.phases).toEqual(['ready', 'recovering', 'ready'])

describe('local service host recovery', () => {
  it.each(['process', 'socket'])('recovers exactly once when %s loss arrives first', async (first) => {
    daemon = await startLocalServiceDaemon('/fixture/launch.json')
    const original = fixture.children[0]
    if (first === 'process')
      original.exit()
    else
      original.peer.close(new Error('CONNECTION_LOST'))
    await readyAgain()
    expect(fixture.children).toHaveLength(2)
    expect(fixture.suspended).toBe(1)
    expect(fixture.resumed).toBe(1)
    expect(original.clean).toBe(true)
    expect(fixture.ownerReleased).toBe(false)
    expect(process.exitCode).toBe(exitCode)
    original.exit()
    await Promise.resolve()
    expect(fixture.children).toHaveLength(2)
  })

  it('retries a replacement only after its cleanup is confirmed', async () => {
    fixture.failures.add(1)
    daemon = await startLocalServiceDaemon('/fixture/launch.json')
    fixture.children[0].exit()
    await readyAgain()
    expect(fixture.children).toHaveLength(3)
    expect(fixture.children.slice(0, 2).every(child => child.clean)).toBe(true)
    expect(fixture.resumed).toBe(1)
    expect(fixture.disposed).toBe(false)
  })

  it('releases the profile and fails the process after three unsuccessful replacements', async () => {
    fixture.failures = new Set([1, 2, 3])
    daemon = await startLocalServiceDaemon('/fixture/launch.json')
    fixture.children[0].exit()
    await expect.poll(() => process.exitCode).toBe(1)
    expect(fixture.children).toHaveLength(4)
    expect(fixture.children.every(child => child.clean)).toBe(true)
    expect(fixture.servers.every(server => server.disposed)).toBe(true)
    expect(fixture.disposed).toBe(true)
    expect(fixture.ownerReleased).toBe(true)
    expect(fixture.phases).toEqual(['ready', 'recovering', 'stopping'])
  })

  it('retains the lease and stops replacement attempts when cleanup is unconfirmed', async () => {
    fixture.failures.add(1)
    fixture.cleanupFailures.add(1)
    daemon = await startLocalServiceDaemon('/fixture/launch.json')
    fixture.children[0].exit()
    await expect.poll(() => fixture.phases.at(-1)).toBe('failed')
    await expect(daemon.stop()).rejects.toThrow('SERVICE_STOP_UNCONFIRMED')
    expect(fixture.children).toHaveLength(2)
    expect(fixture.ownerReleased).toBe(false)
    expect(process.exitCode).toBe(exitCode)
  })

  it('does not publish ready when a replacement disconnects while the runtime resumes', async () => {
    fixture.resume = async () => {
      fixture.children.at(-1).peer.close(new Error('CONNECTION_LOST'))
    }
    daemon = await startLocalServiceDaemon('/fixture/launch.json')
    fixture.children[0].exit()
    await expect.poll(() => process.exitCode).toBe(1)
    expect(fixture.phases).toEqual(['ready', 'recovering', 'stopping'])
    expect(fixture.ownerReleased).toBe(true)
  })

  it('cancels a replacement readiness wait before awaiting recovery during shutdown', async () => {
    fixture.unready.add(1)
    daemon = await startLocalServiceDaemon('/fixture/launch.json')
    fixture.children[0].exit()
    await expect.poll(() => fixture.children.length).toBe(2)
    await daemon.stop()
    expect(fixture.children.every(child => child.clean)).toBe(true)
    expect(fixture.servers.every(server => server.disposed)).toBe(true)
    expect(fixture.ownerReleased).toBe(true)
    expect(fixture.phases).toEqual(['ready', 'recovering', 'stopping'])
    expect(fixture.resumed).toBe(0)
    expect(process.exitCode).toBe(exitCode)
  }, 2000)

  it('keeps the lease when a cancelled replacement cannot confirm child cleanup', async () => {
    fixture.unready.add(1)
    fixture.cleanupFailures.add(1)
    daemon = await startLocalServiceDaemon('/fixture/launch.json')
    fixture.children[0].exit()
    await expect.poll(() => fixture.children.length).toBe(2)
    await expect(daemon.stop()).rejects.toThrow('SERVICE_STOP_UNCONFIRMED')
    expect(fixture.ownerReleased).toBe(false)
    expect(fixture.children).toHaveLength(2)
  }, 2000)

  it('does not launch a replacement after shutdown starts during recovery', async () => {
    daemon = await startLocalServiceDaemon('/fixture/launch.json')
    fixture.children[0].exit()
    await Promise.resolve()
    await daemon.stop()
    expect(fixture.children).toHaveLength(1)
    expect(fixture.ownerReleased).toBe(true)
    expect(process.exitCode).toBe(exitCode)
  })
})

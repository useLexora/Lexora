import type { RuntimeRequestHandler } from '../../../shared/runtime/rpcPeer'
import type { ServiceLaunch } from '../../../shared/service/localServiceProtocol'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceRpcChannel } from '../../../platform/service/ServiceRpcChannel'
import { ServiceFrameError } from '../../../platform/service/SocketFrames'
import { Emitter } from '../../../shared/events/Emitter'
import { startLocalServiceDaemon } from '../LocalServiceDaemon'

const fixture = vi.hoisted(() => ({
  servers: [] as any[],
  children: [] as any[],
  accesses: [] as string[],
  accessGate: undefined as Promise<void> | undefined,
  holdReady: false,
  windowsShell: false,
  hostShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' as string | undefined,
  phases: [] as string[],
  failures: new Set<number>(),
  cleanupFailures: new Set<number>(),
  cleanup: undefined as Promise<void> | undefined,
  disposeFailure: false,
  unready: new Set<number>(),
  ownerReleased: false,
  disposed: false,
  suspended: 0,
  resumed: 0,
  resume: undefined as (() => Promise<void>) | undefined,
  initializing: false,
  initialize: undefined as Promise<void> | undefined,
  openDesktop: undefined as RuntimeRequestHandler | undefined,
}))

class Frames {
  readonly messages = new Emitter<unknown>(() => {})
  readonly closes = new Emitter<Error>(() => {})
  readonly onDidClose = this.closes.event
  opposite!: Frames
  closed = false
  readonly activity = { pendingWriteBytes: 0, pendingBinaryBytes: 0 }
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
vi.mock('../platform/createRpcRuntimePlatform', () => ({ createRpcRuntimePlatform: () => ({}) }))
vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(),
  access: async (file: string) => {
    fixture.accesses.push(file)
    await fixture.accessGate
  },
}))
vi.mock('../../../platform/currentPlatform', async (original) => {
  const { currentPlatform } = await original<typeof import('../../../platform/currentPlatform')>()
  return { currentPlatform: {
    ...currentPlatform,
    get shell() { return fixture.windowsShell ? 'powershell' : currentPlatform.shell },
  } }
})
vi.mock('../../../platform/windows/powerShell', () => ({
  resolveWindowsPowerShell: async () => { throw new Error('UNEXPECTED_SECOND_CORE_PROBE') },
}))
vi.mock('../../../platform/windows/runtimeGuard', () => ({ establishWindowsRuntimeGuard: async () => {} }))
vi.mock('../startServiceRuntime', () => ({ startServiceRuntime: async () => {
  fixture.initializing = true
  await fixture.initialize
  return {
    startMaintenance() {},
    async dispose() {
      if (fixture.disposeFailure)
        throw new Error('RUNTIME_DISPOSE_FAILED')
      fixture.disposed = true
    },
    async suspendPlatform() { fixture.suspended++ },
    async resumePlatform() {
      fixture.resumed++
      await fixture.resume?.()
    },
  }
} }))
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
  readonly child = { pid: 9000 + this.ordinal }
  readonly exited: Promise<{ code: number, signal: null }>
  exit!: () => void
  peer?: ServiceRpcChannel
  clean = false
  readyHost!: (id?: string) => Promise<unknown>
  readonly env: NodeJS.ProcessEnv
  constructor(options: { env: NodeJS.ProcessEnv }) {
    this.env = options.env
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
    this.peer.onRequest('host.openDesktop', (input, signal) => fixture.openDesktop?.(input, signal) ?? { visible: true })
    this.readyHost = (id = bootstrap.hostInstanceId) => this.peer!.request('host.ready', { hostInstanceId: id, windowsPowerShell: fixture.hostShell, preferences: { cacheWarming: 'off', codemode: 'off', codemodeWorkerLimit: 2, codemodeOverflow: 'wait', modelRetryLimit: 2 }, display: true, proxy: { httpProxy: 'http://127.0.0.1:10000', httpsProxy: 'http://127.0.0.1:10000', noProxy: '' } })
    if (!fixture.holdReady)
      await this.readyHost()
  }

  async stopAndVerify() {
    await fixture.cleanup
    if (fixture.cleanupFailures.has(this.ordinal))
      throw new Error('SERVICE_CHILD_CLEANUP_UNCONFIRMED')
    this.clean = true
    this.exit()
    this.peer?.close(new Error('HOST_STOPPED'))
  }
} }))

const config: ServiceLaunch = {
  version: 1,
  profile: 'test',
  profileRoot: '/fixture/profile',
  resourcesRoot: resolve('/fixture/resources'),
  nodeExecutable: '/fixture/node',
  coreEntry: '/fixture/service.mjs',
  hostExecutable: '/fixture/host',
  hostArguments: [],
  releaseSetPath: '/fixture/release-set.json',
  buildId: 'a'.repeat(64),
  sessionId: 'session',
  userId: 'user',
  storageAuthority: 'sqlite',
}

let daemon: Awaited<ReturnType<typeof startLocalServiceDaemon>> | undefined
let exitCode: typeof process.exitCode
let environment: NodeJS.ProcessEnv
beforeEach(() => {
  exitCode = process.exitCode
  environment = { ...process.env }
  Object.assign(fixture, { accesses: [], accessGate: undefined, holdReady: false, windowsShell: false, hostShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', servers: [], children: [], phases: [], failures: new Set(), cleanupFailures: new Set(), cleanup: undefined, disposeFailure: false, unready: new Set(), ownerReleased: false, disposed: false, suspended: 0, resumed: 0, resume: undefined, initializing: false, initialize: undefined, openDesktop: undefined })
})
afterEach(async () => {
  await daemon?.stop().catch(() => {})
  daemon = undefined
  process.exitCode = exitCode
  process.env = environment
  vi.restoreAllMocks()
})

const readyAgain = () => expect.poll(() => fixture.phases).toEqual(['starting', 'ready', 'recovering', 'ready'])

it('inspects only installation resources during Host authentication, then binds that Host shell before admission', async () => {
  fixture.holdReady = true
  fixture.windowsShell = true
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubEnv('LEXORA_BUDDY_HOME', 'original-home')
  vi.stubEnv('OPENAI_API_KEY', 'fixture-only')
  vi.stubEnv('PI_POWERSHELL_PATH', 'untrusted')
  const shutdown = new AbortController()
  const starting = startLocalServiceDaemon(config, { signal: shutdown.signal })
  void starting.catch(() => {})
  try {
    await expect.poll(() => log.mock.calls.some(([line]) => JSON.parse(String(line)).component === 'runtime.node_resources')).toBe(true)
    const child = fixture.children[0]
    expect(fixture.accesses.length).toBeGreaterThan(0)
    expect(fixture.accesses.every(file => file.startsWith(join(config.resourcesRoot, '/')))).toBe(true)
    expect(child.env).toMatchObject({ LEXORA_BUDDY_HOME: 'original-home', PI_POWERSHELL_PATH: 'untrusted' })
    expect(process.env).toMatchObject({ LEXORA_BUDDY_HOME: 'original-home', OPENAI_API_KEY: 'fixture-only', PI_POWERSHELL_PATH: 'untrusted' })
    expect(fixture.initializing).toBe(false)
    await expect(child.readyHost('09f1e2ae-4b53-4730-b4e9-160bd5b14da3')).rejects.toThrow()
    expect(process.env.PI_POWERSHELL_PATH).toBe('untrusted')
    await child.readyHost()
    daemon = await starting
    expect(process.env.LEXORA_BUDDY_HOME).toBe(join(config.profileRoot, 'buddy'))
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.PI_POWERSHELL_PATH).toBe(fixture.hostShell)
    expect(fixture.phases).toEqual(['starting', 'ready'])
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line)))
    const steps = records.filter(record => record.event === 'startup.step.completed').map(record => record.component)
    expect(steps.indexOf('runtime.node_resources')).toBeLessThan(steps.indexOf('runtime.host_handshake'))
    expect(steps.indexOf('runtime.host_handshake')).toBeLessThan(steps.indexOf('runtime.node_environment'))
  }
  finally {
    shutdown.abort()
    await starting.catch(() => {})
  }
})

it.each([undefined, 'pwsh.exe', 'C:\\arbitrary.exe', '\\\\.\\C:\\pwsh.exe'])('does not admit a Windows generation with an invalid shell pin (%#)', async (path) => {
  fixture.windowsShell = true
  fixture.hostShell = path
  vi.stubEnv('PI_POWERSHELL_PATH', 'untrusted')
  await expect(startLocalServiceDaemon(config)).rejects.toThrow('PLATFORM_HOST_SHELL_INVALID')
  expect(process.env.PI_POWERSHELL_PATH).toBe('untrusted')
  expect(fixture.initializing).toBe(false)
  expect(fixture.children[0].clean).toBe(true)
  expect(fixture.ownerReleased).toBe(true)
})

it('fails closed on a missing install resource before Host readiness and preserves the failed step', async () => {
  fixture.holdReady = true
  const io = Promise.withResolvers<void>()
  fixture.accessGate = io.promise
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const starting = startLocalServiceDaemon(config)
  const failed = expect(starting).rejects.toThrow('SERVICE_RESOURCE_MISSING')
  await expect.poll(() => fixture.accesses.length).toBe(1)
  io.reject(new Error('ENOENT'))
  await failed
  expect(fixture.children[0].clean).toBe(true)
  expect(fixture.ownerReleased).toBe(true)
  expect(fixture.initializing).toBe(false)
  const failedSteps = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(step => step.event === 'startup.step.failed')
  expect(failedSteps.map(step => step.component)).toEqual(['runtime.node_resources', 'runtime.host_handshake'])
})

it('retains the last verified Core→Host boundary without attributing a bootstrap failure to a window', async () => {
  const profileRoot = await createTemporaryDirectory('lexora-core-bootstrap-')
  await mkdir(join(profileRoot, '.runtime'), { mode: 0o700 })
  fixture.failures.add(0)
  await expect(startLocalServiceDaemon({ ...config, profileRoot })).rejects.toThrow('PLATFORM_HOST_START_FAILED')
  const record = JSON.parse(await readFile(join(profileRoot, '.runtime', 'core-host-startup.json'), 'utf8'))
  expect(record).toEqual({ version: 1, buildId: config.buildId, startedAt: expect.any(String), occurredAt: expect.any(String), pid: process.pid, hostPid: 9000, stage: 'host_bootstrap', outcome: 'failed' })
  expect(fixture.ownerReleased).toBe(true)
})

it('holds the lease for an in-flight installation read on stop without launching post-gate work', async () => {
  const io = Promise.withResolvers<void>()
  fixture.accessGate = io.promise
  const shutdown = new AbortController()
  const starting = startLocalServiceDaemon(config, { signal: shutdown.signal })
  const cancelled = expect(starting).rejects.toThrow('SERVICE_STOPPING')
  await expect.poll(() => fixture.accesses.length).toBe(1)
  shutdown.abort()
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fixture.ownerReleased).toBe(false)
    expect(fixture.initializing).toBe(false)
  }
  finally {
    io.resolve()
    await cancelled
  }
  expect(fixture.accesses).toHaveLength(1)
  expect(fixture.ownerReleased).toBe(true)
})

it('opens the startup window while Core initializes and waits for initialization before stopping', async () => {
  const initialization = Promise.withResolvers<void>()
  fixture.initialize = initialization.promise
  const starting = startLocalServiceDaemon(config)
  void starting.catch(() => {})
  let peer: ServiceRpcChannel | undefined
  try {
    await expect.poll(() => fixture.initializing).toBe(true)
    expect(fixture.phases).toEqual(['starting'])
    const client = new Frames()
    const service = new Frames()
    client.opposite = service
    service.opposite = client
    fixture.servers[0].options.connected(service)
    peer = new ServiceRpcChannel(client as never)
    const expectedServiceInstanceId = '09f1e2ae-4b53-4730-b4e9-160bd5b14da3'
    await expect(peer.request('service.openDesktop', { expectedServiceInstanceId, intent: { kind: 'settings' } })).rejects.toThrow('Lexora Buddy runtime request failed')
    await expect(peer.request('service.openDesktop', { expectedServiceInstanceId, intent: { kind: 'tasks' } })).resolves.toEqual({ visible: true })
    expect(fixture.phases).toEqual(['starting'])
    const dispatched = Promise.withResolvers<void>()
    fixture.openDesktop = async (_input, signal) => {
      dispatched.resolve()
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    }
    const opening = peer.request('service.openDesktop', { expectedServiceInstanceId, intent: { kind: 'tasks' } })
    await dispatched.promise
    await expect(peer.request('service.stop', { expectedServiceInstanceId, reason: 'explicit', commandId: expectedServiceInstanceId })).resolves.toEqual({ accepted: true })
    await expect(opening).resolves.toMatchObject({ accepted: false, visible: false })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fixture.ownerReleased).toBe(false)
  }
  finally {
    initialization.resolve()
    peer?.close(new Error('TEST_FINISHED'))
    daemon = await starting.catch(() => undefined)
  }
  expect(fixture.disposed).toBe(true)
  expect(fixture.ownerReleased).toBe(true)
  expect(fixture.phases).toEqual(['starting', 'stopping'])
})

it('cancels an unfinished Host handshake on supervisor shutdown without admitting product work', async () => {
  fixture.unready.add(0)
  const shutdown = new AbortController()
  const starting = startLocalServiceDaemon(config, { signal: shutdown.signal })
  const failed = expect(starting).rejects.toThrow('SERVICE_STOPPING')
  await expect.poll(() => fixture.children.length).toBe(1)
  shutdown.abort()
  await failed
  expect(fixture.children[0].clean).toBe(true)
  expect(fixture.initializing).toBe(false)
  expect(fixture.ownerReleased).toBe(true)
  expect(fixture.phases).toEqual(['starting', 'stopping'])
})

it('refuses a late Host connection while its cancelled generation drains', async () => {
  const cleanup = Promise.withResolvers<void>()
  fixture.cleanup = cleanup.promise
  fixture.unready.add(0)
  const shutdown = new AbortController()
  const starting = startLocalServiceDaemon(config, { signal: shutdown.signal })
  const cancelled = expect(starting).rejects.toThrow('SERVICE_STOPPING')
  await expect.poll(() => fixture.children.length).toBe(1)
  shutdown.abort()
  const server = fixture.servers.find(server => server.options.role === 'host')
  try {
    expect(() => server.options.connected(new Frames())).toThrow('PLATFORM_HOST_CHANGED')
    expect(fixture.ownerReleased).toBe(false)
  }
  finally {
    cleanup.resolve()
    await cancelled
  }
  expect(fixture.ownerReleased).toBe(true)
  expect(fixture.servers.every(server => server.disposed)).toBe(true)
})

it('keeps the lease if a Runtime that finished initializing after cancellation cannot dispose', async () => {
  const initialization = Promise.withResolvers<void>()
  fixture.initialize = initialization.promise
  fixture.disposeFailure = true
  const shutdown = new AbortController()
  const starting = startLocalServiceDaemon(config, { signal: shutdown.signal })
  const failed = expect(starting).rejects.toThrow('SERVICE_STOP_UNCONFIRMED')
  await expect.poll(() => fixture.initializing).toBe(true)
  shutdown.abort()
  initialization.resolve()
  await failed
  expect(fixture.ownerReleased).toBe(false)
  expect(fixture.phases.at(-1)).toBe('failed')
})

describe('local service host recovery', () => {
  it.each(['process', 'socket'])('recovers exactly once when %s loss arrives first', async (first) => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    daemon = await startLocalServiceDaemon(config)
    stderr.mockClear()
    const original = fixture.children[0]
    if (first === 'process')
      original.exit()
    else
      original.peer.close(new ServiceFrameError('SERVICE_WRITE_QUEUE_LIMIT', 128))
    await readyAgain()
    expect(fixture.children).toHaveLength(2)
    expect(fixture.suspended).toBe(1)
    expect(fixture.resumed).toBe(1)
    expect(original.clean).toBe(true)
    expect(fixture.ownerReleased).toBe(false)
    expect(process.exitCode).toBe(exitCode)
    const records = stderr.mock.calls.map(([line]) => JSON.parse(String(line)))
    const exit = expect.objectContaining({ event: 'platform_host.process_exited', hostPid: 9000, exit: { code: 1, signal: null } })
    const recovered = expect.objectContaining({ event: 'platform_host.recovered', attempt: 1 })
    expect(records).toEqual(first === 'process'
      ? [exit, recovered]
      : [
          expect.objectContaining({
            event: 'platform_host.connection_closed',
            hostPid: 9000,
            rpcDisconnect: expect.objectContaining({ reason: 'SERVICE_WRITE_QUEUE_LIMIT', frameBytes: 128 }),
          }),
          exit,
          recovered,
        ])
    expect(records.at(-1).previousGeneration).toBe(records[0].generation)
    original.exit()
    await Promise.resolve()
    expect(fixture.children).toHaveLength(2)
  })

  it('pins the replacement Host’s own validated shell before resuming without repeating installation checks', async () => {
    fixture.windowsShell = true
    daemon = await startLocalServiceDaemon(config)
    const reads = fixture.accesses.length
    fixture.hostShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    fixture.resume = async () => {
      expect(process.env.PI_POWERSHELL_PATH).toBe(fixture.hostShell)
    }
    fixture.children[0].exit()
    await readyAgain()
    expect(fixture.accesses).toHaveLength(reads)
  })

  it('retries a replacement only after its cleanup is confirmed', async () => {
    fixture.failures.add(1)
    daemon = await startLocalServiceDaemon(config)
    fixture.children[0].exit()
    await readyAgain()
    expect(fixture.children).toHaveLength(3)
    expect(fixture.children.slice(0, 2).every(child => child.clean)).toBe(true)
    expect(fixture.resumed).toBe(1)
    expect(fixture.disposed).toBe(false)
  })

  it('releases the profile and fails the process after three unsuccessful replacements', async () => {
    fixture.failures = new Set([1, 2, 3])
    daemon = await startLocalServiceDaemon(config)
    fixture.children[0].exit()
    await expect.poll(() => process.exitCode).toBe(1)
    expect(fixture.children).toHaveLength(4)
    expect(fixture.children.every(child => child.clean)).toBe(true)
    expect(fixture.servers.every(server => server.disposed)).toBe(true)
    expect(fixture.disposed).toBe(true)
    expect(fixture.ownerReleased).toBe(true)
    expect(fixture.phases).toEqual(['starting', 'ready', 'recovering', 'stopping'])
  })

  it('retains the lease and stops replacement attempts when cleanup is unconfirmed', async () => {
    fixture.failures.add(1)
    fixture.cleanupFailures.add(1)
    daemon = await startLocalServiceDaemon(config)
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
    daemon = await startLocalServiceDaemon(config)
    fixture.children[0].exit()
    await expect.poll(() => process.exitCode).toBe(1)
    expect(fixture.phases).toEqual(['starting', 'ready', 'recovering', 'stopping'])
    expect(fixture.ownerReleased).toBe(true)
  })

  it('cancels a replacement readiness wait before awaiting recovery during shutdown', async () => {
    fixture.unready.add(1)
    daemon = await startLocalServiceDaemon(config)
    fixture.children[0].exit()
    await expect.poll(() => fixture.children.length).toBe(2)
    await daemon.stop()
    expect(fixture.children.every(child => child.clean)).toBe(true)
    expect(fixture.servers.every(server => server.disposed)).toBe(true)
    expect(fixture.ownerReleased).toBe(true)
    expect(fixture.phases).toEqual(['starting', 'ready', 'recovering', 'stopping'])
    expect(fixture.resumed).toBe(0)
    expect(process.exitCode).toBe(exitCode)
  }, 2000)

  it('keeps the lease when a cancelled replacement cannot confirm child cleanup', async () => {
    fixture.unready.add(1)
    fixture.cleanupFailures.add(1)
    daemon = await startLocalServiceDaemon(config)
    fixture.children[0].exit()
    await expect.poll(() => fixture.children.length).toBe(2)
    await expect(daemon.stop()).rejects.toThrow('SERVICE_STOP_UNCONFIRMED')
    expect(fixture.ownerReleased).toBe(false)
    expect(fixture.children).toHaveLength(2)
  }, 2000)

  it('does not launch a replacement after shutdown starts during recovery', async () => {
    daemon = await startLocalServiceDaemon(config)
    fixture.children[0].exit()
    await Promise.resolve()
    await daemon.stop()
    expect(fixture.children).toHaveLength(1)
    expect(fixture.ownerReleased).toBe(true)
    expect(process.exitCode).toBe(exitCode)
  })
})

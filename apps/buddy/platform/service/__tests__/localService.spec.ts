import type { ServiceIdentity, ServiceLaunch } from '../../../shared/service/localServiceProtocol'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { serviceLaunchSchema } from '../../../shared/service/localServiceProtocol'
import { localTransports } from '../../ipc/localTransport'
import { RuntimeRpcPeer } from '../../ipc/runtimeRpcPeer'
import { connectLocalService } from '../connectLocalService'
import { HostConnection } from '../HostConnection'
import { LocalServiceServer } from '../LocalServiceServer'
import { readPrivateServiceJson } from '../serviceFiles'
import { readServiceProcessIdentity, waitForServiceProcessExit } from '../serviceProcessIdentity'
import { ServiceProfileOwner } from '../ServiceProfileOwner'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})
const identity: ServiceIdentity = { protocol: 1, profileId: randomUUID(), serviceInstanceId: randomUUID(), buildId: 'a'.repeat(64), sessionId: 'test-session', userId: 'test-user' }
const secret = 'b'.repeat(64)
async function server(role: 'host' | 'management' | 'product' = 'host') {
  const root = await mkdtemp(join(tmpdir(), 'lexora-local-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const endpoint = process.platform === 'win32' ? localTransports.namedPipe(`\\\\.\\pipe\\lexora-test-${randomUUID()}`) : localTransports.unix(join(root, 'service.sock'))
  const peers: RuntimeRpcPeer[] = []
  const listener = new LocalServiceServer({ endpoint, identity, role, secret, connected: (frames) => {
    const peer = new RuntimeRpcPeer({ transport: frames.transport(), onFatalError: () => frames.close() })
    frames.onDidClose(error => peer.close(error))
    peer.onRequest('echo', value => value)
    peer.notify('initial', { ready: true })
    peers.push(peer)
  } })
  await listener.listen()
  cleanup.push(() => listener.dispose())
  return { endpoint, listener, peers }
}

it('authenticates the original instance and preserves frames immediately following the handshake', async () => {
  const f = await server()
  const client = await connectLocalService(f.endpoint.address, { ...identity, type: 'hello', role: 'host', secret })
  const notifications: unknown[] = []
  client.frames.onFrame(frame => notifications.push(JSON.parse(frame)))
  client.frames.resume()
  const peer = new RuntimeRpcPeer({ transport: client.frames.transport() })
  cleanup.push(() => client.frames.close())
  expect(await peer.request('echo', { same: true })).toEqual({ same: true })
  expect(notifications).toContainEqual({ jsonrpc: '2.0', method: 'initial', params: { ready: true } })
})

it.each(['role', 'secret', 'instance', 'session', 'build'] as const)('rejects an invalid %s without closing unrelated clients', async (field) => {
  const f = await server()
  const hello = { ...identity, type: 'hello' as const, role: 'host' as const, secret }
  const altered = { ...hello, ...field === 'role' ? { role: 'management' as const } : field === 'secret' ? { secret: 'c'.repeat(64) } : field === 'instance' ? { serviceInstanceId: randomUUID() } : field === 'session' ? { sessionId: 'other-session' } : { buildId: 'c'.repeat(64) } }
  await expect(connectLocalService(f.endpoint.address, altered)).rejects.toThrow()
  const client = await connectLocalService(f.endpoint.address, hello)
  cleanup.push(() => client.frames.close())
  const peer = new RuntimeRpcPeer({ transport: client.frames.transport() })
  expect(await peer.request('echo', field)).toBe(field)
})

it('isolates malformed and oversized frames to their connection', async () => {
  const f = await server()
  const bad = createConnection(f.endpoint.address)
  const closed = new Promise<void>(resolve => bad.once('close', () => resolve()))
  bad.on('error', () => {})
  bad.write('x'.repeat(1024 * 1024 + 1))
  await closed
  const client = await connectLocalService(f.endpoint.address, { ...identity, type: 'hello', role: 'host', secret })
  cleanup.push(() => client.frames.close())
  const peer = new RuntimeRpcPeer({ transport: client.frames.transport() })
  expect(await peer.request('echo', 'alive')).toBe('alive')
})

it('invalidates a dispatched old-host call and never replays it into a replacement', async () => {
  const first = await server()
  const second = await server()
  const connection = new HostConnection()
  let dispatched = 0
  const connect = async (f: Awaited<ReturnType<typeof server>>, id: string) => {
    const client = await connectLocalService(f.endpoint.address, { ...identity, type: 'hello', role: 'host', secret })
    cleanup.push(() => client.frames.close())
    const peer = new RuntimeRpcPeer({ transport: client.frames.transport() })
    connection.attach(id, peer)
    f.peers[0]!.onRequest('mutate', (_input, signal) => new Promise((resolve) => {
      dispatched++
      signal?.addEventListener('abort', () => resolve('unknown'), { once: true })
    }))
  }
  await connect(first, 'first')
  const pending = connection.request('mutate', {})
  const rejected = expect(pending).rejects.toThrow('PLATFORM_HOST_UNAVAILABLE')
  await new Promise(resolve => setTimeout(resolve, 10))
  connection.detach('first')
  await rejected
  await connect(second, 'second')
  expect(await connection.request('echo', 'replacement')).toBe('replacement')
  expect(dispatched).toBe(1)
  connection.detach('first')
  expect(connection.available).toBe(true)
  connection.close(new Error('done'))
})

it.skipIf(process.platform !== 'linux')('locks the canonical profile before publishing discovery, independent of profile label and aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-owner-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile')
  await mkdir(profile)
  await symlink(profile, join(root, 'alias'))
  const config: ServiceLaunch = serviceLaunchSchema.parse({ version: 1, profile: 'test', profileRoot: profile, resourcesRoot: root, nodeExecutable: process.execPath, coreEntry: join(root, 'core.mjs'), hostExecutable: process.execPath, releaseSetPath: join(root, 'release-set.json'), buildId: identity.buildId, userId: identity.userId, sessionId: identity.sessionId, storageAuthority: 'sqlite', leaseDirectory: join(root, 'locks') })
  const owner = await ServiceProfileOwner.acquire(config)
  cleanup.push(() => owner.dispose())
  await expect(ServiceProfileOwner.acquire({ ...config, profile: 'stable', profileRoot: join(root, 'alias') })).rejects.toThrow('STORAGE_ROOT_IN_USE')
  const discovery = await readPrivateServiceJson(join(profile, '.runtime/service.json'))
  expect(discovery).toMatchObject({ serviceInstanceId: owner.discovery.serviceInstanceId, process: { pid: process.pid }, phase: 'starting' })
  expect(JSON.stringify(discovery)).not.toContain(owner.managementSecret)
  await owner.dispose()
  const replacement = await ServiceProfileOwner.acquire(config)
  cleanup.push(() => replacement.dispose())
  expect(replacement.discovery.serviceInstanceId).not.toBe(owner.discovery.serviceInstanceId)
})

it.skipIf(process.platform !== 'linux')('confirms process exit by generation and never accepts a live matching process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  cleanup.push(() => {
    child.kill()
  })
  const identity = await readServiceProcessIdentity(child.pid!)
  await expect(waitForServiceProcessExit(identity, undefined, 20)).rejects.toThrow('SERVICE_STOP_UNCONFIRMED')
  await expect(waitForServiceProcessExit({ ...identity, startIdentity: 'previous-generation' })).resolves.toBeUndefined()
  const exited = once(child, 'exit')
  child.kill()
  await exited
  await expect(waitForServiceProcessExit(identity)).resolves.toBeUndefined()
})

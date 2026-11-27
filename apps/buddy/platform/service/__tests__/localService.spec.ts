import type { ServiceIdentity, ServiceLaunch } from '../../../shared/service/localServiceProtocol'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it, vi } from 'vitest'
import { attachmentHostRpc } from '../../../shared/runtime/attachmentHostProtocol'
import { serviceLaunchSchema } from '../../../shared/service/localServiceProtocol'
import { localTransports } from '../../ipc/localTransport'
import { RuntimeRpcPeer } from '../../ipc/runtimeRpcPeer'
import { storageBootstrapRoot } from '../../storage/StorageLocationStore'
import { connectLocalService } from '../connectLocalService'
import { HostConnection } from '../HostConnection'
import { LocalServiceServer } from '../LocalServiceServer'
import { activateRuntimeRelease, assertCurrentCore, readRuntimeRelease } from '../releaseActivation'
import { createReleaseSet, verifyFileInventory, verifyReleaseSet } from '../releaseSet'
import { readPrivateServiceJson } from '../serviceFiles'
import { readServiceProcessIdentity, waitForServiceProcessExit } from '../serviceProcessIdentity'
import { ServiceProfileOwner } from '../ServiceProfileOwner'
import { ServiceRpcChannel } from '../ServiceRpcChannel'
import { measureServiceStartupStep } from '../serviceStartupStep'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})
const identity: ServiceIdentity = { protocol: 1, profileId: randomUUID(), serviceInstanceId: randomUUID(), buildId: 'a'.repeat(64), sessionId: 'test-session', userId: 'test-user' }
const secret = 'b'.repeat(64)

it('verifies the complete release inventory across multiple batches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-release-inventory-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'core')
  const alias = join(root, 'core-alias')
  await mkdir(directory)
  await symlink(directory, alias, 'junction')
  const sha256 = createHash('sha256').update('original').digest('hex')
  const files = Array.from({ length: 10 }, (_, index) => ({ path: `dependency-${index}.mjs`, size: 8, sha256 }))
  await Promise.all(files.map(file => writeFile(join(directory, file.path), 'original')))
  const inventory = join(alias, 'inventory.json')
  const manifest = join(alias, 'resources.json')
  await writeFile(manifest, '{}')
  await writeFile(inventory, JSON.stringify({ version: 1, files }))
  await verifyFileInventory(inventory, [manifest])
  await writeFile(join(directory, 'dependency-9.mjs'), 'modified')
  await expect(verifyFileInventory(inventory, [manifest])).rejects.toThrow('SERVICE_RELEASE_CONTENT_CHANGED')
})

async function installedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-activation-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const profile = join(root, 'profile')
  const core = join(root, 'core')
  const entries = []
  const files = ['service.mjs', 'deep/dependency.js', 'resources/native-host/lexora-buddy-process-control', 'resources/native-host/lexora-buddy-file-reader', 'resources/native-image/lexora-buddy-image-transform', 'resources/search-tools/fd', 'resources/search-tools/rg']
  for (const path of files) {
    const content = path.endsWith('process-control') ? '#!/bin/sh\nexit 0\n' : 'original'
    await mkdir(dirname(join(core, path)), { recursive: true })
    await writeFile(join(core, path), content, { mode: 0o700 })
    entries.push({ path, sha256: hash(content), size: Buffer.byteLength(content) })
  }
  const inventory = JSON.stringify({ version: 1, files: entries })
  const coreManifest = JSON.stringify({ entry: 'service.mjs', bundled: [entries[0]], inventory: { path: 'inventory.json', sha256: hash(inventory) } })
  const release = createReleaseSet({ version: 1, target: process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64', productVersion: '1.0', core: { manifest: 'core/resources.json', manifestSha256: hash(coreManifest), entry: 'core/service.mjs' }, host: { kind: 'asar', path: 'host.asar', sha256: hash('host') }, node: { version: '26.2.0', entry: 'node', archiveSha256: hash('archive'), binarySha256: hash('node') } })
  const path = join(root, 'release-set.json')
  await mkdir(profile)
  await Promise.all([writeFile(join(profile, 'user-data'), 'untouched'), writeFile(join(root, 'node'), 'node'), writeFile(join(root, 'host.asar'), 'host'), writeFile(join(core, 'resources.json'), coreManifest), writeFile(join(core, 'inventory.json'), inventory), writeFile(path, JSON.stringify(release))])
  const activate = async () => activateRuntimeRelease(await readRuntimeRelease(path), profile, '1000')
  const receipt = join(storageBootstrapRoot(profile), 'activation/activation.json')
  return { root, profile, core, path, receipt, release, activate }
}

it.skipIf(process.platform !== 'linux')('requires an installed full scan, never walks an inventory on a valid receipt, and does not authorize repair from a matching version', async () => {
  const f = await installedFixture()
  await expect(f.activate()).resolves.toBe('full_inventory')
  const good = await readFile(f.receipt)
  const noTraversal = {
    createReadStream: () => { throw new Error('unexpected hash') },
    promises: {
      ...fs.promises,
      readdir: () => { throw new Error('unexpected traversal') },
    },
  }
  await expect(activateRuntimeRelease(await readRuntimeRelease(f.path, noTraversal), f.profile, '1000', noTraversal)).resolves.toBe('installed_identity')
  await writeFile(join(f.core, 'deep/dependency.js'), 'modified')
  await expect(verifyReleaseSet(await readRuntimeRelease(f.path))).rejects.toThrow('SERVICE_RELEASE_CONTENT_CHANGED')
  await copyFile(f.path, `${f.path}.next`)
  await rename(`${f.path}.next`, f.path)
  await expect(f.activate()).rejects.toThrow('SERVICE_RELEASE_CONTENT_CHANGED')
  expect(await readFile(f.receipt)).toEqual(good)
  expect(await readFile(join(f.profile, 'user-data'), 'utf8')).toBe('untouched')
  await writeFile(join(f.core, 'deep/dependency.js'), 'original')
  await expect(f.activate()).resolves.toBe('full_inventory')
  expect(await readFile(f.receipt)).not.toEqual(good)
  for (const invalid of ['{', '{}']) {
    await writeFile(f.receipt, invalid)
    await expect(f.activate()).resolves.toBe('full_inventory')
  }
  await chmod(f.receipt, 0o666)
  await expect(f.activate()).rejects.toThrow('SERVICE_PRIVATE_FILE_INVALID')
})

it.skipIf(process.platform !== 'linux')('rejects mismatched targets, invalid entry types, and a damaged process helper before executing it', async () => {
  const f = await installedFixture()
  await expect(f.activate()).resolves.toBe('full_inventory')
  await expect(assertCurrentCore(await readRuntimeRelease(f.path))).rejects.toThrow('SERVICE_RELEASE_IDENTITY_CHANGED')
  await writeFile(join(f.core, 'resources/native-host/lexora-buddy-process-control'), '#!/bin/sh\nexit 32\n')
  await expect(f.activate()).rejects.toThrow('SERVICE_RELEASE_CONTENT_CHANGED')
  await rm(join(f.root, 'node'))
  await mkdir(join(f.root, 'node'))
  await expect(f.activate()).rejects.toThrow('SERVICE_RELEASE_FILE_INVALID')
  await rm(join(f.root, 'node'), { recursive: true })
  await symlink(process.execPath, join(f.root, 'node'))
  await expect(f.activate()).rejects.toThrow('SERVICE_RELEASE_FILE_INVALID')
  await rm(join(f.root, 'node'))
  await writeFile(join(f.root, 'node'), 'node')
  const { buildId: _previous, ...content } = f.release
  await writeFile(f.path, JSON.stringify(createReleaseSet({ ...content, target: 'darwin-arm64' })))
  await expect(f.activate()).rejects.toThrow('SERVICE_RELEASE_TARGET_CHANGED')
})

it('keeps only bounded startup facts, without changing the underlying result when diagnostics fail', async () => {
  const parentOperationId = randomUUID()
  const reason = new Error('fixture-private-path and fixture-secret')
  const sink = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(measureServiceStartupStep('runtime.process_installation_gate', parentOperationId, () => Promise.reject(reason))).rejects.toBe(reason)
    expect(JSON.parse(sink.mock.calls[0]![0])).toEqual({ event: 'startup.step.failed', level: 'error', component: 'runtime.process_installation_gate', parentOperationId, operationId: expect.any(String), occurredAt: expect.any(String), durationMs: expect.any(Number) })
    sink.mockImplementation(() => {
      throw new Error('fixture sink unavailable')
    })
    const { record, value } = await measureServiceStartupStep('launcher.installation_gate', parentOperationId, async () => 7)
    expect(value).toBe(7)
    const handoff = serviceLaunchSchema.shape.launcherVerification
    expect(handoff.parse(record)).toEqual(record)
    expect(handoff.parse({ ...record, path: 'fixture-private-path' })).toBeUndefined()
    await expect(measureServiceStartupStep('runtime.module_load', parentOperationId, () => Promise.reject(reason))).rejects.toBe(reason)
  }
  finally { sink.mockRestore() }
})

async function server(role: 'host' | 'management' | 'product' = 'host') {
  const root = await mkdtemp(join(tmpdir(), 'lexora-local-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const endpoint = process.platform === 'win32' ? localTransports.namedPipe(`\\\\.\\pipe\\lexora-test-${randomUUID()}`) : localTransports.unix(join(root, 'service.sock'))
  const peers: ServiceRpcChannel[] = []
  const listener = new LocalServiceServer({ endpoint, identity, role, secret, connected: (frames) => {
    const peer = new ServiceRpcChannel(frames)
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

it('isolates oversized RPC failures and reassembles simultaneous history reads on one socket', async () => {
  const f = await server('management')
  const connection = await connectLocalService(f.endpoint.address, { ...identity, type: 'hello', role: 'management', secret })
  const client = new ServiceRpcChannel(connection.frames)
  cleanup.push(() => client.close(new Error('done')))
  const body = { text: '界🙂'.repeat(180000) }
  const serverPeer = f.peers[0]!
  serverPeer.onRequest('large', () => body)
  serverPeer.onRequest('conversations.getHistoryEntries', () => body)
  serverPeer.onRequest('conversations.listTimeline', () => body)
  await expect(client.request('large', {})).rejects.toMatchObject({ data: { code: 'RPC_PAYLOAD_TOO_LARGE' } })
  await expect(client.request('echo', body)).rejects.toMatchObject({ code: 'RPC_PAYLOAD_TOO_LARGE' })
  const values = await Promise.all([client.request('conversations.listTimeline', {}), client.request('echo', 17), client.request('conversations.getHistoryEntries', {})])
  expect(values).toEqual([body, 17, body])
  expect(client.closed).toBe(false)
})

it('keeps the socket available when an RPC handler returns no value', async () => {
  const f = await server()
  const { frames } = await connectLocalService(f.endpoint.address, { ...identity, type: 'hello', role: 'host', secret })
  const client = new ServiceRpcChannel(frames)
  cleanup.push(() => client.close(new Error('done')))
  f.peers[0]!.onRequest('complete', () => undefined)
  await expect(client.request('complete', {})).resolves.toBeNull()
  await expect(client.request('echo', 'ready')).resolves.toBe('ready')
})

it.each([
  ['{bad json}', 'SERVICE_READ_FRAME_INVALID', 10],
  ['{"jsonrpc":"2.0","id":"reply-without-result"}', 'RPC_INVALID_MESSAGE', undefined],
])('preserves the first close reason for a bad frame %# along with recent RPC methods', async (frame, reason, frameBytes) => {
  const f = await server()
  const { frames } = await connectLocalService(f.endpoint.address, { ...identity, type: 'hello', role: 'host', secret })
  const client = new ServiceRpcChannel(frames)
  cleanup.push(() => client.close(new Error('done')))
  const serverPeer = f.peers[0]!
  const closed = Promise.withResolvers<unknown>()
  const received: unknown[] = []
  serverPeer.onDidClose((event) => {
    received.push(event)
    closed.resolve(event)
  })
  await client.request('echo', { text: 'private fixture' })
  frames.send(frame)
  await expect(closed.promise).resolves.toEqual({
    reason,
    frameBytes,
    pendingBinaryBytes: 0,
    pendingWriteBytes: 0,
    lastSentMethod: 'initial',
    lastReceivedMethod: 'echo',
    systemCode: undefined,
  })
  serverPeer.close(new Error('later'))
  expect(received).toHaveLength(1)
})

it('reads a multi-frame attachment preview only on the host connection', async () => {
  const host = await server('host')
  const management = await server('management')
  const connect = async (endpoint: string, role: 'host' | 'management') => {
    const connection = await connectLocalService(endpoint, { ...identity, type: 'hello', role, secret })
    const peer = new ServiceRpcChannel(connection.frames)
    cleanup.push(() => peer.close(new Error('done')))
    return peer
  }
  const reader = await connect(host.endpoint.address, 'host')
  const desktop = await connect(management.endpoint.address, 'management')
  const preview = { mimeType: 'image/png', data: Buffer.alloc(1024 * 1024, 123).toString('base64') }
  host.peers[0]!.onRequest(attachmentHostRpc.readPreview, () => preview)
  await expect(desktop.request(attachmentHostRpc.readPreview, { attachmentId: 'image' })).rejects.toMatchObject({ code: -32601 })
  expect(await reader.request(attachmentHostRpc.readPreview, { attachmentId: 'image' })).toEqual(preview)
  expect(await reader.request('echo', 'ready')).toBe('ready')
})

it('transports binary request bodies and preserves interleaved RPC boundaries', async () => {
  const f = await server('management')
  const client = await connectLocalService(f.endpoint.address, { ...identity, type: 'hello', role: 'management', secret })
  cleanup.push(() => client.frames.close())
  const peer = new RuntimeRpcPeer({ transport: client.frames.transport() })
  f.peers[0]!.onRequest('digest', (params) => {
    const { bytes } = params as { bytes: Uint8Array }
    expect(bytes).toBeInstanceOf(Uint8Array)
    return createHash('sha256').update(bytes).digest('hex')
  })
  const large = Buffer.alloc(32 * 1024 * 1024, 10)
  await expect(peer.request('digest', { bytes: new Uint8Array(large.length + 1) })).rejects.toThrow('SERVICE_BINARY_LIMIT')
  const bodies = [new Uint8Array(), large.subarray(17, 189254), large]
  const results = await Promise.all([...bodies.map(bytes => peer.request('digest', { bytes })), peer.request('echo', 'alive')])
  expect(results).toEqual([...bodies.map(bytes => createHash('sha256').update(bytes).digest('hex')), 'alive'])
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
  const discoveryPath = join(profile, '.runtime/service.json')
  await expect(readPrivateServiceJson(discoveryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await owner.publish('starting')
  const discovery = await readPrivateServiceJson(discoveryPath)
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

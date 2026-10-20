import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeFileEngine } from '../NativeFileEngine'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const dispose of cleanup.splice(0).reverse())
    await dispose()
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'native-file-engine-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function latestHelper() {
  const result = vi.mocked(spawn).mock.results.at(-1)
  if (result?.type !== 'return')
    throw new Error('Missing owned helper')
  return result.value as ChildProcessWithoutNullStreams
}

async function killHelper(child: ChildProcessWithoutNullStreams) {
  const closed = once(child, 'close')
  expect(child.kill('SIGKILL')).toBe(true)
  await closed
  expect(child.signalCode).toBe('SIGKILL')
}

async function nativeEngine() {
  const directory = await temporaryDirectory()
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'note.txt'), 'original')
  const engine = new NativeFileEngine(join(directory, 'journal'))
  cleanup.push(() => engine.dispose())
  await engine.ready()
  await engine.register('workspace', workspace)
  return { directory, workspace, engine, child: latestHelper() }
}

function sentCommands(child: ChildProcessWithoutNullStreams) {
  const commands: Array<{ type: string, leaseId?: string, request?: { operationId: string } }> = []
  const write = child.stdin.write.bind(child.stdin)
  vi.spyOn(child.stdin, 'write').mockImplementation(((...args: Parameters<typeof write>) => {
    commands.push(JSON.parse(String(args[0])).command)
    return write(...args)
  }) as typeof write)
  return commands
}

describe('real native helper recovery', () => {
  it('restarts once after kill + close and supports concurrent reads and a new write', async () => {
    const { engine, child, workspace } = await nativeEngine()
    const before = vi.mocked(spawn).mock.calls.length
    await killHelper(child)
    const documents = await Promise.all(Array.from({ length: 24 }, () => engine.read('workspace', 'note.txt')))
    expect(documents.every(document => document.text === 'original')).toBe(true)
    expect(vi.mocked(spawn).mock.calls.length).toBe(before + 1)
    expect(latestHelper().pid).not.toBe(child.pid)
    const record = await engine.mutate({ operationId: randomUUID(), root: 'workspace', path: 'note.txt', action: { kind: 'write', text: 'new request' } })
    expect(record.status).toBe('applied')
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('new request')
  })

  it('invalidates watched roots after reconnect and restores watching when refreshed', async () => {
    const { engine, child, workspace } = await nativeEngine()
    await engine.register('workspace', workspace, true)
    const changed: string[][] = []
    engine.onDidChange((event) => {
      if (event.event === 'changed')
        changed.push(event.roots)
    })
    await killHelper(child)
    await engine.query(randomUUID())
    expect(changed).toContainEqual(['workspace'])
    await engine.read('workspace', 'note.txt')
    changed.length = 0
    await writeFile(join(workspace, 'note.txt'), 'external change')
    await vi.waitFor(() => expect(changed).toContainEqual(['workspace']))
    expect((await engine.read('workspace', 'note.txt')).text).toBe('external change')
  })

  it('preserves an applied write whose response was lost, without replaying it on a later read', async () => {
    const { engine, child, workspace } = await nativeEngine()
    const operationId = randomUUID()
    const applied = Promise.withResolvers<void>()
    const receivers = child.stdout.listeners('data')
    child.stdout.removeAllListeners('data')
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const frame = buffer.slice(0, end + 1)
        buffer = buffer.slice(end + 1)
        const response = JSON.parse(frame)
        if (response.id && response.result?.operationId === operationId) {
          expect(response.result.status).toBe('applied')
          applied.resolve()
        }
        else {
          for (const receive of receivers)
            receive.call(child.stdout, Buffer.from(frame))
        }
      }
    })
    const interrupted = engine.mutate({ operationId, root: 'workspace', path: 'note.txt', action: { kind: 'write', text: 'applied before disconnect' } }).catch(error => error)
    await applied.promise
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('applied before disconnect')
    await killHelper(child)
    expect(await interrupted).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
    await writeFile(join(workspace, 'note.txt'), 'subsequent external edit')
    expect((await engine.read('workspace', 'note.txt')).text).toBe('subsequent external edit')
    expect(await engine.query(operationId)).toMatchObject({ operationId, status: 'applied' })
    expect((await engine.history('workspace')).filter(record => record.operationId === operationId)).toHaveLength(1)
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('subsequent external edit')
  })

  it('fails queued mutation/acquire without replay and retains the existing lease until its owner releases', async () => {
    const { engine, child, workspace } = await nativeEngine()
    const owner = randomUUID()
    const waiting = randomUUID()
    const operationId = randomUUID()
    const claims = [{ root: 'workspace', path: 'note.txt', subtree: false }]
    await engine.acquire(owner, claims)
    const commands = sentCommands(child)
    const mutation = engine.mutate({ operationId, root: 'workspace', path: 'note.txt', action: { kind: 'write', text: 'must not replay' } }).catch(error => error)
    const acquisition = engine.acquire(waiting, claims, true).catch(error => error)
    await vi.waitFor(() => {
      expect(commands.some(command => command.request?.operationId === operationId)).toBe(true)
      expect(commands.some(command => command.type === 'acquire' && command.leaseId === waiting)).toBe(true)
    })
    expect(await engine.query(operationId)).toBeNull()
    await killHelper(child)
    expect(await mutation).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
    expect(await acquisition).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
    await expect(engine.read('workspace', 'note.txt')).rejects.toThrow('FILE_ENGINE_ACTIVE_LEASES')
    await engine.release(owner)
    expect((await engine.read('workspace', 'note.txt')).text).toBe('original')
    expect(await engine.query(operationId)).toBeNull()
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('original')
    expect((await engine.mutate({ operationId: randomUUID(), root: 'workspace', path: 'note.txt', action: { kind: 'write', text: 'fresh' } })).status).toBe('applied')
  })

  it('cancels a blocked acquire on its original connection without losing the existing owner', async () => {
    const { engine, child } = await nativeEngine()
    const owner = randomUUID()
    const waiting = randomUUID()
    const claims = [{ root: 'workspace', path: '', subtree: true }]
    await engine.acquire(owner, claims)
    const commands = sentCommands(child)
    const controller = new AbortController()
    const acquisition = engine.acquire(waiting, claims, true, controller.signal).catch(error => error)
    await vi.waitFor(() => expect(commands.some(command => command.type === 'acquire' && command.leaseId === waiting)).toBe(true))
    controller.abort()
    expect(await acquisition).toMatchObject({ code: 'FILE_OPERATION_CANCELLED' })
    await engine.release(owner)
    const next = randomUUID()
    await engine.acquire(next, claims)
    await engine.release(next)
    expect((await engine.read('workspace', 'note.txt')).text).toBe('original')
  })

  it('does not turn a still-running external owner into a historical lease after helper death', async () => {
    const { engine, child } = await nativeEngine()
    const owner = randomUUID()
    await engine.acquire(owner, [{ root: 'workspace', path: '', subtree: true }], true)
    const external = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'pipe' })
    cleanup.push(async () => {
      if (external.exitCode === null && external.signalCode === null)
        await killHelper(external)
      await engine.release(owner)
    })
    await once(external, 'spawn')
    await killHelper(child)
    await expect(engine.ready()).rejects.toThrow('FILE_ENGINE_ACTIVE_LEASES')
    expect(external.exitCode).toBeNull()
    expect(external.signalCode).toBeNull()
    await killHelper(external)
    await engine.release(owner)
    expect((await engine.read('workspace', 'note.txt')).text).toBe('original')
    const next = randomUUID()
    await engine.acquire(next, [{ root: 'workspace', path: '', subtree: true }], true)
    await engine.release(next)
  })

  it('rejects a replaced root including concurrent access without poisoning another root', async () => {
    const { directory, engine, child, workspace } = await nativeEngine()
    const healthy = join(directory, 'healthy')
    await mkdir(healthy)
    await writeFile(join(healthy, 'note.txt'), 'healthy')
    await engine.register('healthy', healthy)
    await killHelper(child)
    await rename(workspace, join(directory, 'previous-workspace'))
    await mkdir(workspace)
    await writeFile(join(workspace, 'note.txt'), 'replacement')
    const results = await Promise.allSettled([
      engine.read('workspace', 'note.txt'),
      engine.read('workspace', 'note.txt'),
      engine.read('healthy', 'note.txt'),
    ])
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'FILE_PERMISSION_REVOKED' } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'FILE_PERMISSION_REVOKED' } })
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: { text: 'healthy' } })
    await expect(engine.register('workspace', workspace)).rejects.toThrow('FILE_PERMISSION_REVOKED')
    await expect(engine.mutate({ operationId: randomUUID(), root: 'healthy', path: 'note.txt', action: { kind: 'copy', destinationRoot: 'workspace', destination: 'copied.txt' } })).rejects.toThrow('FILE_PERMISSION_REVOKED')
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('replacement')
    expect((await engine.mutate({ operationId: randomUUID(), root: 'healthy', path: 'note.txt', action: { kind: 'write', text: 'still healthy' } })).status).toBe('applied')
  })

  it('keeps an offline root isolated and rechecks it when the original directory returns', async () => {
    const { directory, engine, child, workspace } = await nativeEngine()
    const healthy = join(directory, 'healthy')
    await mkdir(healthy)
    await writeFile(join(healthy, 'note.txt'), 'healthy')
    await engine.register('healthy', healthy)
    const offline = join(directory, 'offline')
    await killHelper(child)
    await rename(workspace, offline)
    expect((await engine.read('healthy', 'note.txt')).text).toBe('healthy')
    await expect(engine.read('workspace', 'note.txt')).rejects.toThrow('FILE_IO_FAILED')
    await rename(offline, workspace)
    expect((await engine.read('workspace', 'note.txt')).text).toBe('original')
  })

  it('does not restore explicitly revoked authority after restart', async () => {
    const { engine, child, workspace } = await nativeEngine()
    await engine.revoke('workspace')
    await killHelper(child)
    await expect(engine.read('workspace', 'note.txt')).rejects.toThrow('FILE_PERMISSION_REVOKED')
    await expect(engine.register('workspace', workspace)).rejects.toThrow('FILE_PERMISSION_REVOKED')
    await engine.register('new-authority', workspace)
    expect((await engine.read('new-authority', 'note.txt')).text).toBe('original')
  })

  it.skipIf(process.platform === 'win32')('bounds disposal of a stopped real helper and confirms its forced exit', async () => {
    const { engine, child } = await nativeEngine()
    expect(child.kill('SIGSTOP')).toBe(true)
    const commands = sentCommands(child)
    const interrupted = engine.query(randomUUID()).catch(error => error)
    await vi.waitFor(() => expect(commands.some(command => command.type === 'query')).toBe(true))
    await engine.dispose()
    expect(child.signalCode).toBe('SIGKILL')
    expect(await interrupted).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
    await expect(engine.ready()).rejects.toThrow('FILE_ENGINE_UNAVAILABLE')
  })

  it('shuts down with a blocked acquire, rejects the pending request and leaves no owned helper', async () => {
    const { engine, child } = await nativeEngine()
    const owner = randomUUID()
    const waiting = randomUUID()
    const claims = [{ root: 'workspace', path: '', subtree: true }]
    await engine.acquire(owner, claims)
    const commands = sentCommands(child)
    const acquisition = engine.acquire(waiting, claims).catch(error => error)
    await vi.waitFor(() => expect(commands.some(command => command.leaseId === waiting)).toBe(true))
    await Promise.all([engine.dispose(), engine.dispose()])
    expect(await acquisition).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    await expect(engine.ready()).rejects.toThrow('FILE_ENGINE_UNAVAILABLE')
    await engine.release(owner)
  })
})

// Transport-only fixture: it models protocol/exit ordering, not native disk effects or atomicity.
class TransportChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  commands: Array<{ id: number, command: { type: string, key?: string, path?: string } }> = []
  kill = vi.fn(() => true)
  closed = false
  respond = true
  shutdown = true

  constructor() {
    super()
    this.stdin.on('data', (frame: Buffer) => {
      const request = JSON.parse(frame.toString())
      this.commands.push(request)
      if (request.command.type === 'shutdown' && this.shutdown) {
        this.reply(request.id, null)
        queueMicrotask(() => this.close())
      }
      else if (request.command.type === 'register') {
        this.reply(request.id, { identity: 'transport-identity', path: request.command.path })
      }
      else if (this.respond && request.command.type === 'read') {
        this.reply(request.id, { text: 'transport-result', identity: 'transport-file', etag: '0'.repeat(64) })
      }
    })
  }

  connect(ready = true) {
    if (ready)
      queueMicrotask(() => this.stdout.write('{"event":"ready","version":2}\n'))
    return this as unknown as ChildProcessWithoutNullStreams
  }

  reply(id: number, result: unknown) {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`)
  }

  close() {
    if (this.closed)
      return
    this.closed = true
    this.emit('close')
  }
}

function transportEngine(ready = true) {
  const transport = new TransportChild()
  vi.mocked(spawn).mockImplementationOnce(() => transport.connect(ready))
  const engine = new NativeFileEngine('/transport-only-journal', '/transport-only-helper')
  cleanup.push(async () => {
    transport.close()
    await engine.dispose().catch(() => {})
  })
  return { engine, transport }
}

describe('transport-only fault ordering', () => {
  it('retires an explicitly released lease after late close without retiring another live owner', async () => {
    const { engine, transport } = transportEngine()
    await engine.ready()
    await engine.register('root', '/transport-only-root')
    const ended = randomUUID()
    const active = randomUUID()
    for (const leaseId of [ended, active]) {
      const acquired = engine.acquire(leaseId, [{ root: 'root', path: leaseId, subtree: false }], true)
      await vi.waitFor(() => expect(transport.commands.at(-1)?.command.type).toBe('acquire'))
      transport.reply(transport.commands.at(-1)!.id, null)
      await acquired
      transport.commands.length = 0
    }
    transport.stdout.write('broken protocol\n')
    vi.useFakeTimers()
    const release = engine.release(ended).catch(error => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await release).toMatchObject({ code: 'FILE_ENGINE_STOP_TIMEOUT' })
    transport.close()
    await expect(engine.ready()).rejects.toThrow('FILE_ENGINE_ACTIVE_LEASES')
    await engine.release(active)
    const replacement = new TransportChild()
    vi.mocked(spawn).mockImplementationOnce(() => replacement.connect())
    vi.useRealTimers()
    expect((await engine.read('root', 'next')).text).toBe('transport-result')
    expect(replacement.commands.map(request => request.command.type)).toEqual(['register', 'read'])
    await engine.dispose()
  })

  it('allows owner cleanup through a full request queue and retains a release accounting error without a stale lease', async () => {
    const { engine, transport } = transportEngine()
    await engine.ready()
    await engine.register('root', '/transport-only-root')
    const owner = randomUUID()
    const acquired = engine.acquire(owner, [{ root: 'root', path: '', subtree: true }])
    await vi.waitFor(() => expect(transport.commands.at(-1)?.command.type).toBe('acquire'))
    transport.reply(transport.commands.at(-1)!.id, null)
    await acquired
    transport.respond = false
    const pending = Array.from({ length: 128 }, (_, index) => engine.read('root', String(index)).catch(error => error))
    await vi.waitFor(() => expect(transport.commands.filter(request => request.command.type === 'read')).toHaveLength(128))
    const release = engine.release(owner).catch(error => error)
    await vi.waitFor(() => expect(transport.commands.at(-1)?.command.type).toBe('release'))
    transport.stdout.write(`${JSON.stringify({ id: transport.commands.at(-1)!.id, error: 'FILE_IO_FAILED' })}\n`)
    expect(await release).toMatchObject({ code: 'FILE_IO_FAILED' })
    transport.close()
    expect((await Promise.all(pending)).every(error => error.code === 'FILE_ENGINE_INTERRUPTED')).toBe(true)
    const replacement = new TransportChild()
    vi.mocked(spawn).mockImplementationOnce(() => replacement.connect())
    expect((await engine.read('root', 'next')).text).toBe('transport-result')
    await engine.dispose()
  })

  it('bounds startup without sending business requests to an unready helper', async () => {
    vi.useFakeTimers()
    const { engine, transport } = transportEngine(false)
    const readiness = engine.ready().catch(error => error)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await readiness).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
    expect(transport.kill).toHaveBeenCalledWith('SIGKILL')
    expect(transport.commands).toEqual([])
    transport.close()
    await engine.dispose()
  })

  it('does not time out a legitimate acquire wait, but terminates a malformed response before settling', async () => {
    const { engine, transport } = transportEngine()
    await engine.ready()
    await engine.register('root', '/transport-only-root')
    let settled = false
    const acquisition = engine.acquire(randomUUID(), [{ root: 'root', path: '', subtree: true }]).catch((error) => {
      settled = true
      return error
    })
    await vi.waitFor(() => expect(transport.commands.some(request => request.command.type === 'acquire')).toBe(true))
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(transport.kill).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    const request = transport.commands.find(request => request.command.type === 'acquire')!
    transport.reply(request.id, { invalid: 'acquire result' })
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.kill).toHaveBeenCalledWith('SIGKILL')
    expect(settled).toBe(false)
    transport.close()
    expect(await acquisition).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
  })

  it('does not settle interrupted I/O or restart before confirmed exit, and ignores old connection events', async () => {
    const { engine, transport } = transportEngine()
    await engine.ready()
    await engine.register('root', '/transport-only-root')
    transport.respond = false
    let settled = false
    const pending = engine.read('root', 'old').catch((error) => {
      settled = true
      return error
    })
    await vi.waitFor(() => expect(transport.commands.some(request => request.command.type === 'read')).toBe(true))
    transport.stdout.write('not json\n')
    expect(transport.kill).toHaveBeenCalledWith('SIGKILL')
    const before = vi.mocked(spawn).mock.calls.length
    const replacement = new TransportChild()
    vi.mocked(spawn).mockImplementationOnce(() => replacement.connect())
    const next = engine.read('root', 'new')
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(vi.mocked(spawn).mock.calls.length).toBe(before)
    transport.close()
    expect(await pending).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
    expect((await next).text).toBe('transport-result')
    const events: unknown[] = []
    engine.onDidChange(event => events.push(event))
    transport.stdout.write('{"event":"changed","roots":["root"]}\n')
    transport.emit('error', new Error('late old error'))
    transport.emit('close')
    expect(events).toEqual([])
    expect(replacement.commands.map(request => request.command.type)).toEqual(['register', 'read'])
    expect((await engine.read('root', 'later')).text).toBe('transport-result')
    await engine.dispose()
    expect(replacement.closed).toBe(true)
  })

  it('kills a helper on stdin failure but waits for actual close before rejecting the request', async () => {
    const { engine, transport } = transportEngine()
    await engine.ready()
    transport.respond = false
    let settled = false
    const pending = engine.query(randomUUID()).catch((error) => {
      settled = true
      return error
    })
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1))
    transport.stdin.emit('error', new Error('broken pipe'))
    expect(transport.kill).toHaveBeenCalledWith('SIGKILL')
    await Promise.resolve()
    expect(settled).toBe(false)
    transport.close()
    expect(await pending).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
  })

  it('bounds shutdown, reports unconfirmed termination and keeps I/O pending until exit evidence', async () => {
    const { engine, transport } = transportEngine()
    await engine.ready()
    transport.respond = false
    transport.shutdown = false
    let settled = false
    const pending = engine.query(randomUUID()).catch((error) => {
      settled = true
      return error
    })
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1))
    vi.useFakeTimers()
    const disposal = engine.dispose().catch(error => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(transport.kill).toHaveBeenCalledWith('SIGKILL')
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await disposal).toMatchObject({ code: 'FILE_ENGINE_STOP_TIMEOUT' })
    expect(settled).toBe(false)
    transport.close()
    expect(await pending).toMatchObject({ code: 'FILE_ENGINE_INTERRUPTED' })
    await expect(engine.dispose()).resolves.toBeUndefined()
    await expect(engine.ready()).rejects.toThrow('FILE_ENGINE_UNAVAILABLE')
  })
})

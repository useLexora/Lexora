import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ZodType } from 'zod'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { z } from 'zod'
import { Emitter } from '../../../shared/events/Emitter'
import { directoryPageSchema } from '../../../shared/files/filePreview'

export const nativeOperationSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.string(),
  source: z.string(),
  destination: z.string().nullable(),
  status: z.enum(['prepared', 'executing', 'applied', 'not-applied', 'needs-recovery', 'acknowledged']),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  receipt: z.record(z.string(), z.unknown()).nullable(),
})
export type NativeFileOperation = z.infer<typeof nativeOperationSchema>
export type FileAction
  = { kind: 'write', text: string, expected?: string }
    | { kind: 'createFile' | 'createDirectory' | 'trash' }
    | { kind: 'rename', destination: string }
    | { kind: 'copy' | 'move', destinationRoot: string, destination: string }
    | { kind: 'restore', originalOperationId: string }
export interface NativeFileClaim { root: string, path: string, subtree: boolean }
export interface NativeFileProtection { path: string, subtree: boolean }
export interface NativeFileMutation { operationId: string, root: string, path: string, leaseId?: string, action: FileAction }
const nativeDocumentSchema = z.object({ text: z.string(), etag: z.string().length(64), identity: z.string() })
const nativeRootSchema = z.object({ identity: z.string(), path: z.string() })
const notificationSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('changed'), roots: z.array(z.string()) }),
  z.object({ event: z.literal('operation'), operation: nativeOperationSchema }),
  z.object({ event: z.literal('progress'), operationId: z.string(), bytes: z.number() }),
])
const startupTimeout = 10_000
const shutdownTimeout = 5_000
const terminationTimeout = 5_000

interface FileEngineConnection {
  child: ChildProcessWithoutNullStreams
  ready: PromiseWithResolvers<void>
  closed: PromiseWithResolvers<void>
  pending: Map<number, { resolve: (value: unknown) => void, reject: (reason: Error) => void }>
  buffer: Buffer
  failed: boolean
  exited: boolean
  startupTimer?: ReturnType<typeof setTimeout>
}

interface RegisteredRoot {
  identity: string
  path: string
  watch: boolean
  connection: FileEngineConnection
}

class FileEngineError extends Error {
  readonly code: string
  readonly responseReceived: boolean

  constructor(code: string, responseReceived = false) {
    super(code === 'FILE_ENGINE_INTERRUPTED' ? `${code}: 文件操作可能已产生副作用，请重新读取后发起新操作。` : code)
    this.code = code
    this.responseReceived = responseReceived
    this.name = 'FileEngineError'
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FileEngineError(code)), milliseconds)
      }),
    ])
  }
  finally { clearTimeout(timer) }
}

export class NativeFileEngine {
  readonly #directory: string
  readonly #executable: string
  readonly #roots = new Map<string, RegisteredRoot>()
  readonly #revoked = new Set<string>()
  readonly #rootQueues = new Map<string, Promise<unknown>>()
  readonly #leases = new Map<string, FileEngineConnection>()
  readonly #events = new Emitter<z.infer<typeof notificationSchema>>(() => console.error('FILE_ENGINE_OBSERVER_FAILED'))
  readonly onDidChange = this.#events.event
  #connection: FileEngineConnection
  #starting?: Promise<FileEngineConnection>
  #disposing?: Promise<void>
  #sequence = 0
  #stopping = false

  constructor(directory: string, executable = process.env.LEXORA_BUDDY_FILE_READER) {
    if (!executable)
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    this.#directory = directory
    this.#executable = executable
    this.#connection = this.#spawn()
  }

  async ready(): Promise<void> { await this.#connect() }

  async register(key: string, path: string, watch = false) {
    const connection = await this.#connect()
    return this.#rootQueue(key, () => this.#register(connection, key, path, watch))
  }

  async revoke(key: string) {
    this.#revoked.add(key)
    this.#roots.delete(key)
    const connection = this.#connection
    if (connection.failed) {
      await this.#waitForExit(connection)
      return null
    }
    return this.#send(connection, { type: 'revoke', key }, z.null())
  }

  list(root: string, path: string, cursor?: string) { return this.#request({ type: 'list', root, path, cursor }, directoryPageSchema, [root]) }
  read(root: string, path: string) { return this.#request({ type: 'read', root, path }, nativeDocumentSchema, [root]) }
  mutate(request: NativeFileMutation) {
    const roots = [request.root]
    if (request.action.kind === 'copy' || request.action.kind === 'move')
      roots.push(request.action.destinationRoot)
    return this.#request({ type: 'mutate', request }, nativeOperationSchema, roots)
  }

  query(operationId: string) { return this.#request({ type: 'query', operationId }, nativeOperationSchema.nullable()) }
  history(root: string) { return this.#request({ type: 'history', root }, z.array(nativeOperationSchema), [root]) }
  protect(leaseId: string, claims: NativeFileProtection[]) { return this.#request({ type: 'protect', leaseId, claims }, z.null()) }
  acknowledge(root: string, operationId: string) { return this.#request({ type: 'acknowledge', root, operationId }, nativeOperationSchema, [root]) }
  cancel(operationId: string) { return this.#send(this.#connection, { type: 'cancel', operationId }, z.null()) }
  leases() { return this.#request({ type: 'leases' }, z.array(z.string())) }

  async release(leaseId: string, hazard = false) {
    const owner = this.#leases.get(leaseId)
    const connection = owner ?? this.#connection
    const relinquish = () => {
      if (this.#leases.get(leaseId) === owner)
        this.#leases.delete(leaseId)
    }
    try {
      await this.#send(connection, { type: 'release', leaseId, hazard }, z.null(), Boolean(owner))
    }
    catch (error) {
      if (!connection.failed) {
        if (error instanceof FileEngineError && error.responseReceived)
          relinquish()
        throw error
      }
      void connection.closed.promise.then(relinquish)
      await this.#waitForExit(connection)
    }
    relinquish()
    return null
  }

  async acquire(leaseId: string, claims: NativeFileClaim[], external = false, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const connection = await this.#connect()
    await this.#restoreRoots(connection, claims.map(claim => claim.root).filter(root => root !== '*'))
    signal?.throwIfAborted()
    if (this.#stopping)
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    if (this.#leases.has(leaseId))
      throw new FileEngineError('FILE_LEASE_INVALID')
    this.#leases.set(leaseId, connection)
    const cancel = () => {
      void this.release(leaseId).catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      await this.#send(connection, { type: 'acquire', leaseId, claims, external }, z.null())
      if (signal?.aborted) {
        await this.release(leaseId)
        signal.throwIfAborted()
      }
      if (this.#leases.get(leaseId) !== connection)
        throw new FileEngineError('FILE_OPERATION_CANCELLED')
    }
    catch (error) {
      if (this.#leases.get(leaseId) === connection)
        this.#leases.delete(leaseId)
      throw error
    }
    finally { signal?.removeEventListener('abort', cancel) }
  }

  dispose(): Promise<void> {
    this.#stopping = true
    this.#disposing ??= this.#dispose().catch((error) => {
      this.#disposing = undefined
      throw error
    })
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    const connection = this.#connection
    try {
      const shutdown = async () => {
        if (!connection.failed) {
          await this.#send(connection, { type: 'shutdown' }, z.null())
          connection.child.stdin.end()
        }
        await connection.closed.promise
      }
      try {
        await within(shutdown(), shutdownTimeout, 'FILE_ENGINE_STOP_TIMEOUT')
      }
      catch {
        this.#fail(connection)
        await this.#waitForExit(connection)
      }
    }
    finally { this.#events.dispose() }
  }

  #spawn(): FileEngineConnection {
    const env = Object.fromEntries(['SystemRoot', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []))
    const child = spawn(this.#executable, ['--serve', this.#directory], { env, windowsHide: true, stdio: 'pipe' })
    const connection: FileEngineConnection = {
      child,
      ready: Promise.withResolvers<void>(),
      closed: Promise.withResolvers<void>(),
      pending: new Map(),
      buffer: Buffer.alloc(0),
      failed: false,
      exited: false,
    }
    connection.startupTimer = setTimeout(() => this.#fail(connection), startupTimeout)
    child.stdout.on('data', (chunk: Buffer) => this.#receive(connection, chunk))
    child.stdout.on('error', () => this.#fail(connection))
    child.stdout.on('end', () => this.#fail(connection))
    child.stderr.resume()
    child.stdin.on('error', () => this.#fail(connection))
    child.on('error', () => this.#fail(connection))
    child.on('close', () => {
      connection.exited = true
      this.#fail(connection)
      const error = new FileEngineError('FILE_ENGINE_INTERRUPTED')
      for (const pending of connection.pending.values())
        pending.reject(error)
      connection.pending.clear()
      connection.buffer = Buffer.alloc(0)
      connection.closed.resolve()
    })
    void connection.ready.promise.catch(() => {})
    return connection
  }

  async #connect(): Promise<FileEngineConnection> {
    if (this.#stopping)
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    if (this.#starting)
      return this.#starting
    const connection = this.#connection
    if (!connection.failed) {
      await connection.ready.promise
      if (connection.failed)
        throw new FileEngineError('FILE_ENGINE_INTERRUPTED')
      if (this.#stopping)
        throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
      return connection
    }
    this.#starting = this.#restart(connection)
    try {
      return await this.#starting
    }
    finally { this.#starting = undefined }
  }

  async #restart(previous: FileEngineConnection): Promise<FileEngineConnection> {
    await this.#waitForExit(previous)
    if (this.#stopping)
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    if (this.#leases.size)
      throw new FileEngineError('FILE_ENGINE_ACTIVE_LEASES')
    const connection = this.#spawn()
    this.#connection = connection
    await connection.ready.promise
    if (connection.failed)
      throw new FileEngineError('FILE_ENGINE_INTERRUPTED')
    const roots = [...this.#roots].filter(([key, root]) => root.watch && !this.#revoked.has(key)).map(([key]) => key)
    if (roots.length)
      this.#events.fire({ event: 'changed', roots })
    return connection
  }

  #waitForExit(connection: FileEngineConnection): Promise<void> {
    return within(connection.closed.promise, terminationTimeout, 'FILE_ENGINE_STOP_TIMEOUT')
  }

  #rootQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.#rootQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(action)
    this.#rootQueues.set(key, result)
    void result.finally(() => {
      if (this.#rootQueues.get(key) === result)
        this.#rootQueues.delete(key)
    }).catch(() => {})
    return result
  }

  async #register(connection: FileEngineConnection, key: string, path: string, watch: boolean) {
    if (this.#stopping)
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    if (this.#revoked.has(key))
      throw new FileEngineError('FILE_PERMISSION_REVOKED')
    const previous = this.#roots.get(key)
    const result = await this.#send(connection, { type: 'register', key, path, watch: watch || previous?.watch === true }, nativeRootSchema)
    if (this.#revoked.has(key) || (previous && (previous.identity !== result.identity || previous.path !== result.path))) {
      this.#revoked.add(key)
      await this.#send(connection, { type: 'revoke', key }, z.null())
      throw new FileEngineError('FILE_PERMISSION_REVOKED')
    }
    this.#roots.set(key, { ...result, watch: watch || previous?.watch === true, connection })
    return result
  }

  async #restoreRoots(connection: FileEngineConnection, roots: string[]): Promise<void> {
    await Promise.all([...new Set(roots)].map(key => this.#rootQueue(key, async () => {
      if (this.#revoked.has(key))
        throw new FileEngineError('FILE_PERMISSION_REVOKED')
      const root = this.#roots.get(key)
      if (root && root.connection !== connection)
        await this.#register(connection, key, root.path, root.watch)
    })))
  }

  async #request<T>(command: object, schema: ZodType<T>, roots: string[] = []): Promise<T> {
    const connection = await this.#connect()
    await this.#restoreRoots(connection, roots)
    if (this.#stopping)
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    return this.#send(connection, command, schema)
  }

  async #send<T>(connection: FileEngineConnection, command: object, schema: ZodType<T>, releaseOwner = false): Promise<T> {
    if (connection.failed)
      throw new FileEngineError('FILE_ENGINE_INTERRUPTED')
    await connection.ready.promise
    if (connection.failed)
      throw new FileEngineError('FILE_ENGINE_INTERRUPTED')
    if (connection.pending.size >= 128 && !releaseOwner)
      throw new FileEngineError('FILE_ENGINE_BUSY')
    const id = ++this.#sequence
    const frame = `${JSON.stringify({ id, command })}\n`
    if (Buffer.byteLength(frame) > 128 * 1024 * 1024)
      throw new FileEngineError('FILE_INVALID_REQUEST')
    const value = await new Promise<unknown>((resolve, reject) => {
      connection.pending.set(id, { resolve, reject })
      try {
        connection.child.stdin.write(frame, error => error && this.#fail(connection))
      }
      catch { this.#fail(connection) }
    })
    try {
      return schema.parse(value)
    }
    catch {
      this.#fail(connection)
      await connection.closed.promise
      throw new FileEngineError('FILE_ENGINE_INTERRUPTED')
    }
  }

  #receive(connection: FileEngineConnection, chunk: Buffer): void {
    if (connection.failed || connection !== this.#connection)
      return
    connection.buffer = Buffer.concat([connection.buffer, chunk])
    if (connection.buffer.length > 128 * 1024 * 1024) {
      this.#fail(connection)
      return
    }
    for (let end = connection.buffer.indexOf(10); end !== -1; end = connection.buffer.indexOf(10)) {
      const frame = connection.buffer.subarray(0, end)
      connection.buffer = connection.buffer.subarray(end + 1)
      try {
        const value: unknown = JSON.parse(frame.toString('utf8'))
        const ready = z.object({ event: z.literal('ready'), version: z.literal(2) }).safeParse(value)
        if (ready.success) {
          clearTimeout(connection.startupTimer)
          connection.ready.resolve()
          continue
        }
        const notification = notificationSchema.safeParse(value)
        if (notification.success) {
          this.#events.fire(notification.data)
          continue
        }
        const response = z.object({ id: z.number().int(), result: z.unknown().optional(), error: z.string().optional() }).parse(value)
        const pending = connection.pending.get(response.id)
        if (!pending)
          throw new FileEngineError('FILE_PROTOCOL_FAILED')
        connection.pending.delete(response.id)
        if (response.error)
          pending.reject(new FileEngineError(response.error, true))
        else pending.resolve(response.result)
      }
      catch {
        this.#fail(connection)
        return
      }
    }
  }

  #fail(connection: FileEngineConnection): void {
    if (connection.failed)
      return
    connection.failed = true
    clearTimeout(connection.startupTimer)
    connection.ready.reject(new FileEngineError('FILE_ENGINE_INTERRUPTED'))
    if (!connection.exited)
      connection.child.kill('SIGKILL')
  }
}

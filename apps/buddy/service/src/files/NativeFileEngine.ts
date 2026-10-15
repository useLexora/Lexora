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
export interface NativeFileMutation { operationId: string, root: string, path: string, leaseId?: string, action: FileAction }
const nativeDocumentSchema = z.object({ text: z.string(), etag: z.string().length(64), identity: z.string() })
const notificationSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('changed'), roots: z.array(z.string()) }),
  z.object({ event: z.literal('operation'), operation: nativeOperationSchema }),
  z.object({ event: z.literal('progress'), operationId: z.string(), bytes: z.number() }),
])

class FileEngineError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'FileEngineError'
  }
}

export class NativeFileEngine {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #ready = Promise.withResolvers<void>()
  readonly #closed = Promise.withResolvers<void>()
  readonly #pending = new Map<number, { resolve: (value: unknown) => void, reject: (reason: Error) => void }>()
  readonly #events = new Emitter<z.infer<typeof notificationSchema>>(() => console.error('FILE_ENGINE_OBSERVER_FAILED'))
  readonly onDidChange = this.#events.event
  #sequence = 0
  #buffer = Buffer.alloc(0)
  #stopping = false
  #failed = false

  constructor(directory: string, executable = process.env.LEXORA_BUDDY_FILE_READER) {
    if (!executable)
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    const env = Object.fromEntries(['SystemRoot', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []))
    this.#child = spawn(executable, ['--serve', directory], { env, windowsHide: true, stdio: 'pipe' })
    this.#child.stdout.on('data', (chunk: Buffer) => this.#receive(chunk))
    this.#child.stderr.resume()
    this.#child.stdin.on('error', () => this.#fail())
    this.#child.on('error', () => this.#fail())
    this.#child.on('close', () => {
      this.#fail()
      this.#closed.resolve()
    })
    void this.#ready.promise.catch(() => {})
  }

  ready(): Promise<void> { return this.#ready.promise }

  register(key: string, path: string, watch = false) {
    return this.#request({ type: 'register', key, path, watch }, z.object({ identity: z.string(), path: z.string() }))
  }

  revoke(key: string) { return this.#request({ type: 'revoke', key }, z.null()) }
  list(root: string, path: string, cursor?: string) { return this.#request({ type: 'list', root, path, cursor }, directoryPageSchema) }
  read(root: string, path: string) { return this.#request({ type: 'read', root, path }, nativeDocumentSchema) }
  mutate(request: NativeFileMutation) { return this.#request({ type: 'mutate', request }, nativeOperationSchema) }
  query(operationId: string) { return this.#request({ type: 'query', operationId }, nativeOperationSchema.nullable()) }
  history(root: string) { return this.#request({ type: 'history', root }, z.array(nativeOperationSchema)) }
  acknowledge(operationId: string) { return this.#request({ type: 'acknowledge', operationId }, nativeOperationSchema) }
  cancel(operationId: string) { return this.#request({ type: 'cancel', operationId }, z.null()) }
  leases() { return this.#request({ type: 'leases' }, z.array(z.string())) }
  release(leaseId: string, hazard = false) { return this.#request({ type: 'release', leaseId, hazard }, z.null()) }

  async acquire(leaseId: string, claims: NativeFileClaim[], external = false, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const cancel = () => {
      void this.release(leaseId).catch(() => {})
    }
    const acquired = this.#request({ type: 'acquire', leaseId, claims, external }, z.null())
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      await acquired
      if (signal?.aborted) {
        await this.release(leaseId)
        signal.throwIfAborted()
      }
    }
    finally { signal?.removeEventListener('abort', cancel) }
  }

  async dispose(): Promise<void> {
    if (this.#stopping)
      return this.#closed.promise
    this.#stopping = true
    if (!this.#failed) {
      while (this.#pending.size)
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      await this.#request({ type: 'shutdown' }, z.null(), true).catch(() => {})
      this.#child.stdin.end()
    }
    await this.#closed.promise
    this.#events.dispose()
  }

  async #request<T>(command: object, schema: ZodType<T>, shutdown = false): Promise<T> {
    if (this.#failed || (this.#stopping && !shutdown))
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    await this.#ready.promise
    if (this.#failed)
      throw new FileEngineError('FILE_ENGINE_UNAVAILABLE')
    if (this.#pending.size >= 128)
      throw new FileEngineError('FILE_ENGINE_BUSY')
    const id = ++this.#sequence
    const frame = `${JSON.stringify({ id, command })}\n`
    if (Buffer.byteLength(frame) > 128 * 1024 * 1024)
      throw new FileEngineError('FILE_INVALID_REQUEST')
    const value = await new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#child.stdin.write(frame, error => error && this.#fail())
    })
    return schema.parse(value)
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    if (this.#buffer.length > 128 * 1024 * 1024) {
      this.#fail()
      this.#child.kill()
      return
    }
    for (let end = this.#buffer.indexOf(10); end !== -1; end = this.#buffer.indexOf(10)) {
      const frame = this.#buffer.subarray(0, end)
      this.#buffer = this.#buffer.subarray(end + 1)
      try {
        const value: unknown = JSON.parse(frame.toString('utf8'))
        const ready = z.object({ event: z.literal('ready'), version: z.literal(1) }).safeParse(value)
        if (ready.success) {
          this.#ready.resolve()
          continue
        }
        const notification = notificationSchema.safeParse(value)
        if (notification.success) {
          this.#events.fire(notification.data)
          continue
        }
        const response = z.object({ id: z.number().int(), result: z.unknown().optional(), error: z.string().optional() }).parse(value)
        const pending = this.#pending.get(response.id)
        if (!pending)
          throw new FileEngineError('FILE_PROTOCOL_FAILED')
        this.#pending.delete(response.id)
        if (response.error)
          pending.reject(new FileEngineError(response.error))
        else pending.resolve(response.result)
      }
      catch {
        this.#fail()
        this.#child.kill()
        return
      }
    }
  }

  #fail(): void {
    this.#failed = true
    const error = new FileEngineError('FILE_ENGINE_INTERRUPTED')
    this.#ready.reject(error)
    for (const pending of this.#pending.values())
      pending.reject(error)
    this.#pending.clear()
  }
}

import type { Hash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { z } from 'zod'
import type { ExtensionTransferredBuildResult } from '../../shared/extensions/extensionAuthoring'
import type { ExtensionCompiler } from './compileExtensionSource'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionTransferRequestSchema } from '../../shared/extensions/extensionAuthoring'
import { EXTENSION_ARCHIVE_LIMIT, EXTENSION_PACKAGE_CHUNK_BYTES } from '../../shared/extensions/extensionPackageBudget'
import { buildExtensionArchive } from './buildExtensionPackage'
import { readExtensionFile, sha256 } from './extensionFiles'

interface Transfer {
  root: string
  input: FileHandle
  size: number
  sha256: string
  hash: Hash
  offset: number
  readOffset: number
  state: 'uploading' | 'building' | 'ready'
  result?: Extract<ExtensionTransferredBuildResult, { ok: true }>
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  pending?: Promise<unknown>
}

type Request = z.infer<typeof extensionTransferRequestSchema>
export const EXTENSION_TRANSFER_IDLE_MS = 120000

export class ExtensionPackageTransfer {
  readonly #compile: ExtensionCompiler
  readonly #sessions = new Map<string, Transfer>()
  readonly #pending = new Set<Promise<unknown>>()
  readonly #lifetime = new AbortController()
  #starting = 0
  #building = false

  constructor(compile: ExtensionCompiler) {
    this.#compile = compile
  }

  request(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const operation = this.#request(input, signal)
    this.#pending.add(operation)
    void operation.finally(() => this.#pending.delete(operation)).catch(() => {})
    return operation
  }

  async dispose(): Promise<void> {
    this.#lifetime.abort()
    await Promise.allSettled([...this.#pending])
    await Promise.all([...this.#sessions.keys()].map(id => this.#release(id)))
  }

  async #request(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const abort = AbortSignal.any([this.#lifetime.signal, ...signal ? [signal] : []])
    abort.throwIfAborted()
    const request = extensionTransferRequestSchema.parse(input)
    if (request.action === 'begin')
      return this.#begin(request, abort)
    const session = this.#sessions.get(request.transferId)
    if (!session) {
      if (request.action === 'dispose')
        return null
      throw new Error('EXTENSION_TRANSFER_UNAVAILABLE')
    }
    if (request.action === 'dispose') {
      await this.#release(request.transferId)
      return null
    }
    if (session.pending)
      throw new Error('EXTENSION_TRANSFER_BUSY')
    const active = AbortSignal.any([abort, session.abort.signal])
    const pending = this.#perform(session, request, active)
    session.pending = pending
    try {
      const result = await pending
      active.throwIfAborted()
      if (request.action === 'build' && !(result as ExtensionTransferredBuildResult).ok)
        await this.#release(request.transferId)
      else
        this.#touch(request.transferId, session)
      return result
    }
    catch (error) {
      await this.#release(request.transferId)
      throw error
    }
    finally {
      session.pending = undefined
    }
  }

  async #begin(request: Extract<Request, { action: 'begin' }>, signal: AbortSignal) {
    if (this.#sessions.size + this.#starting >= 2)
      throw new Error('EXTENSION_TRANSFER_LIMIT')
    this.#starting++
    let root: string | undefined
    let input: FileHandle | undefined
    try {
      root = await mkdtemp(join(tmpdir(), 'lexora-package-'))
      input = await open(join(root, 'source.zip'), 'wx', 0o600)
      signal.throwIfAborted()
      const id = randomUUID()
      const session: Transfer = { root, input, size: request.size, sha256: request.sha256, hash: createHash('sha256'), offset: 0, readOffset: 0, state: 'uploading', abort: new AbortController(), timer: this.#timer(id) }
      this.#sessions.set(id, session)
      return { transferId: id }
    }
    catch (error) {
      await input?.close()
      if (root)
        await rm(root, { recursive: true, force: true })
      throw error
    }
    finally {
      this.#starting--
    }
  }

  async #perform(session: Transfer, request: Exclude<Request, { action: 'begin' | 'dispose' }>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (request.action === 'upload') {
      if (session.state !== 'uploading' || request.offset !== session.offset)
        throw new Error('EXTENSION_TRANSFER_ORDER')
      const bytes = Buffer.from(request.data, 'base64')
      if (!bytes.length || bytes.length > EXTENSION_PACKAGE_CHUNK_BYTES || bytes.toString('base64') !== request.data || session.offset + bytes.length > session.size)
        throw new Error('EXTENSION_TRANSFER_SIZE')
      await session.input.writeFile(bytes, { signal })
      session.hash.update(bytes)
      session.offset += bytes.length
      return { offset: session.offset }
    }
    if (request.action === 'read') {
      if (session.state !== 'ready' || !session.result || request.offset !== session.readOffset || request.offset >= session.result.package.size)
        throw new Error('EXTENSION_TRANSFER_ORDER')
      const handle = await open(join(session.root, 'package.zip'), 'r')
      try {
        const size = Math.min(EXTENSION_PACKAGE_CHUNK_BYTES, session.result.package.size - request.offset)
        const bytes = Buffer.alloc(size)
        let length = 0
        while (length < size) {
          signal.throwIfAborted()
          const read = await handle.read(bytes, length, size - length, request.offset + length)
          if (!read.bytesRead)
            throw new Error('EXTENSION_TRANSFER_SIZE')
          length += read.bytesRead
        }
        session.readOffset += size
        return { offset: session.readOffset, data: bytes.toString('base64') }
      }
      finally {
        await handle.close()
      }
    }
    if (session.state !== 'uploading' || session.offset !== session.size)
      throw new Error('EXTENSION_TRANSFER_INCOMPLETE')
    if (this.#building)
      throw new Error('EXTENSION_COMPILER_BUSY')
    if (session.hash.digest('hex') !== session.sha256)
      throw new Error('EXTENSION_TRANSFER_CHECKSUM_FAILED')
    session.state = 'building'
    this.#building = true
    try {
      await session.input.sync()
      const archive = await readExtensionFile(join(session.root, 'source.zip'), EXTENSION_ARCHIVE_LIMIT)
      if (archive.length !== session.size || sha256(archive) !== session.sha256)
        throw new Error('EXTENSION_TRANSFER_CHECKSUM_FAILED')
      const result = await buildExtensionArchive(archive, this.#compile, signal)
      signal.throwIfAborted()
      if (!result.ok)
        return result
      await writeFile(join(session.root, 'package.zip'), result.archive, { flag: 'wx', mode: 0o600, signal })
      const { archive: bytes, ...metadata } = result
      session.result = { ...metadata, package: { size: bytes.byteLength, sha256: sha256(bytes) } }
      session.state = 'ready'
      return session.result
    }
    finally {
      this.#building = false
    }
  }

  #timer(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const cleanup = this.#release(id)
      this.#pending.add(cleanup)
      void cleanup.finally(() => this.#pending.delete(cleanup)).catch(() => {})
    }, EXTENSION_TRANSFER_IDLE_MS)
    timer.unref()
    return timer
  }

  #touch(id: string, session: Transfer): void {
    clearTimeout(session.timer)
    session.timer = this.#timer(id)
  }

  async #release(id: string): Promise<void> {
    const session = this.#sessions.get(id)
    if (!session)
      return
    this.#sessions.delete(id)
    clearTimeout(session.timer)
    session.abort.abort()
    await session.pending?.catch(() => {})
    await session.input.close()
    await rm(session.root, { recursive: true, force: true })
  }
}

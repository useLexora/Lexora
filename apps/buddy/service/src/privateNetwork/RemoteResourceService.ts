import type { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import type { resourcePrepareSchema } from '../../../shared/privateNetwork/resources'
import type { ArtifactService } from '../artifacts/ArtifactService'
import type { TrustedCommandPrincipal } from '../commands/CommandAdmissionService'
import type { ProductReadViews } from '../productProtocol/ProductReadViews'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { PRIVATE_NETWORK_LIMITS as limits } from '../../../shared/privateNetwork/limits'
import { PrivateNetworkError } from '../../../shared/privateNetwork/pairing'
import { resourceDownloadSchema } from '../../../shared/privateNetwork/resources'
import { createAttachmentPersistenceRepository } from '../storage/attachmentPersistenceRepository'
import { createAttachmentRepository } from '../storage/attachmentRepository'
import { withTransaction } from '../storage/transaction'

interface ExportRow {
  id: string
  actor_id: string
  source_id: string
  source_version: string
  file_id: string
  path: string
  temporary_path: string | null
  size_bytes: number
  sha256: string | null
  name: string
  mime_type: string
  state: 'preparing' | 'ready' | 'expired' | 'failed'
  expires_ms: number
}
interface Options {
  database: DatabaseSync
  root: string
  instanceId: string
  views: (actorId: string) => ProductReadViews
  artifacts: Pick<ArtifactService, 'locate'>
}
export class RemoteResourceService {
  readonly #options: Options
  readonly #files: ReturnType<typeof createAttachmentPersistenceRepository>
  readonly #active = new Map<string, number>()
  readonly #operations = new Set<Promise<unknown>>()
  readonly #reviews = new Map<string, number>()
  readonly #controllers = new Set<AbortController>()
  readonly #timer: ReturnType<typeof setInterval>
  #preparing = 0
  #streams = 0
  #closed = false

  constructor(options: Options) {
    this.#options = options
    this.#files = createAttachmentPersistenceRepository(options.database)
    options.database.prepare('UPDATE remote_exports SET state = \'failed\' WHERE state = \'preparing\'').run()
    this.sweep()
    this.#timer = setInterval(() => {
      try {
        this.sweep()
      }
      catch {}
    }, 1000)
    this.#timer.unref()
  }

  hasReview(actorId: string, approvalId: string, version: string): boolean {
    return (this.#reviews.get(`${actorId}:review:${approvalId}:${version}`) ?? 0) > this.#now()
  }

  prepare(input: z.infer<typeof resourcePrepareSchema>, principal: TrustedCommandPrincipal) {
    if (this.#closed || this.#preparing >= limits.resourceStreams)
      return Promise.reject(new PrivateNetworkError('LIMIT_EXCEEDED'))
    this.#preparing++
    const operation = this.#prepare(input, principal).finally(() => {
      this.#preparing--
      this.#operations.delete(operation)
    })
    this.#operations.add(operation)
    return operation
  }

  bytes(request: IncomingMessage, response: ServerResponse, principal: TrustedCommandPrincipal): Promise<boolean> {
    const operation = this.#bytes(request, response, principal).finally(() => this.#operations.delete(operation))
    this.#operations.add(operation)
    return operation
  }

  async #bytes(request: IncomingMessage, response: ServerResponse, principal: TrustedCommandPrincipal): Promise<boolean> {
    const match = /^\/v1\/resources\/([\w-]{1,128})$/.exec(request.url ?? '')
    if (!match)
      return false
    if (!['GET', 'HEAD'].includes(request.method ?? ''))
      throw new PrivateNetworkError('INVALID_REQUEST')
    if (this.#closed || this.#streams >= limits.resourceStreams)
      throw new PrivateNetworkError('LIMIT_EXCEEDED')
    const id = match[1]!
    const row = this.#row(id)
    this.#authorize(row, principal)
    if (row.state !== 'ready' || row.expires_ms <= this.#now() || !row.sha256)
      throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
    if (request.headers['if-match'] !== `"${row.sha256}"`)
      throw new PrivateNetworkError('VERSION_CHANGED')
    let start = 0
    let end = row.size_bytes - 1
    if (request.headers.range) {
      const range = /^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)?$/.exec(request.headers.range)
      if (!range)
        throw new PrivateNetworkError('RANGE_INVALID')
      start = Number(range[1])
      end = range[2] === undefined ? end : Number(range[2])
      if (![start, end].every(Number.isSafeInteger) || start > end || end >= row.size_bytes)
        throw new PrivateNetworkError('RANGE_INVALID')
    }
    this.#streams++
    this.#active.set(id, (this.#active.get(id) ?? 0) + 1)
    const controller = new AbortController()
    this.#controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 60_000)
    const disconnect = () => {
      if (!response.writableFinished)
        controller.abort()
    }
    response.once('close', disconnect)
    const authorization = setInterval(() => {
      try {
        this.#authorize(row, principal)
      }
      catch { controller.abort() }
    }, 250)
    let source: Awaited<ReturnType<typeof open>> | undefined
    try {
      if (row.source_id.startsWith('artifact:'))
        await this.#options.artifacts.locate(row.source_id.slice('artifact:'.length))
      source = await open(row.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = await source.stat()
      if (!before.isFile() || before.size !== row.size_bytes)
        throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
      const hash = createHash('sha256')
      for await (const bytes of source.createReadStream({ autoClose: false, start: 0, signal: controller.signal })) hash.update(bytes)
      if (hash.digest('hex') !== row.sha256) {
        this.#files.unavailable(row.path)
        throw new PrivateNetworkError('VERSION_CHANGED')
      }
      this.#authorize(row, principal)
      response.setHeader('Content-Type', row.mime_type)
      response.setHeader('Content-Disposition', `attachment; filename="resource"; filename*=UTF-8''${encodeURIComponent(row.name)}`)
      response.setHeader('ETag', `"${row.sha256}"`)
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader('Content-Length', Math.max(0, end - start + 1))
      if (request.headers.range) {
        response.statusCode = 206
        response.setHeader('Content-Range', `bytes ${start}-${end}/${row.size_bytes}`)
      }
      if (request.method === 'HEAD' || !row.size_bytes)
        response.end()
      else await pipeline(source.createReadStream({ autoClose: false, start, end }), response, { signal: controller.signal })
      if (request.method === 'GET' && start === 0 && end === row.size_bytes - 1 && row.source_id.startsWith('review:')) {
        if (this.#reviews.size >= 128)
          this.#reviews.delete(this.#reviews.keys().next().value!)
        this.#reviews.set(`${principal.actorId}:${row.source_id}`, row.expires_ms)
      }
    }
    finally {
      await source?.close()
      this.#controllers.delete(controller)
      clearTimeout(timeout)
      clearInterval(authorization)
      response.off('close', disconnect)
      this.#streams--
      const remaining = this.#active.get(id)! - 1
      if (remaining)
        this.#active.set(id, remaining)
      else this.#active.delete(id)
      this.sweep()
    }
    return true
  }

  sweep(): void {
    const { database } = this.#options
    withTransaction(database, () => {
      database.prepare(`UPDATE remote_exports SET state = 'expired' WHERE state IN ('preparing','ready') AND
        (expires_ms <= ? OR data_generation <> (SELECT data_generation FROM storage_profile WHERE id = 1)
          OR NOT EXISTS (SELECT 1 FROM storage_actors a WHERE a.id = actor_id AND a.state = 'active')
          OR EXISTS (SELECT 1 FROM remote_devices d WHERE d.id = actor_id AND (d.state <> 'active' OR d.grant_generation <> remote_exports.grant_generation)))`).run(this.#now())
      for (const entry of database.prepare(`SELECT id FROM remote_exports e WHERE state IN ('expired','failed') AND (
        EXISTS (SELECT 1 FROM file_references f WHERE f.kind = 'export' AND f.owner_id = e.id)
        OR EXISTS (SELECT 1 FROM file_preparations p WHERE p.id = e.file_id AND p.state IN ('preparing','published'))) LIMIT 128`).all()) {
        const id = String(entry.id)
        if (this.#active.has(id))
          continue
        const row = this.#row(id)
        this.#files.releaseReference({ kind: 'export', ownerId: id, bindingId: id })
        this.#files.settle([row.path], 'rollback')
      }
    })
    for (const [id, expires] of this.#reviews) {
      if (expires <= this.#now())
        this.#reviews.delete(id)
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    for (const controller of this.#controllers) controller.abort()
    await Promise.allSettled(this.#operations)
  }

  async #prepare(input: z.infer<typeof resourcePrepareSchema>, principal: TrustedCommandPrincipal) {
    this.sweep()
    principal.assertAuthenticated()
    const { database } = this.#options
    const views = this.#options.views(principal.actorId)
    const resource = views.resource(input.resourceId)
    if (!resource || resource.availability === 'unavailable')
      throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
    if (resource.revision !== input.expectedVersion)
      throw new PrivateNetworkError('VERSION_CHANGED')
    const size = Number(resource.sizeBytes)
    if (!Number.isSafeInteger(size) || size > limits.uploadBytes)
      throw new PrivateNetworkError('LIMIT_EXCEEDED')
    const directory = join(this.#options.root, 'managed-files', 'exports')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const capacity = await statfs(directory)
    const available = Math.min(Number.MAX_SAFE_INTEGER, capacity.bavail * capacity.bsize)
    const id = randomUUID()
    const isAttachment = input.resourceId.startsWith('attachment:')
    const selected = isAttachment ? createAttachmentRepository(database).findVisibleById(input.resourceId.slice('attachment:'.length)) : null
    let sourcePath: string | undefined
    let document: ReturnType<ProductReadViews['document']>
    if (input.resourceId.startsWith('artifact:')) {
      const location = await this.#options.artifacts.locate(input.resourceId.slice('artifact:'.length))
      if (location.kind !== 'file')
        throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
      sourcePath = location.path
    }
    else if (!isAttachment) {
      document = views.document(input.resourceId)
      if (!document || document.revision !== input.expectedVersion || document.bytes.length !== size)
        throw new PrivateNetworkError('VERSION_CHANGED')
    }
    const row = withTransaction(database, () => {
      principal.assertAuthenticated()
      if (views.resource(input.resourceId)?.revision !== input.expectedVersion)
        throw new PrivateNetworkError('VERSION_CHANGED')
      const totals = database.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes, COALESCE(SUM(actor_id = ?),0) AS count FROM remote_exports WHERE state IN (\'preparing\',\'ready\')').get(principal.actorId)!
      if (Number(totals.count) >= limits.resourceStreams || Number(totals.bytes) + size > limits.uploadReservedBytes)
        throw new PrivateNetworkError('LIMIT_EXCEEDED')
      const file = selected ? this.#files.get(selected.storedPath)! : this.#files.prepare({ actorId: principal.actorId, operationId: id, availableBytes: available, stagingDirectory: join(directory, 'staging'), ownerInstance: this.#options.instanceId, kind: 'export', targetOwnerId: id, path: join(directory, id), sizeBytes: size })
      if (selected && (!file || file.state !== 'ready' || file.sha256 !== input.expectedVersion))
        throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
      const generation = database.prepare('SELECT data_generation FROM storage_profile WHERE id = 1').get()!.data_generation
      const grant = Number(database.prepare('SELECT grant_generation FROM remote_devices WHERE id = ?').get(principal.actorId)?.grant_generation ?? 0)
      database.prepare(`INSERT INTO remote_exports (id,actor_id,data_generation,grant_generation,source_id,source_version,file_id,name,mime_type,size_bytes,state,expires_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, principal.actorId, generation, grant, input.resourceId, input.expectedVersion, file.id, resource.name, resource.mimeType, size, selected ? 'ready' : 'preparing', this.#now() + limits.resourceLifetimeMs)
      if (selected)
        this.#files.reference(file.id, { kind: 'export', ownerId: id, bindingId: id })
      return this.#row(id)
    })
    this.#active.set(id, 1)
    try {
      if (!selected) {
        await mkdir(dirname(row.temporary_path!), { recursive: true, mode: 0o700 })
        const digest = sourcePath ? await snapshotFile(sourcePath, row.temporary_path!, size, () => principal.assertAuthenticated()) : await snapshotDocument(document!.bytes, row.temporary_path!)
        principal.assertAuthenticated()
        if (sourcePath && (await this.#options.artifacts.locate(input.resourceId.slice('artifact:'.length))).path !== sourcePath)
          throw new PrivateNetworkError('VERSION_CHANGED')
        await fileStorage.replace(row.temporary_path!, row.path)
        await fileStorage.syncDirectory(dirname(row.path))
        await fileStorage.syncDirectory(dirname(row.temporary_path!))
        withTransaction(database, () => {
          this.#authorize(row, principal)
          if (this.#row(id).state !== 'preparing' || views.resource(input.resourceId)?.revision !== input.expectedVersion)
            throw new PrivateNetworkError('VERSION_CHANGED')
          this.#files.publish(row.path, { sizeBytes: size, sha256: digest, durability: fileStorage.durability })
          this.#files.reference(row.file_id, { kind: 'export', ownerId: id, bindingId: id })
          this.#files.settle([row.path], 'commit')
          database.prepare('UPDATE remote_exports SET state = \'ready\' WHERE id = ?').run(id)
        })
      }
      const current = this.#row(id)
      return resourceDownloadSchema.parse({ downloadId: id, resourceId: current.source_id, contentVersion: current.sha256, sizeBytes: String(size), mimeType: current.mime_type, name: current.name, expiresAt: new Date(current.expires_ms).toISOString() })
    }
    catch (error) {
      withTransaction(database, () => database.prepare('UPDATE remote_exports SET state = \'failed\' WHERE id = ? AND state = \'preparing\'').run(id))
      throw error
    }
    finally {
      this.#active.delete(id)
      this.sweep()
    }
  }

  #authorize(row: ExportRow, principal: TrustedCommandPrincipal) {
    principal.assertAuthenticated()
    if (row.actor_id !== principal.actorId)
      throw new PrivateNetworkError('NOT_AUTHORIZED')
    if (row.expires_ms <= this.#now())
      throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
    if (!this.#options.views(principal.actorId).resource(row.source_id))
      throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
  }

  #row(id: string): ExportRow {
    const row = this.#options.database.prepare('SELECT e.*, f.path, f.temporary_path, f.sha256 FROM remote_exports e JOIN managed_files f ON f.id = e.file_id WHERE e.id = ?').get(id)
    if (!row)
      throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
    return row as unknown as ExportRow
  }

  #now() { return Math.max(Date.now(), Number(this.#options.database.prepare('SELECT last_observed_ms FROM private_network_state WHERE id = 1').get()!.last_observed_ms)) }
}

async function snapshotDocument(bytes: Buffer, path: string) {
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600, flush: true })
  return createHash('sha256').update(bytes).digest('hex')
}
async function snapshotFile(source: string, target: string, size: number, assertCurrent: () => void) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await input.stat()
    if (!before.isFile() || before.size !== size)
      throw new PrivateNetworkError('VERSION_CHANGED')
    const output = await open(target, 'wx', 0o600)
    const hash = createHash('sha256')
    let position = 0
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        assertCurrent()
        if (position + chunk.length > size)
          throw new PrivateNetworkError('VERSION_CHANGED')
        hash.update(chunk)
        let written = 0
        while (written < chunk.length) {
          const result = await output.write(chunk, written, chunk.length - written, position + written)
          if (!result.bytesWritten)
            throw new PrivateNetworkError('STORAGE_UNAVAILABLE')
          written += result.bytesWritten
        }
        position += chunk.length
      }
      const after = await input.stat()
      const current = await stat(source)
      if (position !== size || after.mtimeMs !== before.mtimeMs || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs)
        throw new PrivateNetworkError('VERSION_CHANGED')
      await output.sync()
    }
    finally { await output.close() }
    return hash.digest('hex')
  }
  finally { await input.close() }
}

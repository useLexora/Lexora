import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { SubmittedInput } from '../../../shared/conversation/submittedInput'
import type { UploadCommandMethod } from '../../../shared/privateNetwork/uploads'
import type { ComposerDraftService } from '../chat/ComposerDraftService'
import type { CommandAdmissionService, TrustedCommandPrincipal } from '../commands/CommandAdmissionService'
import type { InputCommandIntent } from '../commands/commandIntent'
import type { CommandDecision } from '../storage/CommandCommitter'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import { BUDDY_ATTACHMENT_COUNT_LIMIT, BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT } from '../../../shared/conversation/attachmentPolicy'
import { getBuddyUserContentResourceIds } from '../../../shared/conversation/buddyUserContent'
import { PRIVATE_NETWORK_LIMITS as limits } from '../../../shared/privateNetwork/limits'
import { PrivateNetworkError } from '../../../shared/privateNetwork/pairing'
import { uploadDigestSchema, uploadStateSchema } from '../../../shared/privateNetwork/uploads'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { validateResourceBytes } from '../attachments/validateResourceBytes'
import { inputResourceOwner } from '../chat/resolveChatInput'
import { createAttachmentPersistenceRepository } from '../storage/attachmentPersistenceRepository'
import { createAttachmentRepository } from '../storage/attachmentRepository'
import { findPersonalComposerDraft } from '../storage/composerDraftRepository'
import { createComposerResourceRepository } from '../storage/composerResourceRepository'
import { afterTransactionCommit, withTransaction } from '../storage/transaction'
import { validateDocumentBytes } from './uploadValidation'

interface UploadRow {
  id: string
  actor_id: string
  data_generation: string
  grant_generation: number
  input_id: string | null
  draft_id: string
  expected_revision: number
  file_id: string
  path: string
  temporary_path: string
  name: string
  mime_type: string
  size_bytes: number
  sha256: string
  state: 'receiving' | 'ready' | 'adopted' | 'cancelled' | 'expired' | 'failed'
  confirmed_bytes: number
  resource_id: string
  attachment_id: string
  expires_ms: number
}
interface Options { database: DatabaseSync, root: string, instanceId: string, drafts: Pick<ComposerDraftService, 'withDraftLock' | 'notifyCommitted'> }
export class RemoteUploadService {
  readonly #options: Options
  readonly #files: ReturnType<typeof createAttachmentPersistenceRepository>
  readonly #busy = new Map<string, Promise<unknown>>()
  readonly #verified = new Set<string>()
  readonly #timer: ReturnType<typeof setInterval>
  #closed = false

  constructor(options: Options) {
    this.#options = options
    this.#files = createAttachmentPersistenceRepository(options.database)
    this.sweep()
    this.#timer = setInterval(() => {
      try {
        this.sweep()
      }
      catch {}
    }, 1000)
    this.#timer.unref()
  }

  commands(principal: TrustedCommandPrincipal, admission: CommandAdmissionService) {
    return {
      execute: (method: UploadCommandMethod, input: unknown) => admission.execute(method, input, {
        scope: (intent, operation) => {
          const run = () => 'uploadId' in intent ? this.#exclusive(intent.uploadId, operation) : operation()
          return 'draftId' in intent ? this.#options.drafts.withDraftLock(intent.draftId, run) : run()
        },
        prepare: async intent => this.#prepare(method, intent, principal),
        commit: prepared => prepared(),
        reject: error => error instanceof ProductProtocolError && ['DRAFT_CONFLICT', 'RESOURCE_UNAVAILABLE'].includes(error.code)
          ? { errorCode: error.code as 'DRAFT_CONFLICT' | 'RESOURCE_UNAVAILABLE', target: {}, result: {} }
          : null,
      }),
      get: async (uploadId: string) => this.#exclusive(uploadId, async () => {
        const row = this.#owned(uploadId, principal)
        if (row.state === 'receiving')
          await this.#recover(row)
        return this.#view(this.#owned(uploadId, principal))
      }),
    }
  }

  async bytes(request: IncomingMessage, response: ServerResponse, principal: TrustedCommandPrincipal): Promise<boolean> {
    const match = /^\/v1\/uploads\/([\w-]{1,128})$/.exec(request.url ?? '')
    if (!match)
      return false
    if (request.method !== 'PUT')
      throw new PrivateNetworkError('INVALID_REQUEST')
    const id = match[1]!
    await this.#exclusive(id, async () => {
      const row = this.#owned(id, principal)
      if (row.state !== 'receiving')
        throw new PrivateNetworkError('UPLOAD_CONFLICT')
      const range = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(String(request.headers['content-range'] ?? ''))
      const digest = uploadDigestSchema.safeParse(request.headers['x-content-sha256'])
      if (!range || !digest.success)
        throw new PrivateNetworkError('INVALID_REQUEST')
      const [start, end, total] = range.slice(1).map(Number) as [number, number, number]
      const length = end - start + 1
      if (![start, end, total].every(Number.isSafeInteger) || total !== row.size_bytes || start < 0 || end >= total || length <= 0 || length > limits.uploadChunkBytes || String(length) !== request.headers['content-length'])
        throw new PrivateNetworkError('RANGE_INVALID')
      if (start > row.confirmed_bytes)
        throw new PrivateNetworkError('UPLOAD_CONFLICT')
      const bytes = await readChunk(request, length)
      if (createHash('sha256').update(bytes).digest('hex') !== digest.data)
        throw new PrivateNetworkError('UPLOAD_CONFLICT')
      await this.#recover(row)
      this.#owned(id, principal)
      if (start < row.confirmed_bytes) {
        const old = this.#options.database.prepare('SELECT length, sha256 FROM remote_upload_chunks WHERE upload_id = ? AND start = ?').get(id, start)
        if (old?.length !== length || old.sha256 !== digest.data)
          throw new PrivateNetworkError('UPLOAD_CONFLICT')
      }
      else {
        const file = await open(row.temporary_path, 'r+')
        try {
          let written = 0
          while (written < bytes.length) {
            const result = await file.write(bytes, written, bytes.length - written, start + written)
            if (!result.bytesWritten)
              throw new PrivateNetworkError('STORAGE_UNAVAILABLE')
            written += result.bytesWritten
          }
          await file.sync()
        }
        finally { await file.close() }
        withTransaction(this.#options.database, () => {
          if (this.#owned(id, principal).state !== 'receiving')
            throw new PrivateNetworkError('UPLOAD_CONFLICT')
          this.#options.database.prepare('INSERT INTO remote_upload_chunks (upload_id, start, length, sha256) VALUES (?, ?, ?, ?)').run(id, start, length, digest.data)
          this.#options.database.prepare('UPDATE remote_uploads SET confirmed_bytes = ? WHERE id = ? AND confirmed_bytes = ?').run(end + 1, id, start)
        })
      }
      principal.assertAuthenticated()
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ uploadId: id, confirmedBytes: this.#row(id).confirmed_bytes }))
    })
    return true
  }

  sweep(): void {
    const { database } = this.#options
    withTransaction(database, () => {
      database.prepare(`UPDATE remote_uploads SET state = CASE WHEN expires_ms <= ? THEN 'expired' ELSE 'cancelled' END
        WHERE state IN ('receiving', 'ready') AND (expires_ms <= ?
          OR data_generation <> (SELECT data_generation FROM storage_profile WHERE id = 1)
          OR NOT EXISTS (SELECT 1 FROM storage_actors a WHERE a.id = actor_id AND a.state = 'active')
          OR EXISTS (SELECT 1 FROM remote_devices d WHERE d.id = actor_id AND (d.state <> 'active' OR d.grant_generation <> remote_uploads.grant_generation)))`).run(this.#now(), this.#now())
      for (const row of database.prepare('SELECT id FROM remote_uploads u WHERE state IN (\'cancelled\',\'expired\',\'failed\') AND (EXISTS (SELECT 1 FROM file_preparations p WHERE p.id = u.file_id AND p.state IN (\'preparing\',\'published\')) OR EXISTS (SELECT 1 FROM file_references f WHERE f.kind = \'export\' AND f.owner_id = u.id)) LIMIT 128').all()) {
        if (!this.#busy.has(String(row.id)))
          this.#release(this.#row(String(row.id)))
      }
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    await Promise.allSettled(this.#busy.values())
  }

  async #prepare(method: UploadCommandMethod, input: InputCommandIntent<UploadCommandMethod>, principal: TrustedCommandPrincipal): Promise<() => CommandDecision> {
    principal.assertAuthenticated()
    const { database } = this.#options
    if (method === 'uploads.create' || method === 'uploads.stage') {
      const source = input as InputCommandIntent<'uploads.create' | 'uploads.stage'>
      const inputId = 'inputId' in source ? source.inputId : null
      const intent = 'draftId' in source ? source : { draftId: inputResourceOwner(principal.actorId, source.inputId), expectedRevision: 0, file: source.file }
      if (!inputId)
        this.#draft(intent.draftId, intent.expectedRevision, principal)
      const directory = join(this.#options.root, 'managed-files', 'remote')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const capacity = await statfs(directory)
      const available = Math.min(Number.MAX_SAFE_INTEGER, capacity.bavail * capacity.bsize)
      return (): CommandDecision => {
        this.sweep()
        if (!inputId)
          this.#draft(intent.draftId, intent.expectedRevision, principal)
        const totals = database.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes, COALESCE(SUM(actor_id = ? AND (state = \'receiving\' OR input_id IS NULL)),0) AS count FROM remote_uploads WHERE state IN (\'receiving\',\'ready\')').get(principal.actorId)!
        if (Number(totals.bytes) + intent.file.sizeBytes > limits.uploadReservedBytes || Number(totals.count) >= limits.uploadsPerDevice)
          throw new PrivateNetworkError('LIMIT_EXCEEDED')
        const id = randomUUID()
        const file = this.#files.prepare({ actorId: principal.actorId, operationId: id, availableBytes: available, stagingDirectory: join(directory, 'staging'), ownerInstance: this.#options.instanceId, kind: 'import', targetOwnerId: intent.draftId, path: join(directory, id), sizeBytes: intent.file.sizeBytes })
        const generation = database.prepare('SELECT data_generation FROM storage_profile WHERE id = 1').get()!.data_generation
        const grant = Number(database.prepare('SELECT grant_generation FROM remote_devices WHERE id = ?').get(principal.actorId)?.grant_generation ?? 0)
        database.prepare(`INSERT INTO remote_uploads (id,actor_id,data_generation,grant_generation,draft_id,expected_revision,file_id,name,mime_type,size_bytes,sha256,state,resource_id,attachment_id,created_ms,expires_ms,input_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'receiving',?,?,?,?,?)`).run(id, principal.actorId, generation, grant, intent.draftId, intent.expectedRevision, file.id, intent.file.name, intent.file.mimeType, intent.file.sizeBytes, intent.file.sha256, randomUUID(), randomUUID(), this.#now(), this.#now() + limits.uploadLifetimeMs, inputId)
        return { target: { uploadId: id, draftId: intent.draftId }, result: { uploadId: id } }
      }
    }
    const intent = input as InputCommandIntent<'uploads.complete' | 'uploads.cancel' | 'uploads.adopt'>
    const row = this.#owned(intent.uploadId, principal)
    if (method === 'uploads.cancel') {
      return (): CommandDecision => {
        const current = this.#owned(row.id, principal)
        if (current.state === 'receiving' || current.state === 'ready')
          database.prepare('UPDATE remote_uploads SET state = \'cancelled\' WHERE id = ?').run(row.id)
        return { target: { uploadId: row.id }, result: { cancelled: current.state !== 'adopted' } }
      }
    }
    if (method === 'uploads.complete') {
      if (row.state === 'receiving') {
        if (row.confirmed_bytes !== row.size_bytes)
          throw new PrivateNetworkError('UPLOAD_CONFLICT')
        await this.#recover(row)
        const path = await exists(row.path) ? row.path : row.temporary_path
        if (await hashFile(path) !== row.sha256) {
          this.#fail(row.id)
          throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
        }
        if (isDocumentMimeType(row.mime_type))
          await validateDocumentBytes(path, row.mime_type)
        else await validateResourceBytes({ mimeType: row.mime_type, sizeBytes: row.size_bytes }, await readFile(path))
        this.#owned(row.id, principal)
        if (path !== row.path) {
          await fileStorage.replace(path, row.path)
          await fileStorage.syncDirectory(dirname(row.path))
          await fileStorage.syncDirectory(dirname(path))
        }
      }
      return (): CommandDecision => {
        const current = this.#owned(row.id, principal)
        if (current.state === 'receiving') {
          this.#files.publish(row.path, { sizeBytes: row.size_bytes, sha256: row.sha256, durability: fileStorage.durability })
          this.#files.reference(row.file_id, { kind: 'export', ownerId: row.id, bindingId: row.id })
          this.#files.settle([row.path], 'commit')
          if (row.input_id)
            this.#registerResource(row)
          database.prepare('UPDATE remote_uploads SET state = \'ready\' WHERE id = ?').run(row.id)
        }
        else if (current.state !== 'ready' && current.state !== 'adopted') {
          throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
        }
        return { target: { uploadId: row.id }, result: { resourceId: row.resource_id, contentVersion: row.sha256 } }
      }
    }
    const adoption = input as InputCommandIntent<'uploads.adopt'>
    return (): CommandDecision => {
      const current = this.#owned(row.id, principal)
      if (current.state !== 'ready')
        throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
      if (row.input_id || adoption.draftId !== row.draft_id)
        throw new ProductProtocolError('DRAFT_CONFLICT')
      this.#draft(adoption.draftId, adoption.expectedRevision, principal)
      const totals = database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM composer_resources WHERE draft_id = ?').get(row.draft_id)!
      if (Number(totals.count) >= BUDDY_ATTACHMENT_COUNT_LIMIT || Number(totals.bytes) + row.size_bytes > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT)
        throw new PrivateNetworkError('LIMIT_EXCEEDED')
      const now = new Date().toISOString()
      this.#registerResource(row)
      database.prepare('UPDATE composer_drafts SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, row.draft_id)
      database.prepare('UPDATE remote_uploads SET state = \'adopted\' WHERE id = ?').run(row.id)
      this.#files.releaseReference({ kind: 'export', ownerId: row.id, bindingId: row.id })
      const draft = findPersonalComposerDraft(database, row.draft_id)!
      afterTransactionCommit(database, () => this.#options.drafts.notifyCommitted('saved', draft), () => {})
      return { target: { uploadId: row.id, draftId: row.draft_id }, result: { resourceId: row.resource_id, attachmentId: row.attachment_id, contentVersion: row.sha256, revision: draft.revision } }
    }
  }

  #registerResource(row: UploadRow) {
    const database = this.#options.database
    const totals = database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM composer_resources WHERE draft_id = ?').get(row.draft_id)!
    if (Number(totals.count) >= BUDDY_ATTACHMENT_COUNT_LIMIT || Number(totals.bytes) + row.size_bytes > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT)
      throw new PrivateNetworkError('LIMIT_EXCEEDED')
    const now = new Date().toISOString()
    createAttachmentRepository(database).create({ id: row.attachment_id, draftId: row.draft_id, messageId: null, conversationId: null, storedPath: row.path, name: row.name, mimeType: row.mime_type, sizeBytes: row.size_bytes, createdAt: now })
    const resources = createComposerResourceRepository(database)
    resources.accept(row.draft_id, [{ resourceId: row.resource_id, name: row.name, mimeType: row.mime_type, sizeBytes: row.size_bytes }], now)
    resources.finish({ resourceId: row.resource_id, draftId: row.draft_id, attachmentId: row.attachment_id, contentHash: row.sha256, now })
  }

  commitInput(principal: TrustedCommandPrincipal, input: SubmittedInput): void {
    principal.assertAuthenticated()
    const database = this.#options.database
    const owner = inputResourceOwner(principal.actorId, input.inputId)
    for (const resourceId of getBuddyUserContentResourceIds(input.content)) {
      const row = database.prepare('SELECT id, state FROM remote_uploads WHERE actor_id = ? AND input_id = ? AND resource_id = ?').get(principal.actorId, input.inputId, resourceId)
      if (!row)
        continue
      if (row.state !== 'ready')
        throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
      database.prepare('UPDATE remote_uploads SET state = \'adopted\' WHERE id = ?').run(row.id)
      createComposerResourceRepository(database).remove(owner, [resourceId])
      this.#files.releaseReference({ kind: 'export', ownerId: String(row.id), bindingId: String(row.id) })
    }
  }

  #draft(id: string, revision: number, principal: TrustedCommandPrincipal) {
    principal.assertAuthenticated()
    const row = this.#options.database.prepare('SELECT revision FROM composer_drafts WHERE id = ? AND owner_actor_id = ?').get(id, principal.actorId)
    if (!row || row.revision !== revision)
      throw new ProductProtocolError('DRAFT_CONFLICT')
  }

  #row(id: string): UploadRow {
    const row = this.#options.database.prepare('SELECT u.*, f.path, f.temporary_path FROM remote_uploads u JOIN managed_files f ON f.id = u.file_id WHERE u.id = ?').get(id)
    if (!row)
      throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
    return row as unknown as UploadRow
  }

  #owned(id: string, principal: TrustedCommandPrincipal): UploadRow {
    principal.assertAuthenticated()
    const row = this.#row(id)
    if (row.actor_id !== principal.actorId)
      throw new ProductProtocolError('NOT_AUTHORIZED')
    if (row.expires_ms <= this.#now() && ['receiving', 'ready'].includes(row.state)) {
      this.sweep()
      return this.#row(id)
    }
    return row
  }

  #view(row: UploadRow) {
    return uploadStateSchema.parse({ uploadId: row.id, ...(row.input_id ? { inputId: row.input_id } : {}), draftId: row.draft_id, expectedRevision: String(row.expected_revision), state: row.state, confirmedBytes: row.confirmed_bytes, sizeBytes: row.size_bytes, sha256: row.sha256, expiresAt: new Date(row.expires_ms).toISOString(), resourceId: ['ready', 'adopted'].includes(row.state) ? row.resource_id : null, contentVersion: ['ready', 'adopted'].includes(row.state) ? row.sha256 : null, attachmentId: row.state === 'adopted' || (row.input_id && row.state === 'ready') ? row.attachment_id : null })
  }

  async #recover(row: UploadRow) {
    if (this.#verified.has(row.id))
      return
    await mkdir(dirname(row.temporary_path), { recursive: true, mode: 0o700 })
    const path = await exists(row.path) ? row.path : row.temporary_path
    if (!await exists(path)) {
      if (row.confirmed_bytes) {
        this.#fail(row.id)
        throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
      }
      const file = await open(path, 'wx', 0o600)
      try {
        await file.sync()
      }
      finally { await file.close() }
      await fileStorage.syncDirectory(dirname(path))
    }
    if ((await stat(path)).size < row.confirmed_bytes) {
      this.#fail(row.id)
      throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
    }
    let position = 0
    for (const chunk of this.#options.database.prepare('SELECT start, length, sha256 FROM remote_upload_chunks WHERE upload_id = ? ORDER BY start').all(row.id)) {
      if (Number(chunk.start) !== position || await hashFile(path, position, Number(chunk.length)) !== chunk.sha256) {
        this.#fail(row.id)
        throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
      }
      position += Number(chunk.length)
    }
    if (position !== row.confirmed_bytes) {
      this.#fail(row.id)
      throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
    }
    const file = await open(path, 'r+')
    try {
      await file.truncate(row.confirmed_bytes)
      await file.sync()
    }
    finally { await file.close() }
    this.#verified.add(row.id)
  }

  #fail(id: string) {
    withTransaction(this.#options.database, () => this.#options.database.prepare('UPDATE remote_uploads SET state = \'failed\' WHERE id = ? AND state = \'receiving\'').run(id))
  }

  #release(row: UploadRow) {
    if (row.input_id) {
      createComposerResourceRepository(this.#options.database).remove(row.draft_id, [row.resource_id])
      const attachments = createAttachmentRepository(this.#options.database)
      if (attachments.findById(row.attachment_id)?.draftId === row.draft_id)
        attachments.removeDraft(row.attachment_id)
    }
    this.#files.releaseReference({ kind: 'export', ownerId: row.id, bindingId: row.id })
    this.#files.settle([row.path], 'rollback')
    this.#verified.delete(row.id)
  }

  #now() { return Math.max(Date.now(), Number(this.#options.database.prepare('SELECT last_observed_ms FROM private_network_state WHERE id = 1').get()!.last_observed_ms)) }

  #exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#busy.has(id) || this.#busy.size >= limits.httpRequests)
      return Promise.reject(new PrivateNetworkError('LIMIT_EXCEEDED'))
    const promise = Promise.resolve().then(operation).catch((error) => {
      this.#verified.delete(id)
      throw error
    }).finally(() => {
      this.#busy.delete(id)
      const row = this.#row(id)
      if (['cancelled', 'expired', 'failed'].includes(row.state))
        this.#release(row)
    })
    this.#busy.set(id, promise)
    return promise
  }
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false
    throw error
  }
}
async function hashFile(path: string, start?: number, length?: number) {
  const hash = createHash('sha256')
  if (length !== 0) {
    for await (const chunk of createReadStream(path, start === undefined ? {} : { start, end: start + length! - 1 })) hash.update(chunk)
  }
  return hash.digest('hex')
}
async function readChunk(request: IncomingMessage, length: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > length)
      throw new PrivateNetworkError('RANGE_INVALID')
    chunks.push(Buffer.from(chunk))
  }
  if (size !== length)
    throw new PrivateNetworkError('RANGE_INVALID')
  return Buffer.concat(chunks, length)
}

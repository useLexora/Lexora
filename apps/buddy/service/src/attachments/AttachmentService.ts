import type { Buffer } from 'node:buffer'
import type { BuddyAttachmentUpload } from '../../../shared/conversation/attachmentPolicy'
import type { AttachmentRecord, AttachmentRepository } from '../storage/attachmentRepository'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { AttachmentChange } from './attachmentEvents'
import type { AttachmentInputScope } from './AttachmentInputReader'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, open, readdir, readFile, realpath, rmdir, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import {
  BUDDY_ATTACHMENT_COUNT_LIMIT,
  BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT,
  BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT,
  isTextAttachmentMimeType,
} from '../../../shared/conversation/attachmentPolicy'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { ATTACHMENT_PREVIEW_BYTES_LIMIT } from '../../../shared/runtime/attachmentHostProtocol'
import { readTransactionFailure } from '../storage/transaction'
import { AttachmentError } from './AttachmentError'

import { AttachmentInputMaterializer } from './AttachmentInputMaterializer'
import { normalizeAttachmentMetadata, validateTotalBytes } from './attachmentMetadata'
import { InputMaterialProjector } from './InputMaterialProjector'
import { hasDocumentSignature } from './validateDocumentBytes'

export { AttachmentError } from './AttachmentError'
export type { AttachmentRecoveryResult } from './AttachmentInputMaterializer'
export { inferMimeType, normalizeAttachmentMetadata } from './attachmentMetadata'

export const DRAFT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export interface AttachmentServiceOptions {
  assertConversationWritable?: (conversationId: string) => void
  paths: BuddyDataPaths
  readFile?: AttachmentFileReader
  repository: AttachmentRepository
}

export interface AttachmentFileReader {
  (path: string): Promise<Buffer>
  (path: string, encoding: 'utf8'): Promise<string>
}

export interface AttachmentStorageReconciliation {
  invalidAttachmentIds: string[]
  missingAttachmentIds: string[]
  removedOrphanFiles: number
}

export interface MessageAttachmentBinding {
  nameSource?: 'file' | 'clipboard'
  createdAt: string
  id: string
  messageId: string
  mimeType: string
  name: string
  sizeBytes: number
  sourceAttachmentId: string
  sourceDraftId: string | null
  sourceStoredPath: string
  storedPath: string
}

export interface PreparedMessageAttachments {
  bindings: readonly Readonly<MessageAttachmentBinding>[]
  commit: () => Promise<void>
  rollback: () => Promise<void>
  retain: () => Promise<void>
}

export interface PreparedDraftAttachmentCopy extends PreparedAttachmentUploads {
  validate: () => void
}

export interface PreparedAttachmentUploads {
  readonly records: readonly Readonly<AttachmentRecord>[]
  commit: () => Promise<void>
  rollback: () => Promise<void>
  retain: () => Promise<void>
}

export class AttachmentService {
  readonly #changes = new Emitter<AttachmentChange>(() => console.error('ATTACHMENT_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #leasedPaths = new Map<string, number>()
  readonly #ownerInstance = randomUUID()
  readonly #pendingReads = new Set<Promise<Buffer>>()
  #revision = 0
  #storageTail = Promise.resolve()
  #stopping = false
  readonly #projector: InputMaterialProjector
  readonly #materializer: AttachmentInputMaterializer
  readonly #paths: BuddyDataPaths
  readonly #readFile: AttachmentFileReader
  readonly #repository: AttachmentRepository
  readonly #assertConversationWritable?: (conversationId: string) => void

  constructor(options: AttachmentServiceOptions) {
    this.#paths = options.paths
    this.#readFile = options.readFile ?? readFile
    this.#repository = options.repository
    this.#assertConversationWritable = options.assertConversationWritable
    const reader = {
      get: (id: string, scope: AttachmentInputScope) => this.#requireForPrompt(id, scope.conversationId, scope.draftId ?? null, scope.legacyResourceDraftId),
      read: (record: AttachmentRecord) => this.#readBytes(record),
      inspect: async (record: AttachmentRecord) => {
        this.#assertFileReady(record)
        const metadata = await stat(record.storedPath)
        return { isFile: metadata.isFile(), size: metadata.size }
      },
    }
    this.#projector = new InputMaterialProjector(reader)
    this.#materializer = new AttachmentInputMaterializer({ reader, projector: this.#projector, imageDirectory: id => join(this.#paths.conversationDirectory(id), 'image-inputs'), listForConversation: id => this.listForConversation(id) })
  }

  registerFiles(draftId: string, paths: readonly string[], limits = { count: BUDDY_ATTACHMENT_COUNT_LIMIT, errorCode: 'VALIDATION_FAILED', totalBytes: BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT }): Promise<AttachmentRecord[]> {
    const owned = [...paths]
    const ownedLimits = { ...limits }
    return this.#storage(() => this.#registerFiles(draftId, owned, ownedLimits))
  }

  registerUploads(draftId: string, uploads: readonly BuddyAttachmentUpload[]): Promise<AttachmentRecord[]> {
    const owned = uploads.map(upload => ({ ...upload, bytes: Uint8Array.from(upload.bytes) }))
    return this.#storage(() => this.#registerUploads(draftId, owned))
  }

  prepareUploads(draftId: string, uploads: readonly BuddyAttachmentUpload[]): Promise<PreparedAttachmentUploads> {
    const owned = uploads.map(upload => ({ ...upload, bytes: Uint8Array.from(upload.bytes) }))
    return this.#storage(async () => {
      const records = await this.#registerUploads(draftId, owned)
      for (const record of records) {
        const path = normalize(record.storedPath)
        this.#leasedPaths.set(path, (this.#leasedPaths.get(path) ?? 0) + 1)
      }
      let settlement: { outcome: 'commit' | 'rollback' | 'retain', promise: Promise<void> } | undefined
      const settle = (outcome: 'commit' | 'rollback' | 'retain'): Promise<void> => {
        if (settlement) {
          return settlement.outcome === outcome
            ? settlement.promise
            : Promise.reject(new Error('ATTACHMENT_PREPARATION_SETTLED'))
        }
        const promise = this.#storage(async () => {
          for (const record of records) {
            const path = normalize(record.storedPath)
            const remaining = (this.#leasedPaths.get(path) ?? 1) - 1
            if (remaining)
              this.#leasedPaths.set(path, remaining)
            else this.#leasedPaths.delete(path)
          }
          if (outcome === 'rollback') {
            const ownedIds = records.filter((record) => {
              const current = this.#repository.findById(record.id)
              return current?.draftId === draftId && current.storedPath === record.storedPath
            }).map(record => record.id)
            await this.#release(ownedIds)
          }
        }, true)
        settlement = { outcome, promise }
        return promise
      }
      return Object.freeze({ records: copyEventSnapshot(records), commit: () => settle('commit'), rollback: () => settle('rollback'), retain: () => settle('retain') })
    })
  }

  prepareMessageAttachments(input: { attachmentIds: readonly string[], conversationId: string, draftId: string, messageId: string, legacyResourceDraftId?: string }): Promise<PreparedMessageAttachments> {
    const owned = { ...input, attachmentIds: [...input.attachmentIds] }
    return this.#storage(() => {
      this.#assertConversationWritable?.(owned.conversationId)
      return this.#prepareMessageAttachments(owned)
    })
  }

  prepareDraftCopy(input: { sourceDraftId: string, targetDraftId: string, attachmentIds: readonly string[] }): Promise<PreparedDraftAttachmentCopy> {
    const owned = { ...input, attachmentIds: [...input.attachmentIds] }
    return this.#storage(async () => {
      if (owned.sourceDraftId === owned.targetDraftId)
        throw new AttachmentError('VALIDATION_FAILED')
      const sources = owned.attachmentIds.map(id => this.#requireForPrompt(id, null, owned.sourceDraftId))
      const prepared = await this.#prepareMessageAttachments({ attachmentIds: owned.attachmentIds, conversationId: '', draftId: owned.sourceDraftId, messageId: owned.targetDraftId, targetDraftId: owned.targetDraftId })
      const records = prepared.bindings.map((binding): AttachmentRecord => ({
        id: binding.id,
        draftId: owned.targetDraftId,
        messageId: null,
        conversationId: null,
        storedPath: binding.storedPath,
        createdAt: binding.createdAt,
        name: binding.name,
        nameSource: binding.nameSource,
        mimeType: binding.mimeType,
        sizeBytes: binding.sizeBytes,
        sourcePath: sources.find(source => source.id === binding.sourceAttachmentId)?.sourcePath,
      }))
      let settled = false
      const settle = (outcome: 'commit' | 'rollback' | 'retain') => {
        settled = true
        return prepared[outcome]()
      }
      return Object.freeze({
        records: copyEventSnapshot(records),
        validate: () => {
          if (settled)
            throw new Error('ATTACHMENT_PREPARATION_SETTLED')
          for (const source of sources) {
            if (JSON.stringify(this.#repository.findById(source.id)) !== JSON.stringify(source))
              throw new AttachmentError('ATTACHMENT_NOT_FOUND')
            this.#assertFileReady(source)
          }
          for (const record of records) this.#assertFileReady(record)
        },
        commit: () => settle('commit'),
        rollback: () => settle('rollback'),
        retain: () => settle('retain'),
      })
    })
  }

  release(ids: readonly string[]): Promise<string[]> {
    const owned = [...ids]
    return this.#storage(() => this.#release(owned))
  }

  releaseDraft(draftId: string): Promise<void> {
    return this.#storage(() => this.#releaseDraft(draftId))
  }

  reconcileStorage(): Promise<AttachmentStorageReconciliation> {
    return this.#storage(() => this.#reconcileStorage())
  }

  withStorageScope<T>(operation: () => Promise<T>): Promise<T> {
    return this.#storage(operation)
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    let tail: Promise<void>
    do {
      tail = this.#storageTail
      await tail
    } while (tail !== this.#storageTail)
    await Promise.allSettled([...this.#pendingReads])
    if (this.#leasedPaths.size)
      throw new Error('ATTACHMENT_PREPARATIONS_PENDING')
    this.#changes.dispose()
  }

  #storage<T>(operation: () => Promise<T>, finishing = false): Promise<T> {
    if (this.#stopping && !finishing)
      return Promise.reject(new AttachmentError('RUNTIME_OFFLINE'))
    const result = this.#storageTail.then(operation)
    this.#storageTail = result.then(() => {}, () => {})
    return result
  }

  #publish(kind: AttachmentChange['kind'], phase: AttachmentChange['phase'], attachmentIds: readonly string[], operationId: string = randomUUID(), count = attachmentIds.length): void {
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, operationId, kind, phase, attachmentIds, count }))
  }

  async #registerFiles(
    draftId: string,
    paths: readonly string[],
    limits = {
      count: BUDDY_ATTACHMENT_COUNT_LIMIT,
      errorCode: 'VALIDATION_FAILED',
      totalBytes: BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT,
    },
  ): Promise<AttachmentRecord[]> {
    if (paths.length > limits.count)
      throw new AttachmentError(limits.errorCode)
    const sources = await Promise.all(paths.map(async (selectedPath) => {
      const sourcePath = await realpath(selectedPath).catch(() => null)
      if (!sourcePath)
        throw new AttachmentError('ATTACHMENT_NOT_FOUND')
      const metadata = await stat(sourcePath)
      if (!metadata.isFile())
        throw new AttachmentError('VALIDATION_FAILED')
      const { mimeType } = normalizeAttachmentMetadata({ name: basename(sourcePath), mimeType: '', sizeBytes: metadata.size })
      return { metadata, mimeType, sourcePath }
    }))
    validateTotalBytes(sources.map(source => source.metadata.size), limits.totalBytes, limits.errorCode)
    const directory = this.#paths.draftAttachments(draftId)
    await mkdir(directory, { mode: 0o700, recursive: true })
    const operationId = randomUUID()
    const records: AttachmentRecord[] = []
    const attempted: AttachmentRecord[] = []
    try {
      for (const { metadata, mimeType, sourcePath } of sources) {
        const id = randomUUID()
        const storedPath = join(directory, `${id}${safeExtension(sourcePath)}`)
        const record: AttachmentRecord = {
          conversationId: null,
          createdAt: new Date().toISOString(),
          draftId,
          id,
          messageId: null,
          mimeType,
          name: basename(sourcePath),
          sourcePath,
          sizeBytes: metadata.size,
          storedPath,
        }
        attempted.push(record)
        const preparation = this.#repository.persistence?.prepare({ operationId, stagingDirectory: join(this.#paths.root, 'managed-files', 'staging'), availableBytes: await availableStorageBytes(directory), ownerInstance: this.#ownerInstance, kind: 'import', targetOwnerId: draftId, path: storedPath, sizeBytes: record.sizeBytes })
        const proof = await publishFile(sourcePath, storedPath, record.sizeBytes, undefined, preparation?.temporaryPath ?? undefined)
        this.#repository.persistence?.publish(storedPath, proof)
        this.#publish('file-published', 'import', [record.id], operationId)
        if (isDocumentMimeType(mimeType) && !hasDocumentSignature(mimeType, await this.#readFile(storedPath)))
          throw new AttachmentError('ATTACHMENT_INVALID')
        this.#repository.create(record)
        this.#repository.persistence?.settle([storedPath], 'commit')
        this.#publish('registered', 'import', [record.id], operationId)
        records.push(record)
      }
    }
    catch (error) {
      if (readTransactionFailure(error)?.outcome === 'unknown')
        throw error
      try {
        await this.#rollbackRegistration(attempted, operationId)
      }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Attachment import and cleanup failed') }
      throw error
    }
    return records
  }

  async #registerUploads(
    draftId: string,
    uploads: readonly BuddyAttachmentUpload[],
  ): Promise<AttachmentRecord[]> {
    if (uploads.length > BUDDY_ATTACHMENT_COUNT_LIMIT)
      throw new AttachmentError('VALIDATION_FAILED')
    const sources = uploads.map((upload) => {
      const { name, mimeType } = normalizeAttachmentMetadata({ name: basename(upload.name.trim()), mimeType: upload.mimeType, sizeBytes: upload.bytes.byteLength })
      if (isDocumentMimeType(mimeType) && !hasDocumentSignature(mimeType, upload.bytes))
        throw new AttachmentError('ATTACHMENT_INVALID')
      return { ...upload, mimeType, name }
    })
    validateTotalBytes(sources.map(source => source.bytes.byteLength))
    const directory = this.#paths.draftAttachments(draftId)
    await mkdir(directory, { mode: 0o700, recursive: true })
    const operationId = randomUUID()
    const records: AttachmentRecord[] = []
    const attempted: AttachmentRecord[] = []
    try {
      for (const source of sources) {
        const id = randomUUID()
        const storedPath = join(directory, `${id}${safeExtension(source.name)}`)
        const record: AttachmentRecord = {
          conversationId: null,
          createdAt: new Date().toISOString(),
          draftId,
          id,
          messageId: null,
          mimeType: source.mimeType,
          name: source.name,
          nameSource: source.nameSource ?? 'file',
          sourcePath: source.sourcePath,
          sizeBytes: source.bytes.byteLength,
          storedPath,
        }
        attempted.push(record)
        const preparation = this.#repository.persistence?.prepare({ operationId, stagingDirectory: join(this.#paths.root, 'managed-files', 'staging'), availableBytes: await availableStorageBytes(directory), ownerInstance: this.#ownerInstance, kind: 'import', targetOwnerId: draftId, path: storedPath, sizeBytes: record.sizeBytes })
        const proof = await publishBytes(source.bytes, storedPath, preparation?.temporaryPath ?? undefined)
        this.#repository.persistence?.publish(storedPath, proof)
        this.#publish('file-published', 'import', [record.id], operationId)
        this.#repository.create(record)
        this.#repository.persistence?.settle([storedPath], 'commit')
        this.#publish('registered', 'import', [record.id], operationId)
        records.push(record)
      }
    }
    catch (error) {
      if (readTransactionFailure(error)?.outcome === 'unknown')
        throw error
      try {
        await this.#rollbackRegistration(attempted, operationId)
      }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Attachment import and cleanup failed') }
      throw error
    }
    return records
  }

  async #prepareMessageAttachments(input: {
    attachmentIds: readonly string[]
    conversationId: string
    draftId: string
    messageId: string
    targetDraftId?: string
    legacyResourceDraftId?: string
  }): Promise<PreparedMessageAttachments> {
    const records = input.attachmentIds.map(id => this.#requireForPrompt(
      id,
      input.conversationId,
      input.draftId,
      input.legacyResourceDraftId,
    ))
    validateTotalBytes(records.map(record => record.sizeBytes))
    if (records.length === 0) {
      return {
        bindings: [],
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
        retain: () => Promise.resolve(),
      }
    }
    const directory = input.targetDraftId ? this.#paths.draftAttachments(input.targetDraftId) : this.#paths.messageInputs(input.conversationId, input.messageId)
    await mkdir(directory, { mode: 0o700, recursive: true })
    const operationId = randomUUID()
    const bindings: MessageAttachmentBinding[] = []
    const attemptedPaths: string[] = []
    const leasedPaths: string[] = []
    const lease = (path: string) => {
      const key = normalize(path)
      this.#leasedPaths.set(key, (this.#leasedPaths.get(key) ?? 0) + 1)
      leasedPaths.push(key)
    }
    const releaseLeases = () => {
      for (const path of leasedPaths.splice(0)) {
        const remaining = (this.#leasedPaths.get(path) ?? 1) - 1
        if (remaining)
          this.#leasedPaths.set(path, remaining)
        else this.#leasedPaths.delete(path)
      }
    }
    try {
      for (const record of records) {
        const id = !input.targetDraftId && record.draftId === input.draftId ? record.id : randomUUID()
        const storedPath = join(directory, `${id}${safeExtension(record.name)}`)
        if (this.#leasedPaths.has(normalize(storedPath)) || this.#repository.listAll().some(owned => normalize(owned.storedPath) === normalize(storedPath)))
          throw new AttachmentError('VALIDATION_FAILED')
        lease(record.storedPath)
        lease(storedPath)
        attemptedPaths.push(storedPath)
        const preparation = this.#repository.persistence?.prepare({ operationId, stagingDirectory: join(this.#paths.root, 'managed-files', 'staging'), availableBytes: await availableStorageBytes(directory), ownerInstance: this.#ownerInstance, kind: input.targetDraftId ? 'copy' : 'message', targetOwnerId: input.targetDraftId ?? input.messageId, path: storedPath, sizeBytes: record.sizeBytes, source: record })
        const proof = await publishFile(record.storedPath, storedPath, record.sizeBytes, this.#repository.persistence?.get(record.storedPath)?.sha256 ?? undefined, preparation?.temporaryPath ?? undefined)
        this.#repository.persistence?.publish(storedPath, proof)
        this.#publish('file-published', 'message', [id], operationId)
        bindings.push({
          createdAt: new Date().toISOString(),
          id,
          messageId: input.messageId,
          mimeType: record.mimeType,
          name: record.name,
          nameSource: record.nameSource,
          sizeBytes: record.sizeBytes,
          sourceAttachmentId: record.id,
          sourceDraftId: record.draftId,
          sourceStoredPath: record.storedPath,
          storedPath,
        })
      }
    }
    catch (error) {
      if (readTransactionFailure(error)?.outcome === 'unknown') {
        releaseLeases()
        throw error
      }
      try {
        if (this.#repository.persistence) {
          this.#repository.persistence.settle(attemptedPaths.filter(path => this.#repository.persistence!.get(path)), 'rollback')
          releaseLeases()
          await this.#collectFiles(attemptedPaths)
        }
        else {
          await removeFiles(attemptedPaths)
        }
        if (attemptedPaths.length)
          this.#publish('cleanup-completed', 'rollback', bindings.map(binding => binding.id), operationId, attemptedPaths.length)
      }
      catch (cleanup) {
        this.#publish('cleanup-failed', 'rollback', bindings.map(binding => binding.id), operationId)
        throw new AggregateError([error, cleanup], 'Attachment preparation and cleanup failed')
      }
      finally { releaseLeases() }
      throw error
    }
    this.#publish('prepared', 'message', bindings.map(binding => binding.id), operationId)
    let settlement: { outcome: 'commit' | 'rollback' | 'retain', promise: Promise<void> } | undefined
    const settle = (outcome: 'commit' | 'rollback' | 'retain'): Promise<void> => {
      if (settlement) {
        return settlement.outcome === outcome
          ? settlement.promise
          : Promise.reject(new Error('ATTACHMENT_PREPARATION_SETTLED'))
      }
      const promise = this.#storage(async () => {
        try {
          if (outcome === 'retain')
            return
          const owned = new Set(this.#repository.listAll().map(record => normalize(record.storedPath)))
          if (outcome === 'commit' && bindings.some(binding => !owned.has(normalize(binding.storedPath))))
            throw new Error('ATTACHMENT_OWNERSHIP_NOT_COMMITTED')
          const candidates = outcome === 'commit'
            ? bindings.flatMap(binding => binding.sourceDraftId ? [binding.sourceStoredPath] : [])
            : bindings.map(binding => binding.storedPath)
          const removable = candidates.filter(path => !owned.has(normalize(path)))
          if (this.#repository.persistence) {
            this.#repository.persistence.settle(bindings.map(binding => binding.storedPath), outcome)
            releaseLeases()
            await this.#collectFiles(removable)
          }
          else {
            await removeFiles(removable)
          }
          this.#publish('cleanup-completed', outcome, bindings.map(binding => binding.id), operationId, removable.length)
        }
        catch (error) {
          if (outcome !== 'retain')
            this.#publish('cleanup-failed', outcome, bindings.map(binding => binding.id), operationId)
          throw error
        }
        finally { releaseLeases() }
      }, true)
      settlement = { outcome, promise }
      return promise
    }
    return {
      bindings: copyEventSnapshot(bindings),
      commit: () => settle('commit'),
      rollback: () => settle('rollback'),
      retain: () => settle('retain'),
    }
  }

  resolvePreview(id: string): { mimeType: string, path: string } {
    const record = this.#repository.findVisibleById(id)
    if (!record)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    this.#assertFileReady(record)
    if (!record.mimeType.startsWith('image/'))
      throw new AttachmentError('VALIDATION_FAILED')
    return { mimeType: record.mimeType, path: record.storedPath }
  }

  async readPreview(id: string): Promise<{ mimeType: string, data: string }> {
    const preview = this.resolvePreview(id)
    const record = this.#requireAvailable(id)
    if (record.sizeBytes > ATTACHMENT_PREVIEW_BYTES_LIMIT)
      throw new AttachmentError('ATTACHMENT_TOO_LARGE')
    const bytes = await this.#readBytes(record, () => readBoundedFile(dirname(preview.path), preview.path, ATTACHMENT_PREVIEW_BYTES_LIMIT))
    return { mimeType: preview.mimeType, data: bytes.toString('base64') }
  }

  #readBytes(record: AttachmentRecord, read: () => Promise<Buffer> = () => this.#readFile(record.storedPath)): Promise<Buffer> {
    if (this.#stopping)
      return Promise.reject(new AttachmentError('RUNTIME_OFFLINE'))
    const result = this.#readLeasedBytes(record, read)
    this.#pendingReads.add(result)
    void result.then(() => this.#pendingReads.delete(result), () => this.#pendingReads.delete(result))
    return result
  }

  async #readLeasedBytes(record: AttachmentRecord, read: () => Promise<Buffer>): Promise<Buffer> {
    this.#assertFileReady(record)
    const path = normalize(record.storedPath)
    this.#leasedPaths.set(path, (this.#leasedPaths.get(path) ?? 0) + 1)
    try {
      const bytes = await read()
      const expected = this.#repository.persistence?.get(record.storedPath)
      if (bytes.byteLength !== record.sizeBytes || (expected?.sha256 && createHash('sha256').update(bytes).digest('hex') !== expected.sha256)) {
        this.#repository.persistence?.unavailable(record.storedPath)
        throw new AttachmentError('ATTACHMENT_INVALID')
      }
      return bytes
    }
    catch (error) {
      if (isFileNotFound(error)) {
        this.#repository.persistence?.unavailable(record.storedPath)
        throw new AttachmentError('ATTACHMENT_NOT_FOUND', { cause: error })
      }
      throw error
    }
    finally {
      const remaining = (this.#leasedPaths.get(path) ?? 1) - 1
      if (remaining)
        this.#leasedPaths.set(path, remaining)
      else this.#leasedPaths.delete(path)
    }
  }

  async readText(id: string, draftId: string | null, conversationId: string | null): Promise<string> {
    const record = this.#requireForPrompt(id, conversationId, draftId)
    if (!isTextAttachmentMimeType(record.mimeType))
      throw new AttachmentError('ATTACHMENT_UNSUPPORTED')
    if (record.sizeBytes > BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT)
      throw new AttachmentError('ATTACHMENT_TOO_LARGE')
    const bytes = await this.#readBytes(record, () => readBoundedFile(dirname(record.storedPath), record.storedPath, BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT))
    return bytes.toString('utf8')
  }

  async #release(ids: readonly string[]): Promise<string[]> {
    const released: string[] = []
    for (const id of ids) {
      const record = this.#repository.findById(id)
      if (!record?.draftId)
        continue
      if (this.#leasedPaths.has(normalize(record.storedPath)) || this.#repository.persistence?.hasProtection(record.storedPath) || !this.#repository.removeDraft(id))
        continue
      released.push(id)
      this.#publish('released', 'release', [id])
      try {
        if (this.#repository.persistence)
          await this.#collectFiles([record.storedPath])
        else await unlinkAvailableFile(record.storedPath)
        this.#publish('cleanup-completed', 'release', [id])
      }
      catch (error) {
        this.#publish('cleanup-failed', 'release', [id])
        throw error
      }
    }
    return released
  }

  async #releaseDraft(draftId: string): Promise<void> {
    await this.#release(this.#repository.listAll().filter(record => record.draftId === draftId).map(record => record.id))
    const directory = this.#paths.draftAttachments(draftId)
    for (const path of [directory, dirname(directory)]) {
      try {
        await rmdir(path)
      }
      catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error
      }
    }
  }

  cleanupDrafts(now = Date.now(), retainedAttachmentIds: ReadonlySet<string> = new Set()): Promise<string[]> {
    const cutoff = new Date(now - DRAFT_ATTACHMENT_RETENTION_MS).toISOString()
    return this.release(this.#repository.listDraftsBefore(cutoff)
      .filter(record => !retainedAttachmentIds.has(record.id))
      .map(record => record.id))
  }

  async #reconcileStorage(): Promise<AttachmentStorageReconciliation> {
    this.#repository.persistence?.recover(this.#ownerInstance)
    const records = this.#repository.listAll()
    const ownedPaths = new Set(records.map(record => normalize(record.storedPath)))
    const invalidAttachmentIds: string[] = []
    const missingAttachmentIds: string[] = []

    for (const record of records) {
      if (this.#repository.persistence && !this.#repository.persistence.get(record.storedPath))
        throw new Error('ATTACHMENT_CATALOG_INCOMPLETE')
      try {
        const metadata = await stat(record.storedPath)
        if (!metadata.isFile() || metadata.size !== record.sizeBytes) {
          invalidAttachmentIds.push(record.id)
          this.#repository.persistence?.unavailable(record.storedPath)
        }
      }
      catch (error) {
        if (isFileNotFound(error)) {
          missingAttachmentIds.push(record.id)
          this.#repository.persistence?.unavailable(record.storedPath)
          continue
        }
        throw error
      }
    }

    let removedOrphanFiles = 0
    if (this.#repository.persistence) {
      removedOrphanFiles = await this.#collectFiles(this.#repository.persistence.candidates().map(file => file.path))
    }
    else {
      const roots = [this.#paths.draftsDirectory]
      const conversationDirectories = await listDirectories(this.#paths.conversationsDirectory)
      roots.push(...conversationDirectories.map(directory => join(directory, 'inputs')))
      for (const root of roots) {
        for (const path of await listFilesRecursively(root)) {
          if (ownedPaths.has(normalize(path)) || this.#leasedPaths.has(normalize(path)))
            continue
          await unlinkAvailableFile(path)
          removedOrphanFiles += 1
        }
      }
    }

    this.#publish('reconciled', 'recovery', [...invalidAttachmentIds, ...missingAttachmentIds], randomUUID(), removedOrphanFiles)
    return {
      invalidAttachmentIds: invalidAttachmentIds.sort(),
      missingAttachmentIds: missingAttachmentIds.sort(),
      removedOrphanFiles,
    }
  }

  listForConversation(conversationId: string): AttachmentRecord[] {
    return this.#repository.listForConversation(conversationId)
  }

  materializeConversationImages(...input: Parameters<AttachmentInputMaterializer['materializeConversationImages']>) {
    return this.#materializer.materializeConversationImages(...input)
  }

  materializePrompt(...input: Parameters<AttachmentInputMaterializer['materializePrompt']>) {
    return this.#materializer.materializePrompt(...input)
  }

  materializeInputResources(...input: Parameters<AttachmentInputMaterializer['materializeInputResources']>) {
    return this.#materializer.materializeInputResources(...input)
  }

  resolveInputReferences(...input: Parameters<AttachmentInputMaterializer['resolveInputReferences']>) {
    return this.#materializer.resolveInputReferences(...input)
  }

  materializePiInputImages(...input: Parameters<AttachmentInputMaterializer['materializePiInputImages']>) {
    return this.#materializer.materializePiInputImages(...input)
  }

  prepareInputImages(...input: Parameters<AttachmentInputMaterializer['prepareInputImages']>) {
    return this.#materializer.prepareInputImages(...input)
  }

  materializeDocumentInputs(...input: Parameters<AttachmentInputMaterializer['materializeDocumentInputs']>) {
    return this.#materializer.materializeDocumentInputs(...input)
  }

  resolveRecoveryInputReferences(...input: Parameters<AttachmentInputMaterializer['resolveRecoveryInputReferences']>) {
    return this.#materializer.resolveRecoveryInputReferences(...input)
  }

  preparePrompt(...input: Parameters<InputMaterialProjector['preparePrompt']>) {
    return this.#projector.preparePrompt(...input)
  }

  getInputMetadata(ids: readonly string[], conversationId: string | null, draftId: string | null = null): AttachmentRecord[] {
    return ids.map(id => this.#requireForPrompt(id, conversationId, draftId))
  }

  #requireAvailable(id: string): AttachmentRecord {
    const record = this.#repository.findById(id)
    if (!record)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    this.#assertFileReady(record)
    return record
  }

  #assertFileReady(record: AttachmentRecord): void {
    if (this.#repository.persistence && this.#repository.persistence.get(record.storedPath)?.state !== 'ready')
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
  }

  async #collectFiles(paths: readonly string[]): Promise<number> {
    const repository = this.#repository.persistence!
    let removed = 0
    for (const path of new Set(paths)) {
      const location = relative(this.#paths.root, path)
      if (!location || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location))
        throw new Error('FILE_UNMANAGED_PATH')
      if (this.#leasedPaths.has(normalize(path)))
        continue
      const claimed = repository.claim(path)
      if (!claimed)
        continue
      if (claimed.temporaryPath) {
        await unlinkAvailableFile(claimed.temporaryPath)
        await syncAvailableDirectory(dirname(claimed.temporaryPath))
      }
      await unlinkAvailableFile(path)
      await syncAvailableDirectory(dirname(path))
      repository.deleted(claimed.id)
      removed++
    }
    return removed
  }

  #requireForPrompt(
    id: string,
    conversationId: string | null,
    draftId: string | null,
    legacyResourceDraftId?: string,
  ): AttachmentRecord {
    const record = this.#requireAvailable(id)
    if (record.draftId !== null) {
      if (record.draftId === draftId || record.draftId === legacyResourceDraftId)
        return record
      throw new AttachmentError('VALIDATION_FAILED')
    }
    if (record.messageId !== null && record.conversationId === conversationId)
      return record
    throw new AttachmentError('VALIDATION_FAILED')
  }

  async #rollbackRegistration(records: readonly AttachmentRecord[], operationId: string): Promise<void> {
    const failures: unknown[] = []
    for (const record of records.toReversed()) {
      try {
        if (this.#repository.removeDraft(record.id))
          this.#publish('released', 'rollback', [record.id], operationId)
        if (this.#repository.findById(record.id))
          continue
        if (this.#repository.persistence) {
          if (this.#repository.persistence.get(record.storedPath)) {
            this.#repository.persistence.settle([record.storedPath], 'rollback')
            await this.#collectFiles([record.storedPath])
          }
        }
        else {
          await unlinkAvailableFile(record.storedPath)
        }
        this.#publish('cleanup-completed', 'rollback', [record.id], operationId)
      }
      catch (error) {
        this.#publish('cleanup-failed', 'rollback', [record.id], operationId)
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Attachment rollback cleanup failed')
  }
}

function safeExtension(path: string): string {
  const extension = extname(path).toLowerCase()
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ''
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function unlinkAvailableFile(path: string): Promise<void> {
  try {
    await unlink(path)
  }
  catch (error) {
    if (!isFileNotFound(error))
      throw error
  }
}

async function removeFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(unlinkAvailableFile))
}

async function publishBytes(bytes: Uint8Array, storedPath: string, temporaryPath = `${storedPath}.part`) {
  await mkdir(dirname(temporaryPath), { mode: 0o700, recursive: true })
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx', flush: true, mode: 0o600 })
    await fileStorage.replace(temporaryPath, storedPath)
    await fileStorage.syncDirectory(dirname(storedPath))
    if (dirname(temporaryPath) !== dirname(storedPath))
      await fileStorage.syncDirectory(dirname(temporaryPath))
    return { sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), durability: fileStorage.durability }
  }
  finally {
    await unlinkAvailableFile(temporaryPath)
  }
}

async function publishFile(sourcePath: string, storedPath: string, expectedSize: number, expectedHash?: string, temporaryPath = `${storedPath}.part`) {
  await mkdir(dirname(temporaryPath), { mode: 0o700, recursive: true })
  try {
    await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
    await chmod(temporaryPath, 0o600)
    const sha256 = await hashFile(temporaryPath, expectedSize)
    if (expectedHash && sha256 !== expectedHash)
      throw new AttachmentError('ATTACHMENT_INVALID')
    if (await hashFile(sourcePath, expectedSize) !== sha256)
      throw new AttachmentError('ATTACHMENT_INVALID')
    const file = await open(temporaryPath, 'r+')
    try {
      await file.sync()
    }
    finally {
      await file.close()
    }
    await fileStorage.replace(temporaryPath, storedPath)
    await fileStorage.syncDirectory(dirname(storedPath))
    if (dirname(temporaryPath) !== dirname(storedPath))
      await fileStorage.syncDirectory(dirname(temporaryPath))
    return { sizeBytes: expectedSize, sha256, durability: fileStorage.durability }
  }
  finally {
    await unlinkAvailableFile(temporaryPath)
  }
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name))
  }
  catch (error) {
    if (isFileNotFound(error))
      return []
    throw error
  }
}

async function listFilesRecursively(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  }
  catch (error) {
    if (isFileNotFound(error))
      return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory())
      files.push(...await listFilesRecursively(path))
    else if (entry.isFile())
      files.push(path)
  }
  return files
}

async function hashFile(path: string, expectedSize: number): Promise<string> {
  let size = 0
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    if (size > expectedSize)
      throw new AttachmentError('ATTACHMENT_INVALID')
    hash.update(chunk)
  }
  if (size !== expectedSize)
    throw new AttachmentError('ATTACHMENT_INVALID')
  return hash.digest('hex')
}

async function availableStorageBytes(path: string): Promise<number> {
  const storage = await statfs(path, { bigint: true })
  const available = storage.bavail * storage.bsize
  return Number(available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available)
}

async function syncAvailableDirectory(path: string): Promise<void> {
  try {
    await fileStorage.syncDirectory(path)
  }
  catch (error) {
    if (!isFileNotFound(error))
      throw error
  }
}

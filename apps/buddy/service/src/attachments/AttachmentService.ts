import type { ImageContent } from '@earendil-works/pi-ai'
import type { Buffer } from 'node:buffer'
import type { BuddyAttachmentUpload } from '../../../shared/conversation/attachmentPolicy'
import type { BuddyPromptDirective, BuddyUserContentV1, BuddyUserMessageResourceSnapshot } from '../../../shared/conversation/buddyUserContent'
import type { BuddyInputReferenceV1 } from '../agent/context/BuddyInputReference'
import type { AttachmentRecord, AttachmentRepository } from '../storage/attachmentRepository'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { AttachmentDocumentReference, AttachmentFileInput } from './AttachmentDocumentReference'
import type { AttachmentImageReference } from './AttachmentImageReference'
import type { AttachmentToolWorkspace } from './AttachmentToolWorkspace'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, open, readdir, readFile, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize } from 'node:path'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { BUDDY_MEDIA_EXTENSIONS, BUDDY_MEDIA_FILE_BYTES_LIMIT, isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import {
  BUDDY_ATTACHMENT_COUNT_LIMIT,
  BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT,
  BUDDY_TEXT_ATTACHMENT_EXTENSIONS,
  getAttachmentKind,
} from '../../../shared/conversation/attachmentPolicy'
import { projectBuddyUserContent } from '../../../shared/conversation/buddyUserContentProjection'
import { getAttachmentLabels } from './attachmentLabels'
import { hasDocumentSignature } from './validateDocumentBytes'

export const DRAFT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const { replace: rename, syncDirectory } = fileStorage
const MAX_TEXT_PROMPT_BYTES = 1024 * 1024
const MIME_TYPES: Readonly<Record<string, string>> = {
  ...BUDDY_MEDIA_EXTENSIONS,
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.toml': 'application/toml',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}
const SUPPORTED_IMAGE_MIME_TYPES = new Set(
  Object.values(MIME_TYPES).filter(mimeType => mimeType.startsWith('image/')),
)
const textExtensions = new Set<string>(BUDDY_TEXT_ATTACHMENT_EXTENSIONS)

export interface AttachmentServiceOptions {
  paths: BuddyDataPaths
  readFile?: AttachmentFileReader
  repository: AttachmentRepository
}

export interface AttachmentFileReader {
  (path: string): Promise<Buffer>
  (path: string, encoding: 'utf8'): Promise<string>
}

export interface AttachmentRecoveryResult {
  resourceLabels?: Record<string, string>
  documents: AttachmentDocumentReference[]
  images: AttachmentImageReference[]
  missingAttachmentIds: string[]
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
  bindings: readonly MessageAttachmentBinding[]
  commit: () => Promise<void>
  rollback: () => Promise<void>
}

export class AttachmentService {
  readonly #paths: BuddyDataPaths
  readonly #readFile: AttachmentFileReader
  readonly #repository: AttachmentRepository

  constructor(options: AttachmentServiceOptions) {
    this.#paths = options.paths
    this.#readFile = options.readFile ?? readFile
    this.#repository = options.repository
  }

  async registerFiles(
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
        await publishFile(sourcePath, storedPath)
        if (isDocumentMimeType(mimeType) && !hasDocumentSignature(mimeType, await this.#readFile(storedPath)))
          throw new AttachmentError('ATTACHMENT_INVALID')
        this.#repository.create(record)
        records.push(record)
      }
    }
    catch (error) {
      await this.#rollbackRegistration(attempted)
      throw error
    }
    return records
  }

  async registerUploads(
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
        await publishBytes(source.bytes, storedPath)
        this.#repository.create(record)
        records.push(record)
      }
    }
    catch (error) {
      await this.#rollbackRegistration(attempted)
      throw error
    }
    return records
  }

  async prepareMessageAttachments(input: {
    attachmentIds: readonly string[]
    conversationId: string
    draftId: string
    messageId: string
  }): Promise<PreparedMessageAttachments> {
    const records = input.attachmentIds.map(id => this.#requireForPrompt(
      id,
      input.conversationId,
      input.draftId,
    ))
    validateTotalBytes(records.map(record => record.sizeBytes))
    if (records.length === 0) {
      return {
        bindings: [],
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
      }
    }
    const directory = this.#paths.messageInputs(input.conversationId, input.messageId)
    await mkdir(directory, { mode: 0o700, recursive: true })
    const bindings: MessageAttachmentBinding[] = []
    try {
      for (const record of records) {
        const id = record.draftId === input.draftId ? record.id : randomUUID()
        const storedPath = join(directory, `${id}${safeExtension(record.name)}`)
        await publishFile(record.storedPath, storedPath)
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
      await removeFiles(bindings.map(binding => binding.storedPath))
      throw error
    }
    return {
      bindings,
      commit: () => removeFiles(bindings.flatMap(
        binding => binding.sourceDraftId ? [binding.sourceStoredPath] : [],
      )),
      rollback: () => removeFiles(bindings.map(binding => binding.storedPath)),
    }
  }

  resolvePreview(id: string): { mimeType: string, path: string } {
    const record = this.#repository.findVisibleById(id)
    if (!record)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    if (!record.mimeType.startsWith('image/'))
      throw new AttachmentError('VALIDATION_FAILED')
    return { mimeType: record.mimeType, path: record.storedPath }
  }

  async release(ids: readonly string[]): Promise<string[]> {
    const released: string[] = []
    for (const id of ids) {
      const record = this.#repository.findById(id)
      if (!record?.draftId)
        continue
      await unlinkAvailableFile(record.storedPath)
      if (this.#repository.removeDraft(id))
        released.push(id)
    }
    return released
  }

  async releaseDraft(draftId: string): Promise<void> {
    await this.release(this.#repository.listAll().filter(record => record.draftId === draftId).map(record => record.id))
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

  async reconcileStorage(): Promise<AttachmentStorageReconciliation> {
    const records = this.#repository.listAll()
    const ownedPaths = new Set(records.map(record => normalize(record.storedPath)))
    const invalidAttachmentIds: string[] = []
    const missingAttachmentIds: string[] = []

    for (const record of records) {
      try {
        const metadata = await stat(record.storedPath)
        if (!metadata.isFile() || metadata.size !== record.sizeBytes)
          invalidAttachmentIds.push(record.id)
      }
      catch (error) {
        if (isFileNotFound(error)) {
          missingAttachmentIds.push(record.id)
          continue
        }
        throw error
      }
    }

    const roots = [this.#paths.draftsDirectory]
    const conversationDirectories = await listDirectories(this.#paths.conversationsDirectory)
    roots.push(...conversationDirectories.map(directory => join(directory, 'inputs')))
    let removedOrphanFiles = 0
    for (const root of roots) {
      for (const path of await listFilesRecursively(root)) {
        if (ownedPaths.has(normalize(path)))
          continue
        await unlinkAvailableFile(path)
        removedOrphanFiles += 1
      }
    }

    return {
      invalidAttachmentIds: invalidAttachmentIds.sort(),
      missingAttachmentIds: missingAttachmentIds.sort(),
      removedOrphanFiles,
    }
  }

  listForConversation(conversationId: string): AttachmentRecord[] {
    return this.#repository.listForConversation(conversationId)
  }

  async materializeConversationImages(
    conversationId: string,
    ids?: readonly string[],
  ): Promise<{ images: ImageContent[], records: AttachmentRecord[] }> {
    const available = this.listForConversation(conversationId)
      .filter(record => record.mimeType.startsWith('image/'))
    const selectedIds = ids === undefined
      ? available.slice(-1).map(record => record.id)
      : ids
    if (selectedIds.length === 0)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    const materialized = await this.materializePrompt(selectedIds, '', conversationId)
    if (materialized.images.length !== selectedIds.length)
      throw new AttachmentError('VALIDATION_FAILED')
    return {
      images: materialized.images,
      records: materialized.records,
    }
  }

  async materializePrompt(
    ids: readonly string[],
    content: string,
    conversationId: string | null = null,
    draftId: string | null = null,
    composer?: { content: BuddyUserContentV1, resourceIds: readonly string[], resources?: readonly BuddyUserMessageResourceSnapshot[], resolveDirective?: (directive: BuddyPromptDirective) => string },
  ): Promise<{ documents: AttachmentFileInput[], images: ImageContent[], prompt: string, records: AttachmentRecord[] }> {
    const prepared = await this.preparePrompt(ids, content, conversationId, draftId, composer)
    return {
      documents: await this.materializeDocumentInputs(prepared.documentReferences, conversationId, draftId),
      images: await this.materializePiInputImages(
        prepared.imageReferences,
        conversationId,
        draftId,
      ),
      prompt: prepared.prompt,
      records: prepared.records,
    }
  }

  async preparePrompt(
    ids: readonly string[],
    content: string,
    conversationId: string | null = null,
    draftId: string | null = null,
    composer?: { content: BuddyUserContentV1, resourceIds: readonly string[], resources?: readonly BuddyUserMessageResourceSnapshot[], resolveDirective?: (directive: BuddyPromptDirective) => string },
  ): Promise<{ documentReferences: AttachmentDocumentReference[], imageReferences: AttachmentImageReference[], prompt: string, records: AttachmentRecord[] }> {
    const records = ids.map(id => this.#requireForPrompt(id, conversationId, draftId))
    validateTotalBytes(records.map(record => record.sizeBytes))
    const materialized = await Promise.all(records.map(async (record): Promise<{
      imageReference: AttachmentImageReference | null
      documentReference?: AttachmentDocumentReference
      section: string
      text: string | null
    }> => {
      try {
        if (isDocumentMimeType(record.mimeType)) {
          return {
            documentReference: toDocumentReference(record),
            imageReference: null,
            section: `附件：${record.name}（${record.mimeType}，attachmentId=${record.id}）`,
            text: null,
          }
        }
        if (record.mimeType.startsWith('image/') && record.mimeType !== 'image/svg+xml') {
          return {
            imageReference: toImageReference(record),
            section: `附件：${record.name}（图像，attachmentId=${record.id}）`,
            text: null,
          }
        }
        if (!isTextAttachment(record) || record.sizeBytes > MAX_TEXT_PROMPT_BYTES)
          throw new AttachmentError('VALIDATION_FAILED')
        const text = await this.#readFile(record.storedPath, 'utf8')
        return {
          imageReference: null,
          section: `附件：${record.name}（attachmentId=${record.id}）\n\n${text}`,
          text,
        }
      }
      catch (error) {
        if (error instanceof AttachmentError)
          throw error
        if (isFileNotFound(error))
          throw new AttachmentError('ATTACHMENT_NOT_FOUND', { cause: error })
        throw error
      }
    }))
    const projected = composer
      ? projectBuddyUserContent(composer.content, (resourceId) => {
          const resource = composer.resources?.find(item => item.resourceId === resourceId)
          const localReference = resource?.localReference
          if (localReference && !resource.attachmentId)
            return { kind: 'local', name: localReference.name, localReference }
          const index = resource?.attachmentId ? ids.indexOf(resource.attachmentId) : composer.resourceIds.indexOf(resourceId)
          const record = records[index]
          const value = materialized[index]
          if (!record || !value)
            throw new AttachmentError('ATTACHMENT_NOT_FOUND')
          return value.imageReference
            ? { kind: 'image', name: record.name, nameSource: record.nameSource, localReference }
            : value.documentReference
              ? { kind: getDocumentKind(value.documentReference.mimeType), name: record.name, localReference }
              : { kind: 'text', name: record.name, text: value.text! }
        }, (directive) => {
          if (!composer.resolveDirective)
            throw new AttachmentError('VALIDATION_FAILED')
          return composer.resolveDirective(directive)
        })
      : null
    return {
      documentReferences: materialized.flatMap(item => item.documentReference ? [item.documentReference] : []),
      imageReferences: materialized.flatMap(item => item.imageReference ? [item.imageReference] : []),
      prompt: [projected?.prompt ?? content.trim(), ...materialized.slice(composer?.resourceIds.length ?? 0).map(item => item.section)]
        .filter(Boolean)
        .join('\n\n---\n\n'),
      records,
    }
  }

  getInputMetadata(ids: readonly string[], conversationId: string | null, draftId: string | null = null): AttachmentRecord[] {
    return ids.map(id => this.#requireForPrompt(id, conversationId, draftId))
  }

  async materializeInputResources(input: BuddyInputReferenceV1, conversationId: string, workspace: AttachmentToolWorkspace): Promise<string> {
    const ids = input.attachmentIds ?? [...input.images, ...input.documents ?? []].map(file => file.attachmentId)
    const records = this.getInputMetadata(ids, conversationId)
    const nativeIds = new Set([...input.images, ...input.documents ?? []].map(file => file.attachmentId))
    const labels = input.resourceLabels ?? getAttachmentLabels(records, input.prompt)
    const resources = await Promise.all(records.map(async (record) => {
      const bytes = await this.#readFile(record.storedPath)
      if (bytes.length !== record.sizeBytes || (isDocumentMimeType(record.mimeType) && !hasDocumentSignature(record.mimeType, bytes)))
        throw new AttachmentError('VALIDATION_FAILED')
      const path = await workspace.materialize(record, bytes)
      return {
        attachmentId: record.id,
        label: labels[record.id],
        name: record.name,
        mimeType: record.mimeType,
        path,
        sourcePath: record.sourcePath,
        content: nativeIds.has(record.id) ? 'native' : isTextAttachment(record) ? 'text' : 'file_only',
      }
    }))
    return resources.length ? `<attachment_resources>\n${JSON.stringify(resources)}\n</attachment_resources>` : ''
  }

  async resolveInputReferences(
    ids: readonly string[],
    conversationId: string,
    prompt = '',
  ): Promise<{ images: AttachmentImageReference[], documents: AttachmentDocumentReference[], resourceLabels?: Record<string, string> }> {
    const records = ids.map(id => this.#requireForPrompt(id, conversationId, null))
    validateTotalBytes(records.map(record => record.sizeBytes))
    return {
      resourceLabels: getAttachmentLabels(records, prompt),
      images: records.flatMap(record => (
        record.mimeType.startsWith('image/') && record.mimeType !== 'image/svg+xml'
          ? [toImageReference(record)]
          : []
      )),
      documents: records.filter(record => isDocumentMimeType(record.mimeType)).map(toDocumentReference),
    }
  }

  async materializePiInputImages(
    references: readonly AttachmentImageReference[],
    conversationId: string | null,
    draftId: string | null = null,
  ): Promise<ImageContent[]> {
    const records = references.map((reference) => {
      const record = this.#requireForPrompt(reference.attachmentId, conversationId, draftId)
      if (
        record.mimeType !== reference.mimeType
        || !record.mimeType.startsWith('image/')
        || record.mimeType === 'image/svg+xml'
      ) {
        throw new AttachmentError('VALIDATION_FAILED')
      }
      return record
    })
    validateTotalBytes(records.map(record => record.sizeBytes))
    return Promise.all(records.map(async (record) => {
      try {
        return {
          data: (await this.#readFile(record.storedPath)).toString('base64'),
          mimeType: record.mimeType,
          type: 'image' as const,
        }
      }
      catch (error) {
        if (isFileNotFound(error))
          throw new AttachmentError('ATTACHMENT_NOT_FOUND', { cause: error })
        throw error
      }
    }))
  }

  async materializeDocumentInputs(
    references: readonly AttachmentDocumentReference[],
    conversationId: string | null,
    draftId: string | null = null,
  ): Promise<AttachmentFileInput[]> {
    const records = references.map((reference) => {
      const record = this.#requireForPrompt(reference.attachmentId, conversationId, draftId)
      if (!isDocumentMimeType(record.mimeType) || reference.mimeType !== record.mimeType)
        throw new AttachmentError('VALIDATION_FAILED')
      return record
    })
    validateTotalBytes(records.map(record => record.sizeBytes))
    return Promise.all(records.map(async (record) => {
      try {
        const bytes = await this.#readFile(record.storedPath)
        if (bytes.length !== record.sizeBytes || !hasDocumentSignature(record.mimeType, bytes))
          throw new AttachmentError('VALIDATION_FAILED')
        return { data: bytes.toString('base64'), name: record.name, mimeType: toDocumentReference(record).mimeType }
      }
      catch (error) {
        if (isFileNotFound(error))
          throw new AttachmentError('ATTACHMENT_NOT_FOUND', { cause: error })
        throw error
      }
    }))
  }

  async resolveRecoveryInputReferences(
    ids: readonly string[],
    conversationId: string,
    prompt = '',
  ): Promise<AttachmentRecoveryResult> {
    const resolved = ids.map((id) => {
      try {
        return { id, record: this.#requireForPrompt(id, conversationId, null) }
      }
      catch (error) {
        if (error instanceof AttachmentError && error.code === 'ATTACHMENT_NOT_FOUND')
          return { id, record: null }
        throw error
      }
    })
    validateTotalBytes(resolved.flatMap(item => item.record ? [item.record.sizeBytes] : []))
    const recovered = await Promise.all(resolved.map(async ({ id, record }): Promise<{
      images: AttachmentImageReference[]
      documents?: AttachmentDocumentReference[]
      missingAttachmentId: string | null
    }> => {
      if (!record)
        return { images: [], missingAttachmentId: id }
      try {
        const metadata = await stat(record.storedPath)
        if (!metadata.isFile() || metadata.size !== record.sizeBytes)
          return { images: [], missingAttachmentId: id }
        if (!isDocumentMimeType(record.mimeType) && (!record.mimeType.startsWith('image/') || record.mimeType === 'image/svg+xml'))
          return { images: [], missingAttachmentId: null }
        return isDocumentMimeType(record.mimeType)
          ? { documents: [toDocumentReference(record)], images: [], missingAttachmentId: null }
          : { images: [toImageReference(record)], missingAttachmentId: null }
      }
      catch (error) {
        if (isFileNotFound(error))
          return { images: [], missingAttachmentId: id }
        throw error
      }
    }))
    return {
      resourceLabels: resolved.every(item => item.record) ? getAttachmentLabels(resolved.map(item => item.record!), prompt) : {},
      documents: recovered.flatMap(item => item.documents ?? []),
      images: recovered.flatMap(item => item.images),
      missingAttachmentIds: recovered.flatMap(
        item => item.missingAttachmentId ? [item.missingAttachmentId] : [],
      ),
    }
  }

  #requireAvailable(id: string): AttachmentRecord {
    const record = this.#repository.findById(id)
    if (!record)
      throw new AttachmentError('ATTACHMENT_NOT_FOUND')
    return record
  }

  #requireForPrompt(
    id: string,
    conversationId: string | null,
    draftId: string | null,
  ): AttachmentRecord {
    const record = this.#requireAvailable(id)
    if (record.draftId !== null) {
      if (record.draftId === draftId)
        return record
      throw new AttachmentError('VALIDATION_FAILED')
    }
    if (record.messageId !== null && record.conversationId === conversationId)
      return record
    throw new AttachmentError('VALIDATION_FAILED')
  }

  async #rollbackRegistration(records: readonly AttachmentRecord[]): Promise<void> {
    for (const record of records.toReversed()) {
      await unlinkAvailableFile(record.storedPath).catch(() => undefined)
      try {
        this.#repository.removeDraft(record.id)
      }
      catch {}
    }
  }
}

function toImageReference(record: AttachmentRecord): AttachmentImageReference {
  return { attachmentId: record.id, mimeType: record.mimeType }
}

function toDocumentReference(record: AttachmentRecord): AttachmentDocumentReference {
  if (!isDocumentMimeType(record.mimeType))
    throw new AttachmentError('VALIDATION_FAILED')
  return { attachmentId: record.id, mimeType: record.mimeType }
}

function getDocumentKind(mimeType: string): 'pdf' | 'audio' | 'video' {
  const kind = getAttachmentKind(mimeType)
  if (kind !== 'pdf' && kind !== 'audio' && kind !== 'video')
    throw new AttachmentError('VALIDATION_FAILED')
  return kind
}

function validateTotalBytes(
  sizes: readonly number[],
  limit = BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT,
  errorCode = 'VALIDATION_FAILED',
): void {
  if (sizes.reduce((total, size) => total + size, 0) > limit)
    throw new AttachmentError(errorCode)
}

export class AttachmentError extends Error {
  readonly code: string

  constructor(code: string, options?: ErrorOptions) {
    super('Lexora Buddy attachment operation failed', options)
    this.name = 'AttachmentError'
    this.code = code
  }
}

function safeExtension(path: string): string {
  const extension = extname(path).toLowerCase()
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ''
}

function isTextAttachment(record: AttachmentRecord): boolean {
  return isTextMimeType(record.mimeType)
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || new Set([
    'application/json',
    'application/toml',
    'application/xml',
    'application/yaml',
  ]).has(mimeType)
}

export function normalizeAttachmentMetadata(input: { mimeType: string, name: string, sizeBytes: number }) {
  const name = input.name.trim()
  const mimeType = extname(name).toLowerCase() === '.pdf' || Object.hasOwn(BUDDY_MEDIA_EXTENSIONS, extname(name).toLowerCase()) || textExtensions.has(extname(name).slice(1).toLowerCase())
    ? inferMimeType(name)
    : input.mimeType.trim() || inferMimeType(name)
  if (!name || /[/\\\0]/.test(name) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
    throw new AttachmentError('VALIDATION_FAILED')
  if (!isDocumentMimeType(mimeType) && !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) && !isTextMimeType(mimeType))
    throw new AttachmentError('ATTACHMENT_UNSUPPORTED')
  const byteLimit = isTextMimeType(mimeType)
    ? MAX_TEXT_PROMPT_BYTES
    : isDocumentMimeType(mimeType) && mimeType !== 'application/pdf'
      ? BUDDY_MEDIA_FILE_BYTES_LIMIT
      : BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT
  if (input.sizeBytes > byteLimit)
    throw new AttachmentError('ATTACHMENT_TOO_LARGE')
  if (isDocumentMimeType(mimeType) && input.sizeBytes === 0)
    throw new AttachmentError('ATTACHMENT_INVALID')
  return { mimeType, name, sizeBytes: input.sizeBytes }
}

export function inferMimeType(path: string): string {
  const extension = extname(path).toLowerCase()
  return MIME_TYPES[extension] ?? (textExtensions.has(extension.slice(1)) ? 'text/plain' : 'application/octet-stream')
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

async function publishBytes(bytes: Uint8Array, storedPath: string): Promise<void> {
  const temporaryPath = `${storedPath}.part`
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx', flush: true, mode: 0o600 })
    await rename(temporaryPath, storedPath)
    await syncDirectory(dirname(storedPath))
  }
  finally {
    await unlinkAvailableFile(temporaryPath)
  }
}

async function publishFile(sourcePath: string, storedPath: string): Promise<void> {
  const temporaryPath = `${storedPath}.part`
  try {
    await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
    await chmod(temporaryPath, 0o600)
    const file = await open(temporaryPath, 'r+')
    try {
      await file.sync()
    }
    finally {
      await file.close()
    }
    await rename(temporaryPath, storedPath)
    await syncDirectory(dirname(storedPath))
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

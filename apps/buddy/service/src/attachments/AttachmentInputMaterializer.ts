import type { ImageContent } from '@earendil-works/pi-ai'
import type { BuddyPromptDirective, BuddyUserContentV1, BuddyUserMessageContentV1, BuddyUserMessageResourceSnapshot } from '../../../shared/conversation/buddyUserContent'
import type { InputMaterialProjectionState } from '../../../shared/conversation/inputMaterialProjection'
import type { BuddyInputReferenceV1 } from '../agent/context/BuddyInputReference'
import type { InputModel } from '../providers/modelCapabilities'
import type { AttachmentRecord } from '../storage/attachmentRepository'
import type { AttachmentDocumentReference, AttachmentFileInput } from './AttachmentDocumentReference'
import type { AttachmentImageReference } from './AttachmentImageReference'
import type { PreparedAttachmentImage } from './AttachmentImageStore'
import type { AttachmentInputReader } from './AttachmentInputReader'
import type { AttachmentToolWorkspace } from './AttachmentToolWorkspace'
import type { InputMaterialProjector } from './InputMaterialProjector'
import { isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import { BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT, isTextAttachmentMimeType } from '../../../shared/conversation/attachmentPolicy'
import { AttachmentError } from './AttachmentError'
import { AttachmentImageStore } from './AttachmentImageStore'
import { getAttachmentLabels } from './attachmentLabels'
import { toDocumentReference, toImageReference, validateTotalBytes } from './attachmentMetadata'
import { hasDocumentSignature } from './validateDocumentBytes'

export interface AttachmentRecoveryResult {
  resourceLabels?: Record<string, string>
  documents: AttachmentDocumentReference[]
  images: AttachmentImageReference[]
  missingAttachmentIds: string[]
}

export class AttachmentInputMaterializer {
  readonly #reader: AttachmentInputReader
  readonly #projector: InputMaterialProjector
  readonly #images = new AttachmentImageStore()
  readonly #imageDirectory: (conversationId: string) => string
  readonly #listForConversation: (conversationId: string) => AttachmentRecord[]

  constructor(options: { reader: AttachmentInputReader, projector: InputMaterialProjector, imageDirectory: (conversationId: string) => string, listForConversation: (conversationId: string) => AttachmentRecord[] }) {
    this.#reader = options.reader
    this.#projector = options.projector
    this.#imageDirectory = options.imageDirectory
    this.#listForConversation = options.listForConversation
  }

  async materializeConversationImages(
    conversationId: string,
    ids?: readonly string[],
  ): Promise<{ images: ImageContent[], records: AttachmentRecord[] }> {
    const available = this.#listForConversation(conversationId)
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
    composer?: { content: BuddyUserContentV1, resourceIds: readonly string[], resources?: readonly BuddyUserMessageResourceSnapshot[], resolveDirective?: (directive: BuddyPromptDirective) => string, sourceMessageId?: string, quoteReadAvailable?: boolean, inlineBytes?: number },
  ): Promise<{ documents: AttachmentFileInput[], images: ImageContent[], prompt: string, records: AttachmentRecord[], materialProjection?: InputMaterialProjectionState }> {
    const prepared = await this.#projector.preparePrompt(ids, content, conversationId, draftId, composer)
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

  async materializeInputResources(input: BuddyInputReferenceV1, conversationId: string, workspace: AttachmentToolWorkspace, message?: Pick<BuddyUserMessageContentV1, 'materialProjection' | 'resourceSnapshots'> | null): Promise<string> {
    const ids = input.attachmentIds ?? [...input.images, ...input.documents ?? []].map(file => file.attachmentId)
    const records = ids.map(id => this.#reader.get(id, { conversationId }))
    const nativeIds = new Set([...input.images, ...input.documents ?? []].map(file => file.attachmentId))
    const labels = input.resourceLabels ?? getAttachmentLabels(records, input.prompt)
    const resources = await Promise.all(records.map(async (record) => {
      const bytes = await this.#reader.read(record)
      if (bytes.length !== record.sizeBytes || (isDocumentMimeType(record.mimeType) && !hasDocumentSignature(record.mimeType, bytes)))
        throw new AttachmentError('VALIDATION_FAILED')
      const path = await workspace.materialize(record, bytes)
      const savedResource = message?.resourceSnapshots.find(resource => resource.attachmentId === record.id)
      const deferred = savedResource && message?.materialProjection?.deferredResourceIds.includes(savedResource.resourceId)
      return {
        ...(deferred ? { snapshotRead: { sourceMessageId: input.messageId, referenceId: savedResource.resourceId, kind: 'attachment' } } : {}),
        attachmentId: record.id,
        label: labels[record.id],
        name: record.name,
        mimeType: record.mimeType,
        path,
        sourcePath: record.sourcePath,
        content: nativeIds.has(record.id) ? 'native' : isTextAttachmentMimeType(record.mimeType) && !deferred ? 'text' : 'file_only',
      }
    }))
    return resources.length ? `<attachment_resources>\n${JSON.stringify(resources)}\n</attachment_resources>` : ''
  }

  async resolveInputReferences(
    ids: readonly string[],
    conversationId: string,
    prompt = '',
  ): Promise<{ images: AttachmentImageReference[], documents: AttachmentDocumentReference[], resourceLabels?: Record<string, string> }> {
    const records = ids.map(id => this.#reader.get(id, { conversationId }))
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
      const record = this.#reader.get(reference.attachmentId, { conversationId, draftId })
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
          data: (await this.#reader.read(record)).toString('base64'),
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

  async prepareInputImages(
    references: readonly AttachmentImageReference[],
    conversationId: string,
    model: InputModel,
  ): Promise<ReadonlyMap<string, PreparedAttachmentImage | null>> {
    const images = new Map<string, PreparedAttachmentImage | null>()
    for (const reference of references) {
      const record = this.#reader.get(reference.attachmentId, { conversationId })
      if (record.mimeType !== reference.mimeType)
        throw new AttachmentError('VALIDATION_FAILED')
      const metadata = await this.#reader.inspect(record)
      if (!metadata.isFile || metadata.size !== record.sizeBytes || metadata.size > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT)
        throw new AttachmentError('ATTACHMENT_INVALID')
      const bytes = await this.#reader.read(record)
      const directory = this.#imageDirectory(conversationId)
      images.set(record.id, await this.#images.prepare(record, bytes, directory, model))
    }
    return images
  }

  async materializeDocumentInputs(
    references: readonly AttachmentDocumentReference[],
    conversationId: string | null,
    draftId: string | null = null,
  ): Promise<AttachmentFileInput[]> {
    const records = references.map((reference) => {
      const record = this.#reader.get(reference.attachmentId, { conversationId, draftId })
      if (!isDocumentMimeType(record.mimeType) || reference.mimeType !== record.mimeType)
        throw new AttachmentError('VALIDATION_FAILED')
      return record
    })
    validateTotalBytes(records.map(record => record.sizeBytes))
    return Promise.all(records.map(async (record) => {
      try {
        const bytes = await this.#reader.read(record)
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
        return { id, record: this.#reader.get(id, { conversationId }) }
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
        const metadata = await this.#reader.inspect(record)
        if (!metadata.isFile || metadata.size !== record.sizeBytes)
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
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

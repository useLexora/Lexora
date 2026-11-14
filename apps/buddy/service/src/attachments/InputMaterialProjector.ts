import type { BuddyPromptDirective, BuddyUserContentV1, BuddyUserMessageResourceSnapshot } from '../../../shared/conversation/buddyUserContent'
import type { InputMaterialProjectionState } from '../../../shared/conversation/inputMaterialProjection'
import type { AttachmentRecord } from '../storage/attachmentRepository'
import type { AttachmentDocumentReference } from './AttachmentDocumentReference'
import type { AttachmentImageReference } from './AttachmentImageReference'
import type { AttachmentInputReader } from './AttachmentInputReader'
import { isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import { BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT, isTextAttachmentMimeType } from '../../../shared/conversation/attachmentPolicy'
import { projectBuddyUserContent } from '../../../shared/conversation/buddyUserContentProjection'
import { InputMaterialProjectionBudget, InputMaterialProjectionError } from '../../../shared/conversation/inputMaterialProjection'
import { AttachmentError } from './AttachmentError'
import { getDocumentKind, toDocumentReference, toImageReference, validateTotalBytes } from './attachmentMetadata'

export class InputMaterialProjector {
  readonly #reader: AttachmentInputReader

  constructor(reader: AttachmentInputReader) {
    this.#reader = reader
  }

  async preparePrompt(
    ids: readonly string[],
    content: string,
    conversationId: string | null = null,
    draftId: string | null = null,
    composer?: { content: BuddyUserContentV1, resourceIds: readonly string[], resources?: readonly BuddyUserMessageResourceSnapshot[], resolveDirective?: (directive: BuddyPromptDirective) => string, sourceMessageId?: string, quoteReadAvailable?: boolean, inlineBytes?: number },
    legacyResourceDraftId?: string,
  ): Promise<{ documentReferences: AttachmentDocumentReference[], imageReferences: AttachmentImageReference[], prompt: string, records: AttachmentRecord[], materialProjection?: InputMaterialProjectionState }> {
    const records = ids.map(id => this.#reader.get(id, { conversationId, draftId, legacyResourceDraftId }))
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
        if (!isTextAttachmentMimeType(record.mimeType) || record.sizeBytes > BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT)
          throw new AttachmentError('VALIDATION_FAILED')
        const text = (await this.#reader.read(record)).toString('utf8')
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
    const budget = new InputMaterialProjectionBudget(composer?.inlineBytes)
    let projected
    try {
      projected = composer
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
          }, { sourceMessageId: composer.sourceMessageId, readAvailable: composer.quoteReadAvailable, budget })
        : null
      if (!composer) {
        for (const value of materialized) {
          if (value.text !== null)
            budget.project(value.text, false)
        }
      }
    }
    catch (error) {
      if (error instanceof InputMaterialProjectionError)
        throw new AttachmentError(error.code, { cause: error })
      throw error
    }
    return {
      materialProjection: projected?.materialProjection,
      documentReferences: materialized.flatMap(item => item.documentReference ? [item.documentReference] : []),
      imageReferences: materialized.flatMap(item => item.imageReference ? [item.imageReference] : []),
      prompt: [projected?.prompt ?? content.trim(), ...materialized.slice(composer?.resourceIds.length ?? 0).map(item => item.section)]
        .filter(Boolean)
        .join('\n\n---\n\n'),
      records,
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

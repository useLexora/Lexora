import type { Static } from 'typebox'
import type { AttachmentService } from '../attachments/AttachmentService'
import type { ExtensionReferenceRepository, ReferenceSnapshot } from '../storage/extensionReferenceRepository'
import type { SessionReferenceScope } from '../storage/sessionReferenceRepository'
import type { referenceListParameters, referenceReadParameters } from './referenceSnapshotToolContract'
import { isTextAttachmentMimeType } from '../../../shared/conversation/attachmentPolicy'
import { resourceQuoteSnapshot } from '../../../shared/conversation/buddyResourceQuoteText'
import { readTextMaterialPage, TEXT_MATERIAL_READ_MAX_BYTES } from '../../../shared/conversation/textMaterialRead'

export interface ReferenceSnapshotAccessOptions {
  conversationId: string
  getRunId: () => string | undefined
  references: ExtensionReferenceRepository
  attachments?: Pick<AttachmentService, 'getInputMetadata' | 'readText'>
  signal: AbortSignal
}

export class ReferenceSnapshotAccess {
  readonly options: ReferenceSnapshotAccessOptions

  constructor(options: ReferenceSnapshotAccessOptions) {
    this.options = options
  }

  available(): boolean {
    try {
      const { scope } = this.#capture()
      return this.options.references.snapshots(scope, { offset: 0, limit: 1 }).items.length > 0 || this.options.references.attachmentSnapshots(scope, { limit: 1 }).total > 0
    }
    catch { return false }
  }

  list(input: Static<typeof referenceListParameters>, signal?: AbortSignal) {
    const captured = this.#capture(signal)
    const offset = input.offset ?? 0
    const limit = input.limit ?? 20
    const page = this.options.references.snapshots(captured.scope, { ...input, offset, limit })
    const attachments = this.#attachmentSnapshots(captured.scope, { ...input, offset: Math.max(0, offset - page.total), limit: Math.max(0, limit - page.items.length) })
    const total = page.total + attachments.total
    if (offset > total)
      throw new Error('REFERENCE_OFFSET_OUT_OF_RANGE')
    const items = page.items.map(snapshot => ({ ...referenceMetadata(snapshot), excerpt: readTextMaterialPage(snapshot.quote.text, { limit: 256 }).text }))
    const result = {
      items: [
        ...items,
        ...attachments.items.map(snapshot => ({
          referenceId: snapshot.referenceId,
          sourceMessageId: snapshot.sourceMessageId,
          kind: 'attachment' as const,
          sourceKind: 'attachment',
          title: snapshot.record.name,
          sizeBytes: snapshot.record.sizeBytes,
        })),
      ],
      total,
      nextOffset: offset + limit < total ? offset + limit : null,
    }
    let used = 0
    const bounded = result.items.filter((item) => {
      used += new TextEncoder().encode(JSON.stringify(item)).byteLength
      return used <= TEXT_MATERIAL_READ_MAX_BYTES
    })
    if (bounded.length !== result.items.length) {
      result.items = bounded
      result.nextOffset = offset + bounded.length
    }
    this.#assertCurrent(captured, signal)
    return result
  }

  read(input: Static<typeof referenceReadParameters>, signal?: AbortSignal) {
    if (input.kind === 'attachment')
      throw new Error('REFERENCE_ATTACHMENT_REQUIRES_ASYNC_READ')
    const captured = this.#capture(signal)
    const page = this.options.references.snapshots(captured.scope, { sourceMessageId: input.sourceMessageId, referenceId: input.referenceId, kind: input.kind, offset: 0, limit: 2 })
    const snapshot = page.items[0]
    if (page.total !== 1 || !snapshot)
      throw new Error('REFERENCE_NOT_AUTHORIZED')
    const offset = input.offset ?? 0
    const text = snapshot.quote.text
    if (offset > text.length)
      throw new Error('REFERENCE_OFFSET_OUT_OF_RANGE')
    const result = {
      ...referenceMetadata(snapshot),
      ...readableSourceMetadata(snapshot),
      state: 'snapshot' as const,
      ...readTextMaterialPage(text, { offset, limit: input.limit, maxBytes: TEXT_MATERIAL_READ_MAX_BYTES, maxJsonBytes: TEXT_MATERIAL_READ_MAX_BYTES }),
    }
    this.#assertCurrent(captured, signal)
    return result
  }

  authorizeRead(input: Static<typeof referenceReadParameters>, signal?: AbortSignal) {
    if (input.kind !== 'attachment') {
      this.read(input, signal)
      return
    }
    const captured = this.#capture(signal)
    this.#requireAttachment(captured.scope, input)
    this.#assertCurrent(captured, signal)
  }

  async readMaterial(input: Static<typeof referenceReadParameters>, signal?: AbortSignal) {
    if (input.kind !== 'attachment')
      return this.read(input, signal)
    const captured = this.#capture(signal)
    const snapshot = this.#requireAttachment(captured.scope, input)
    const text = await this.options.attachments!.readText(snapshot.attachmentId, null, captured.scope.conversationId)
    this.#assertCurrent(captured, signal)
    this.#requireAttachment(captured.scope, input)
    return {
      sourceMessageId: snapshot.sourceMessageId,
      referenceId: snapshot.referenceId,
      kind: 'attachment' as const,
      sourceKind: 'attachment',
      title: snapshot.record.name,
      state: 'snapshot' as const,
      ...readTextMaterialPage(text, { offset: input.offset, limit: input.limit, maxBytes: TEXT_MATERIAL_READ_MAX_BYTES, maxJsonBytes: TEXT_MATERIAL_READ_MAX_BYTES }),
    }
  }

  #requireAttachment(scope: SessionReferenceScope, input: { sourceMessageId: string, referenceId: string }) {
    const matches = this.#attachmentSnapshots(scope, { sourceMessageId: input.sourceMessageId, referenceId: input.referenceId, limit: 2 })
    if (matches.total !== 1 || matches.items.length !== 1)
      throw new Error('REFERENCE_NOT_AUTHORIZED')
    return matches.items[0]!
  }

  #attachmentSnapshots(scope: SessionReferenceScope, input: { sourceMessageId?: string, referenceId?: string, offset?: number, limit?: number } = {}) {
    if (!this.options.attachments)
      return { items: [], total: 0 }
    const page = this.options.references.attachmentSnapshots(scope, input)
    const items = page.items.flatMap((snapshot) => {
      try {
        const record = this.options.attachments!.getInputMetadata([snapshot.attachmentId], scope.conversationId)[0]
        return record && isTextAttachmentMimeType(record.mimeType) ? [{ ...snapshot, record }] : []
      }
      catch { return [] }
    })
    return { items, total: page.total }
  }

  #capture(signal?: AbortSignal) {
    this.options.signal.throwIfAborted()
    signal?.throwIfAborted()
    const runId = this.options.getRunId()
    const scope = runId ? this.options.references.activeScope(this.options.conversationId, runId) : null
    if (!runId || !scope)
      throw new Error('REFERENCE_SCOPE_UNAVAILABLE')
    return { runId, scope }
  }

  #assertCurrent(captured: { runId: string, scope: SessionReferenceScope }, signal?: AbortSignal) {
    const current = this.#capture(signal)
    if (current.runId !== captured.runId || current.scope.branchId !== captured.scope.branchId || current.scope.throughSequence !== captured.scope.throughSequence)
      throw new Error('REFERENCE_SCOPE_CHANGED')
  }
}

function referenceMetadata(snapshot: ReferenceSnapshot) {
  return {
    referenceId: snapshot.quote.id,
    sourceMessageId: snapshot.sourceMessageId,
    kind: snapshot.kind,
    sourceKind: snapshot.kind === 'message' ? 'message' : snapshot.quote.source.kind,
    title: snapshot.kind === 'message' ? 'Conversation excerpt' : snapshot.quote.source.title,
    textLength: snapshot.quote.text.length,
  }
}

function readableSourceMetadata(snapshot: ReferenceSnapshot) {
  const { text: _, ...metadata } = snapshot.kind === 'resource'
    ? resourceQuoteSnapshot(snapshot.quote)
    : { text: snapshot.quote.text, source: snapshot.quote.source }
  return new TextEncoder().encode(JSON.stringify(metadata)).byteLength <= 8192
    ? metadata
    : { source: undefined, element: undefined, sourceMetadataOmitted: true }
}

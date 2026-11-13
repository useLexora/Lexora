import type { ArtifactService } from '../artifacts/ArtifactService'
import type { AttachmentService } from '../attachments/AttachmentService'
import type { RunEventReader } from '../events/RunEventPorts'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { ConversationTreeRepository } from '../storage/conversationTreeRepository'
import type { ExecutionRepository } from '../storage/executionRepository'
import type { RunInputRepository } from '../storage/runInputRepository'
import { buddyRunOutputPayloadSchema } from '../../../shared/runs/runOutput'
import { ArtifactError } from '../artifacts/ArtifactService'
import { AttachmentError } from '../attachments/AttachmentService'

export const IMAGE_REFERENCE_LIST_LIMIT = 50

export interface ImageReferenceQuery {
  query?: string
  offset?: number
  limit?: number
}

export interface ImageReferenceItem {
  referenceId: string
  sourceKind: 'attachment' | 'artifact'
  name: string
  path: string
  sourceMessageId: string | null
  sourceRunId: string | null
  mimeType: string
  sizeBytes: number
  createdAt: string
}

export interface ImageReferencePage {
  items: ImageReferenceItem[]
  total: number
  nextOffset: number | null
}

export interface ImageReferenceAccessOptions {
  conversationId: string
  getRunId: () => string | undefined
  signal: AbortSignal
  conversations: Pick<ConversationRepository, 'findById'>
  publications: Pick<ConversationTreeRepository, 'listPublications' | 'getPublicSnapshot'>
  executions: Pick<ExecutionRepository, 'find' | 'listAttachments'>
  inputs: Pick<RunInputRepository, 'findByMessageId'>
  events: Pick<RunEventReader, 'listForRuns'>
  attachments: Pick<AttachmentService, 'getInputMetadata'>
  artifacts: Pick<ArtifactService, 'resolveConversationArtifactLocation'>
}

export class ImageReferenceAccess {
  readonly options: ImageReferenceAccessOptions

  constructor(options: ImageReferenceAccessOptions) {
    this.options = options
  }

  authorize(referenceIds: readonly string[], signal: AbortSignal): void {
    this.options.signal.throwIfAborted()
    signal.throwIfAborted()
    if (referenceIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256))
      throw new Error('IMAGE_REFERENCE_INVALID')
    if (!referenceIds.length)
      return
    const visible = new Set(this.#items(signal, new Set(referenceIds)).map(item => item.referenceId))
    for (const id of referenceIds) {
      if (!visible.has(id))
        throw new Error(`IMAGE_REFERENCE_NOT_VISIBLE: ${id}; use lexora_image_list to find a visible referenceId`)
    }
  }

  list(input: ImageReferenceQuery, signal: AbortSignal): ImageReferencePage {
    const offset = input.offset ?? 0
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > IMAGE_REFERENCE_LIST_LIMIT
      || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256))) {
      throw new Error('IMAGE_REFERENCE_QUERY_INVALID')
    }
    const query = input.query?.trim().toLowerCase() ?? ''
    const items = this.#items(signal).filter(item => !query || [item.referenceId, item.name, item.sourceMessageId, item.sourceRunId]
      .some(value => value?.toLowerCase().includes(query))).sort((left, right) => compare(right.createdAt, left.createdAt) || compare(left.referenceId, right.referenceId) || compare(left.sourceKind, right.sourceKind))
    if (offset > items.length)
      throw new Error('IMAGE_REFERENCE_OFFSET_OUT_OF_RANGE')
    const page: ImageReferenceItem[] = []
    let bytes = 0
    for (const item of items.slice(offset, offset + limit)) {
      const size = new TextEncoder().encode(JSON.stringify(item)).byteLength
      if (bytes + size > 64 * 1024) {
        if (!page.length)
          throw new Error('IMAGE_REFERENCE_METADATA_TOO_LARGE')
        break
      }
      bytes += size
      page.push(item)
    }
    return { items: page, total: items.length, nextOffset: offset + page.length < items.length ? offset + page.length : null }
  }

  #capture(signal: AbortSignal) {
    this.options.signal.throwIfAborted()
    signal.throwIfAborted()
    const runId = this.options.getRunId()
    const execution = runId ? this.options.executions.find(runId) : null
    const task = this.options.conversations.findById(this.options.conversationId)
    if (!execution || !task || task.deletedAt || execution.run.conversationId !== task.id || execution.run.status !== 'running'
      || execution.cancelRequestedAt || execution.phase === 'closing' || execution.phase === 'closed') {
      throw new Error('IMAGE_REFERENCE_SCOPE_UNAVAILABLE')
    }
    return execution
  }

  #items(signal: AbortSignal, requested?: ReadonlySet<string>): ImageReferenceItem[] {
    const execution = this.#capture(signal)
    const { conversationId, branchId, threadId } = execution.run
    const attempts = [execution]
    const runIds = new Set([execution.run.id])
    for (let attempt = execution; attempt.work.previousRunId;) {
      const previous = this.options.executions.find(attempt.work.previousRunId)
      if (!previous || runIds.has(previous.run.id) || previous.run.conversationId !== conversationId
        || previous.run.branchId !== branchId || previous.run.threadId !== threadId || previous.work.workId !== execution.work.workId) {
        throw new Error('IMAGE_REFERENCE_SCOPE_UNAVAILABLE')
      }
      runIds.add(previous.run.id)
      attempts.push(previous)
      attempt = previous
    }
    const items = new Map<string, ImageReferenceItem>()
    const addAttachment = (id: string, sourceMessageId: string | null, sourceRunId: string | null) => {
      if (items.has(id) || (requested && !requested.has(id)))
        return
      try {
        const record = this.options.attachments.getInputMetadata([id], conversationId)[0]
        if (record?.mimeType.startsWith('image/') && record.conversationId === conversationId && record.draftId === null) {
          items.set(id, {
            referenceId: id,
            sourceKind: 'attachment',
            name: record.name.slice(0, 256),
            path: record.storedPath,
            sourceMessageId: sourceMessageId ?? record.messageId,
            sourceRunId,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
            createdAt: record.createdAt,
          })
        }
      }
      catch (error) {
        if (!(error instanceof AttachmentError) || !['ATTACHMENT_NOT_FOUND', 'VALIDATION_FAILED'].includes(error.code))
          throw error
      }
    }
    const addArtifact = (id: string, sourceRunId: string | null, createdAt?: string) => {
      if (requested && !requested.has(id))
        return
      try {
        const { resource, canonicalPath } = this.options.artifacts.resolveConversationArtifactLocation(conversationId, id)
        if (resource.kind !== 'file' || !resource.mimeType.startsWith('image/') || resource.conversationId !== conversationId)
          return
        const item: ImageReferenceItem = {
          referenceId: id,
          sourceKind: 'artifact',
          name: resource.name.slice(0, 256),
          path: canonicalPath,
          sourceMessageId: null,
          sourceRunId,
          mimeType: resource.mimeType,
          sizeBytes: resource.sizeBytes,
          createdAt: createdAt ?? resource.createdAt,
        }
        if (!items.has(id) || items.get(id)!.createdAt < item.createdAt)
          items.set(id, item)
      }
      catch (error) {
        if (!(error instanceof ArtifactError) || error.code !== 'ARTIFACT_NOT_FOUND')
          throw error
      }
    }
    for (const attempt of attempts) {
      signal.throwIfAborted()
      const selected = attempt.work.contextMode === 'isolated' ? new Set(attempt.work.contextSourceIds) : null
      const materials = this.options.publications.listPublications(conversationId, branchId, this.options.publications.getPublicSnapshot(attempt.run.id))
      for (const material of materials) {
        if (selected && !selected.has(material.sourceId))
          continue
        if (material.kind === 'output') {
          for (const artifact of material.artifacts)
            addArtifact(artifact.artifactId, material.runId)
        }
        else if (material.role === 'user') {
          const input = this.options.inputs.findByMessageId(material.messageId)
          for (const id of input?.attachmentIds ?? [])
            addAttachment(id, material.messageId, input!.runId)
        }
      }
    }
    for (const id of this.options.executions.listAttachments(execution.run.id))
      addAttachment(id, null, execution.run.id)
    for (const event of this.options.events.listForRuns([...runIds])) {
      signal.throwIfAborted()
      if (event.type !== 'output.produced' || !runIds.has(event.runId))
        continue
      const output = buddyRunOutputPayloadSchema.safeParse(event.payload)
      if (output.success) {
        for (const id of output.data.artifactIds)
          addArtifact(id, event.runId, event.createdAt)
      }
    }
    const current = this.#capture(signal)
    if (current.run.id !== execution.run.id || current.run.generation !== execution.run.generation
      || current.run.branchId !== branchId || current.run.threadId !== threadId) {
      throw new Error('IMAGE_REFERENCE_SCOPE_CHANGED')
    }
    return [...items.values()]
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

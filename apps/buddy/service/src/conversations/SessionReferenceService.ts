import type { ArtifactService } from '../artifacts/ArtifactService'
import type { AttachmentService } from '../attachments/AttachmentService'
import type { ConversationRecord } from '../storage/conversationRecord'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { ConversationTreeRepository } from '../storage/conversationTreeRepository'
import type { SessionReferenceSource } from './sessionReferenceToolContract'
import { readBuddyUserMessageContent } from '../../../shared/conversation/buddyUserContent'
import { historicalComposerSources } from '../attachments/historicalComposerSources'

import { createSessionQuery, readSessionText, sessionMessageReferences, sessionMessageText } from './sessionReferenceText'

export interface SessionReferenceServices {
  conversations: Pick<ConversationRepository, 'findById' | 'findMessageById' | 'findMessageIdAtOffset' | 'listBranchMessages' | 'listMessagePage'>
  attachments: Pick<AttachmentService, 'listForConversation'>
  artifacts: Pick<ArtifactService, 'resolveConversationArtifactLocation'>
  publications: Pick<ConversationTreeRepository, 'listPublications'>
}

interface SessionResource {
  source: Exclude<SessionReferenceSource, { kind: 'message' }>
  name: string
  kind: 'file' | 'directory'
  mimeType: string
  sizeBytes: number
  createdAt: string
  description: string | null
  storage: 'snapshot' | 'live'
  path: string
}

export class SessionReferenceService {
  readonly #services: SessionReferenceServices

  constructor(services: SessionReferenceServices) {
    this.#services = services
  }

  requireSession(sessionId: string): ConversationRecord & { activeBranchId: string } {
    const target = this.#services.conversations.findById(sessionId)
    if (!target || target.deletedAt !== null || !target.activeBranchId)
      throw new Error('SESSION_REFERENCE_UNAVAILABLE')
    return { ...target, activeBranchId: target.activeBranchId }
  }

  searchResources(target: ConversationRecord, input: { query?: string, resourceOffset?: number }) {
    const match = createSessionQuery(input.query)
    const resources = this.listResources(target).filter(resource => match([resource.name, resource.description, resource.storage === 'live' ? resource.path : null].filter(Boolean).join('\n')) >= 0)
    const offset = input.resourceOffset ?? 0
    const end = offset + 20
    return {
      resources: resources.slice(offset, end).map(({ path, ...resource }) => ({ ...resource, ...(resource.storage === 'live' ? { path } : {}) })),
      nextResourceOffset: end < resources.length ? end : null,
    }
  }

  readMessage(target: ConversationRecord, source: Extract<SessionReferenceSource, { kind: 'message' }>, input: { offset?: number, limit?: number }) {
    const history = this.history(target).filter(message => message.role === 'user' || message.role === 'assistant')
    const index = history.findIndex(message => message.id === source.messageId)
    const message = history[index]
    if (!message)
      throw new Error('SESSION_REFERENCE_SOURCE_UNAVAILABLE')
    const neighbour = (item: typeof message) => ({
      source: { kind: 'message' as const, messageId: item.id },
      role: item.role,
      createdAt: item.createdAt,
      excerpt: sessionMessageText(item.role, item.content).slice(0, 800),
      sessionReferences: sessionMessageReferences(item.role, item.content),
    })
    return {
      source,
      role: message.role,
      runId: message.runId,
      authorActorId: this.#services.publications.listPublications(target.id, target.activeBranchId!).find(material => material.kind === 'message' && material.messageId === message.id)?.actorId ?? null,
      createdAt: message.createdAt,
      sessionReferences: sessionMessageReferences(message.role, message.content),
      ...readSessionText(sessionMessageText(message.role, message.content), input.offset, input.limit),
      before: history.slice(Math.max(0, index - 2), index).map(neighbour),
      after: history.slice(index + 1, index + 3).map(neighbour),
    }
  }

  resolveResource(target: ConversationRecord, source: Exclude<SessionReferenceSource, { kind: 'message' }>): SessionResource {
    const resource = this.listResources(target).find(candidate => sameSource(candidate.source, source))
    if (!resource)
      throw new Error('SESSION_REFERENCE_SOURCE_UNAVAILABLE')
    return resource
  }

  private history(target: ConversationRecord) {
    if (this.requireSession(target.id).activeBranchId !== target.activeBranchId)
      throw new Error('SESSION_REFERENCE_UNAVAILABLE')
    return this.#services.conversations.listBranchMessages(target.id, target.activeBranchId!)
  }

  private listResources(target: ConversationRecord): SessionResource[] {
    const history = this.history(target)
    const attachments = this.#services.attachments.listForConversation(target.id)
    const resources: SessionResource[] = []
    for (const option of historicalComposerSources(history, attachments, target.id, target.activeBranchId!)) {
      const origin = option.source
      if (!('messageId' in origin))
        continue
      const message = history.find(message => message.id === origin.messageId)!
      const source: SessionResource['source'] = 'resourceId' in origin
        ? { kind: 'resource', messageId: origin.messageId, resourceId: origin.resourceId }
        : { kind: 'attachment', messageId: origin.messageId, attachmentId: origin.attachmentId }
      const attachmentId = 'attachmentId' in origin
        ? origin.attachmentId
        : readSnapshotAttachmentId(message.content, origin.resourceId)
      const attachment = attachments.find(item => item.id === attachmentId && item.messageId === message.id)
      if (attachmentId && !attachment)
        continue
      const path = attachment?.storedPath ?? option.path
      if (!path)
        continue
      resources.push({
        source,
        name: option.name,
        kind: option.kind ?? 'file',
        mimeType: option.mimeType,
        sizeBytes: option.sizeBytes,
        createdAt: message.createdAt,
        description: sessionMessageText(message.role, message.content).slice(0, 400) || null,
        storage: attachment ? 'snapshot' : 'live',
        path,
      })
    }
    const artifactIds = new Set(this.#services.publications.listPublications(target.id, target.activeBranchId!).flatMap(material => material.kind === 'output' ? material.artifacts.map(artifact => artifact.artifactId) : []))
    for (const artifactId of artifactIds) {
      const location = this.#services.artifacts.resolveConversationArtifactLocation(target.id, artifactId)
      const artifact = location.resource
      resources.push({
        source: { kind: 'artifact', artifactId },
        name: artifact.name,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        createdAt: artifact.updatedAt,
        description: artifact.relativePath,
        storage: 'live',
        path: location.canonicalPath,
      })
    }
    return resources.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || JSON.stringify(a.source).localeCompare(JSON.stringify(b.source)))
  }
}

function readSnapshotAttachmentId(content: unknown, resourceId: string): string | undefined {
  return readBuddyUserMessageContent(content)?.resourceSnapshots.find(snapshot => snapshot.resourceId === resourceId)?.attachmentId
}

function sameSource(left: SessionReferenceSource, right: SessionReferenceSource): boolean {
  if (left.kind !== right.kind)
    return false
  switch (left.kind) {
    case 'artifact': return right.kind === 'artifact' && left.artifactId === right.artifactId
    case 'attachment': return right.kind === 'attachment' && left.messageId === right.messageId && left.attachmentId === right.attachmentId
    case 'resource': return right.kind === 'resource' && left.messageId === right.messageId && left.resourceId === right.resourceId
    case 'message': return right.kind === 'message' && left.messageId === right.messageId
  }
}

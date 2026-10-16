import type {
  ChatDocumentMessageAttachmentInput,
  ChatDocumentScope,
  ChatMessageAttachmentInput,
  ChatMessageContentJSON,
  ChatPersistedMessageAttachment,
} from '@haohaoxue/lexora-contracts'
import {
  CHAT_CONTEXT_SNAPSHOT_MAX_CONTENT_LENGTH,
  CHAT_MESSAGE_ATTACHMENT_MAX_COUNT,
  CHAT_MESSAGE_ATTACHMENT_PLACEMENT,
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  ChatMessageAttachmentInputSchema,
  ChatMessageContentJSONSchema,
} from '@haohaoxue/lexora-contracts'
import { isChatUploadedMessageAttachment, serializeChatMessageContentJSON } from '@haohaoxue/lexora-shared/chat'
import { BadRequestException, Injectable } from '@nestjs/common'
import { DocumentChatSnapshotService } from '../documents/content/document-chat-snapshot.service'
import { ChatAssetsService } from './chat-assets.service'

export interface ChatContextSnapshotCreateData {
  type: 'document'
  documentId: string
  title: string
  scope: ChatDocumentScope
  size: number
  sourceAttachmentIds: string[]
  content: string
  capturedAt: Date
}

export interface ResolvedChatUserMessageContext {
  content: string
  metadata: {
    contentJSON: ChatMessageContentJSON
    attachments: ChatPersistedMessageAttachment[]
  }
  snapshots: ChatContextSnapshotCreateData[]
  diagnostics: {
    removedInlineAttachmentIds: string[]
    dedupedSnapshotCount: number
  }
}

@Injectable()
export class ChatContextSnapshotsService {
  constructor(
    private readonly documentChatSnapshotService: DocumentChatSnapshotService,
    private readonly chatAssetsService: ChatAssetsService,
  ) {}

  async resolveForUserMessage(input: {
    userId: string
    workspaceId: string
    sessionId?: string
    reusableAssetMessageIds?: string[]
    contentJSON: ChatMessageContentJSON
    attachments?: ChatMessageAttachmentInput[] | null
  }): Promise<ResolvedChatUserMessageContext> {
    const contentJSON = ChatMessageContentJSONSchema.parse(input.contentJSON)
    const serializedContent = serializeChatMessageContentJSON(contentJSON)
    const content = serializedContent.content.trim()

    if (!serializedContent.bodyTextWithoutReferences.trim()) {
      throw new BadRequestException('消息内容不能为空')
    }

    if (content.length > CHAT_MESSAGE_CONTENT_MAX_LENGTH) {
      throw new BadRequestException('消息内容过长')
    }

    const attachments = ChatMessageAttachmentInputSchema
      .array()
      .max(CHAT_MESSAGE_ATTACHMENT_MAX_COUNT)
      .parse(input.attachments ?? [])
    const orderedAttachments = this.normalizeAttachments({
      attachments,
      inlineAttachmentIds: serializedContent.inlineAttachmentIds,
    })
    const snapshotDraftsByKey = new Map<string, ChatContextSnapshotCreateData>()
    const persistedAttachments: ChatPersistedMessageAttachment[] = []
    const documentAttachmentCount = orderedAttachments.attachments.filter(attachment => attachment.type === 'document').length
    const uploadedAttachmentById = await this.chatAssetsService.resolveUploadedAttachments({
      actorId: input.userId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      reusableMessageIds: input.reusableAssetMessageIds,
      attachments: orderedAttachments.attachments,
    })
    const capturedAt = new Date()

    for (const attachment of orderedAttachments.attachments) {
      if (isChatUploadedMessageAttachment(attachment)) {
        const uploadedAttachment = uploadedAttachmentById.get(attachment.id)
        if (!uploadedAttachment) {
          throw new BadRequestException('上传附件不存在或不可访问')
        }
        persistedAttachments.push(uploadedAttachment)
        continue
      }

      const snapshotKey = createSnapshotKey(attachment)
      let snapshot = snapshotDraftsByKey.get(snapshotKey)

      if (!snapshot) {
        const resolvedSnapshot = await this.resolveAttachmentSnapshot({
          userId: input.userId,
          attachment,
        })

        snapshot = {
          type: attachment.type,
          documentId: attachment.documentId,
          title: attachment.title,
          scope: attachment.scope,
          size: resolvedSnapshot.size,
          sourceAttachmentIds: [],
          content: resolvedSnapshot.content,
          capturedAt,
        }
        snapshotDraftsByKey.set(snapshotKey, snapshot)
      }

      snapshot.sourceAttachmentIds.push(attachment.id)
      persistedAttachments.push(toPersistedAttachment(attachment, snapshot.size))
    }

    return {
      content,
      metadata: {
        contentJSON,
        attachments: persistedAttachments,
      },
      snapshots: [...snapshotDraftsByKey.values()],
      diagnostics: {
        removedInlineAttachmentIds: orderedAttachments.removedInlineAttachmentIds,
        dedupedSnapshotCount: documentAttachmentCount - snapshotDraftsByKey.size,
      },
    }
  }

  private normalizeAttachments(input: {
    attachments: ChatMessageAttachmentInput[]
    inlineAttachmentIds: string[]
  }): {
    attachments: ChatMessageAttachmentInput[]
    removedInlineAttachmentIds: string[]
  } {
    const attachmentById = new Map<string, ChatMessageAttachmentInput>()

    for (const attachment of input.attachments) {
      if (attachmentById.has(attachment.id)) {
        throw new BadRequestException('聊天上下文附件 id 不能重复')
      }
      attachmentById.set(attachment.id, attachment)
    }

    const inlineAttachmentIdSet = new Set(input.inlineAttachmentIds)
    const inlineAttachmentsInContentOrder: ChatMessageAttachmentInput[] = []
    const seenInlineAttachmentIds = new Set<string>()

    for (const attachmentId of input.inlineAttachmentIds) {
      const attachment = attachmentById.get(attachmentId)
      if (!attachment) {
        throw new BadRequestException('正文引用的聊天上下文附件不存在')
      }
      if (attachment.type !== 'document') {
        throw new BadRequestException('正文引用只能指向行内文档上下文附件')
      }
      if (attachment.placement !== CHAT_MESSAGE_ATTACHMENT_PLACEMENT.INLINE) {
        throw new BadRequestException('正文引用只能指向行内上下文附件')
      }
      if (seenInlineAttachmentIds.has(attachmentId)) {
        continue
      }

      seenInlineAttachmentIds.add(attachmentId)
      inlineAttachmentsInContentOrder.push(attachment)
    }

    const panelAttachments = input.attachments.filter(attachment =>
      attachment.placement === CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL,
    )
    const removedInlineAttachmentIds = input.attachments
      .filter(attachment =>
        attachment.placement === CHAT_MESSAGE_ATTACHMENT_PLACEMENT.INLINE
        && !inlineAttachmentIdSet.has(attachment.id),
      )
      .map(attachment => attachment.id)

    return {
      attachments: [
        ...panelAttachments,
        ...inlineAttachmentsInContentOrder,
      ],
      removedInlineAttachmentIds,
    }
  }

  private async resolveAttachmentSnapshot(input: {
    userId: string
    attachment: ChatDocumentMessageAttachmentInput
  }): Promise<{
    content: string
    size: number
  }> {
    if (input.attachment.scope.kind === 'selection') {
      if (typeof input.attachment.snapshot !== 'string') {
        throw new BadRequestException('选区上下文缺少发送瞬间快照')
      }

      await this.documentChatSnapshotService.assertReadableDocument({
        userId: input.userId,
        documentId: input.attachment.documentId,
      })

      return this.assertSnapshotSize({
        content: input.attachment.snapshot,
        size: input.attachment.snapshot.length,
      })
    }

    return this.assertSnapshotSize(await this.documentChatSnapshotService.createFullDocumentMarkdownSnapshot({
      userId: input.userId,
      documentId: input.attachment.documentId,
    }))
  }

  private assertSnapshotSize(snapshot: {
    content: string
    size: number
  }): {
    content: string
    size: number
  } {
    if (snapshot.content.length > CHAT_CONTEXT_SNAPSHOT_MAX_CONTENT_LENGTH) {
      throw new BadRequestException('聊天上下文内容过长')
    }

    return snapshot
  }
}

function createSnapshotKey(attachment: ChatDocumentMessageAttachmentInput): string {
  return `${attachment.type}:${attachment.documentId}:${JSON.stringify(attachment.scope)}`
}

function toPersistedAttachment(
  attachment: ChatDocumentMessageAttachmentInput,
  size: number,
): ChatPersistedMessageAttachment {
  return {
    id: attachment.id,
    type: attachment.type,
    placement: attachment.placement,
    documentId: attachment.documentId,
    title: attachment.title,
    scope: attachment.scope,
    size,
  }
}

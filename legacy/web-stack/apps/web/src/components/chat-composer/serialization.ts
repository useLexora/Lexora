import type {
  ChatComposerAttachment,
  ChatComposerContentJSON,
  ChatComposerSerializedContent,
} from './typing'
import {
  CHAT_MESSAGE_ATTACHMENT_PLACEMENT,
} from '@haohaoxue/lexora-contracts/chat/constants'
import { serializeChatMessageContentJSON } from '@haohaoxue/lexora-shared/chat'

export function serializeChatComposerContent(contentJSON: ChatComposerContentJSON): ChatComposerSerializedContent {
  return serializeChatMessageContentJSON(contentJSON)
}

export function garbageCollectInlineAttachments(
  contentJSON: ChatComposerContentJSON,
  attachments: ChatComposerAttachment[],
): ChatComposerAttachment[] {
  const referencedInlineAttachmentIds = new Set(serializeChatComposerContent(contentJSON).inlineAttachmentIds)

  return attachments.filter(attachment =>
    attachment.placement !== CHAT_MESSAGE_ATTACHMENT_PLACEMENT.INLINE
    || referencedInlineAttachmentIds.has(attachment.id),
  )
}

export function createEmptyChatComposerContentJSON(): ChatComposerContentJSON {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
      },
    ],
  }
}

import type {
  AiModelModality,
  ChatMessageAttachmentInput,
  ChatPersistedMessageAttachment,
} from '@haohaoxue/lexora-contracts'
import { AI_MODEL_MODALITY } from '@haohaoxue/lexora-contracts/ai/constants'
import { CHAT_MESSAGE_ATTACHMENT_TYPE } from '@haohaoxue/lexora-contracts/chat/constants'
import { isTextLikeFile } from '../file'

type ChatAttachmentWithType = Pick<ChatMessageAttachmentInput | ChatPersistedMessageAttachment, 'type'> & {
  fileName?: string
  mimeType?: string
}

export function resolveChatAttachmentRequiredInputModalities(
  attachments: readonly ChatAttachmentWithType[],
): AiModelModality[] {
  const modalities = new Set<AiModelModality>()

  for (const attachment of attachments) {
    if (attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.IMAGE) {
      modalities.add(AI_MODEL_MODALITY.IMAGE)
    }
    else if (attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.FILE) {
      modalities.add(resolveFileAttachmentInputModality(attachment))
    }
  }

  return [...modalities]
}

function resolveFileAttachmentInputModality(attachment: ChatAttachmentWithType): AiModelModality {
  return isTextLikeFile(attachment)
    ? AI_MODEL_MODALITY.TEXT
    : AI_MODEL_MODALITY.FILE
}

export function resolveMissingChatAttachmentInputModalities(input: {
  attachments: readonly ChatAttachmentWithType[]
  inputModalities: readonly AiModelModality[]
}): AiModelModality[] {
  const supportedModalities = new Set(input.inputModalities)

  return resolveChatAttachmentRequiredInputModalities(input.attachments)
    .filter(modality => !supportedModalities.has(modality))
}

export function isChatUploadedMessageAttachment(
  attachment: ChatMessageAttachmentInput | ChatPersistedMessageAttachment,
): attachment is Extract<ChatMessageAttachmentInput | ChatPersistedMessageAttachment, { type: 'image' | 'file' }> {
  return attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.IMAGE
    || attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.FILE
}

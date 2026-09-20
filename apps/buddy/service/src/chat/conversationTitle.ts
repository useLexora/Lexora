import type { BuddyUserContentV1 } from '../../../shared/conversation/buddyUserContent'
import type { AttachmentRecord } from '../storage/attachmentRepository'
import { basename } from 'node:path'
import { buddyUserContentToText } from '../../../shared/conversation/buddyUserContent'

export function createConversationTitle(
  content: BuddyUserContentV1,
  attachments: readonly AttachmentRecord[],
): string {
  const text = buddyUserContentToText(content, () => '').trim().replaceAll(/\s+/g, ' ').slice(0, 80)
  return text
    || attachments.map(attachment => basename(attachment.name)).join(', ').slice(0, 80)
    || 'New conversation'
}

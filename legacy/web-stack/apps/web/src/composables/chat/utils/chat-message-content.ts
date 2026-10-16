import type { ChatMessageContentJSON } from '@/apis/chat'

export function createPlainTextChatContentJSON(content: string): ChatMessageContentJSON {
  return {
    type: 'doc',
    content: content.split('\n').map(line => line
      ? {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: line,
            },
          ],
        }
      : {
          type: 'paragraph',
        }),
  }
}

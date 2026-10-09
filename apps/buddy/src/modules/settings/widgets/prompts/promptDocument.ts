import type { JSONContent } from '@tiptap/core'

export function createPromptDocument(content: string): JSONContent {
  return {
    type: 'doc',
    content: content.split('\n').map(text => ({
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : [],
    })),
  }
}

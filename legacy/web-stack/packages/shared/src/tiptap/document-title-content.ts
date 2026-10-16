import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import { createDocumentTitleContent, getDocumentPlainText, getDocumentTitlePlainText } from '../document/core'
import { createEmptyTiptapContent } from './content'

export function toTiptapDocumentTitleEditorContent(content: TiptapJsonContent): TiptapJsonContent {
  const title = getDocumentTitlePlainText(content)

  if (!title) {
    return createEmptyTiptapContent()
  }

  return [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: title }],
    },
  ]
}

export function fromTiptapDocumentTitleEditorContent(content: TiptapJsonContent): TiptapJsonContent {
  return createDocumentTitleContent(getDocumentPlainText(content))
}

import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import { serializeTiptapJsonContentToMarkdownLike } from '@haohaoxue/lexora-shared'

export interface DocumentMarkdownSnapshot {
  content: string
  size: number
}

export function createDocumentMarkdownSnapshot(body: TiptapJsonContent): DocumentMarkdownSnapshot {
  const content = serializeDocumentBodyToMarkdownSnapshot(body)

  return {
    content,
    size: content.length,
  }
}

export function serializeDocumentBodyToMarkdownSnapshot(body: TiptapJsonContent): string {
  return serializeTiptapJsonContentToMarkdownLike(body)
}

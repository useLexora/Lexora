import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import { serializeTiptapJsonContentToMarkdownLike } from '@haohaoxue/lexora-shared/document'

export interface DocsSelectionMarkdownSnapshot {
  snapshot: string
  size: number
}

export function createDocsSelectionMarkdownSnapshot(content: TiptapJsonContent): DocsSelectionMarkdownSnapshot {
  const snapshot = serializeDocsSelectionSnapshotToMarkdownLike(content)

  return {
    snapshot,
    size: snapshot.length,
  }
}

export function serializeDocsSelectionSnapshotToMarkdownLike(content: TiptapJsonContent): string {
  return serializeTiptapJsonContentToMarkdownLike(content)
}

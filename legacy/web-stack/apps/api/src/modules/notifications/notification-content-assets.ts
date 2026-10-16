import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'

interface TiptapContentNode {
  type?: unknown
  attrs?: unknown
  content?: unknown
}

interface TiptapContentNodeAttrs {
  assetId?: unknown
}

export function collectNotificationImageAssetIds(content: TiptapJsonContent): string[] {
  const assetIds = new Set<string>()

  for (const node of content) {
    collectNodeImageAssetIds(node, assetIds)
  }

  return Array.from(assetIds)
}

function collectNodeImageAssetIds(node: unknown, assetIds: Set<string>): void {
  if (!isContentNode(node)) {
    return
  }

  if (node.type === 'image' && isContentNodeAttrs(node.attrs)) {
    const assetId = node.attrs.assetId

    if (typeof assetId === 'string' && assetId.trim()) {
      assetIds.add(assetId.trim())
    }
  }

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      collectNodeImageAssetIds(child, assetIds)
    }
  }
}

function isContentNode(value: unknown): value is TiptapContentNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContentNodeAttrs(value: unknown): value is TiptapContentNodeAttrs {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

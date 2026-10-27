import type { LocalConversationTreeNode } from '@buddy-shared/conversation/conversationTree'

export type ConversationCanvasDirection = 'horizontal' | 'vertical'
export type ConversationCanvasNode = Omit<LocalConversationTreeNode, 'kind'> & {
  kind: LocalConversationTreeNode['kind'] | 'draft'
  canFollowup?: boolean
}
export interface ConversationNodePosition { x: number, y: number, width: number, height: number }

export function layoutConversationCanvas(nodes: readonly ConversationCanvasNode[], direction: ConversationCanvasDirection): ReadonlyMap<string, ConversationNodePosition> {
  const horizontal = direction === 'horizontal'
  const byId = new Map(nodes.map(node => [node.id, node]))
  const children = new Map<string, string[]>()
  const roots: string[] = []
  const sizes = new Map(nodes.map(node => [node.id, conversationNodeSize(node)]))
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) {
      roots.push(node.id)
    }
    else {
      const siblings = children.get(node.parentId) ?? []
      siblings.push(node.id)
      children.set(node.parentId, siblings)
    }
  }
  const order: { id: string, depth: number }[] = []
  const pending = roots.map(id => ({ id, depth: 0 })).reverse()
  while (pending.length) {
    const item = pending.pop()!
    order.push(item)
    for (const id of [...children.get(item.id) ?? []].reverse()) pending.push({ id, depth: item.depth + 1 })
  }
  if (order.length !== nodes.length)
    throw new Error('Invalid conversation tree ancestry')

  const extents = new Map<string, { before: number, after: number }>()
  const childOffsets = new Map<string, number>()
  const rankSizes: number[] = []
  for (const { id, depth } of [...order].reverse()) {
    const { width, height } = sizes.get(id)!
    const cross = (horizontal ? height : width) / 2
    let before = cross
    let after = (horizontal ? height : width) - cross
    const descendants = children.get(id) ?? []
    let offset = 0
    let previous: string | null = null
    for (const child of descendants) {
      if (previous)
        offset += extents.get(previous)!.after + 48 + extents.get(child)!.before
      childOffsets.set(child, offset)
      previous = child
    }
    for (const child of descendants) {
      const centered = childOffsets.get(child)! - offset / 2
      childOffsets.set(child, centered)
      before = Math.max(before, extents.get(child)!.before - centered)
      after = Math.max(after, centered + extents.get(child)!.after)
    }
    extents.set(id, { before, after })
    rankSizes[depth] = Math.max(rankSizes[depth] ?? 0, horizontal ? width : height)
  }
  const ranks: number[] = [0]
  for (let rank = 1; rank < rankSizes.length; rank++)
    ranks[rank] = ranks[rank - 1]! + rankSizes[rank - 1]! + (horizontal ? 104 : 80)
  const centers = new Map<string, number>()
  let rootStart = 0
  for (const id of roots) {
    const extent = extents.get(id)!
    centers.set(id, rootStart + extent.before)
    rootStart += extent.before + extent.after + 72
  }
  const positions = new Map<string, ConversationNodePosition>()
  for (const { id, depth } of order) {
    const { width, height } = sizes.get(id)!
    const center = centers.get(id)!
    const main = ranks[depth]!
    const cross = center - (horizontal ? height : width) / 2
    positions.set(id, { width, height, x: horizontal ? main : cross, y: horizontal ? cross : main })
    for (const child of children.get(id) ?? []) centers.set(child, center + childOffsets.get(child)!)
  }
  return positions
}

export function conversationNodeSize(node: ConversationCanvasNode) {
  if (node.kind === 'draft')
    return { width: 320, height: 128 }
  const busy = node.status === 'running' || node.status === 'queued'
  const sections = [node.attachmentCount ? 44 : 0, node.quoteCount ? 88 : 0, busy ? 152 : node.text ? 88 : 0, node.artifactCount ? 68 : 0].filter(Boolean)
  const bodyHeight = sections.length ? sections.reduce((sum, height) => sum + height, 0) + (sections.length - 1) * 8 + 12 : 0
  return {
    width: busy ? 352 : 320,
    height: 44 + bodyHeight + (node.metadata ? 30 : 0) + 2,
  }
}

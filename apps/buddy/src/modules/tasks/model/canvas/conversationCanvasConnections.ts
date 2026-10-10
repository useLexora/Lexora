import type { ConversationCanvasDirection, ConversationNodePosition } from './conversationCanvasLayout'

export function conversationCanvasConnection(source: ConversationNodePosition, target: ConversationNodePosition, direction: ConversationCanvasDirection) {
  const horizontal = direction === 'horizontal'
  const sourceAnchor = horizontal
    ? { x: source.width, y: source.height / 2 }
    : { x: source.width / 2, y: source.height }
  const targetAnchor = horizontal
    ? { x: 0, y: target.height / 2 }
    : { x: target.width / 2, y: 0 }
  const start = { x: source.x + sourceAnchor.x, y: source.y + sourceAnchor.y }
  const end = { x: target.x + targetAnchor.x, y: target.y + targetAnchor.y }
  if (horizontal) {
    const mid = (start.x + end.x) / 2
    return { sourceAnchor, targetAnchor, vertices: [{ x: mid, y: start.y }, { x: mid, y: end.y }] }
  }
  const mid = (start.y + end.y) / 2
  return {
    sourceAnchor,
    targetAnchor,
    vertices: [{ x: start.x, y: mid }, { x: end.x, y: mid }],
  }
}

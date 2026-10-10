import type { ConversationCanvasDirection, ConversationCanvasNode } from '../conversationCanvasLayout'
import { describe, expect, it } from 'vitest'
import { conversationCanvasConnection } from '../conversationCanvasConnections'
import { conversationNodeSize, layoutConversationCanvas } from '../conversationCanvasLayout'

describe('conversation canvas layout', () => {
  it.each<ConversationCanvasDirection>(['horizontal', 'vertical'])('keeps branching cards apart in %s layout, including running cards', (direction) => {
    const nodes = [{ ...node('q', null), attachmentCount: 1 }, { ...node('a1', 'q'), status: 'running' as const, artifactCount: 2 }, node('a2', 'q'), { ...node('q2', 'a1'), attachmentCount: 3, quoteCount: 4 }, node('a3', 'q2')]
    const positions = layoutConversationCanvas(nodes, direction)
    for (const left of nodes) {
      const first = positions.get(left.id)!
      for (const right of nodes.filter(node => node.id !== left.id)) {
        const second = positions.get(right.id)!
        expect(first.x + first.width <= second.x || second.x + second.width <= first.x
          || first.y + first.height <= second.y || second.y + second.height <= first.y).toBe(true)
      }
      if (left.parentId) {
        const parent = positions.get(left.parentId)!
        expect(direction === 'horizontal' ? first.x > parent.x + parent.width : first.y > parent.y + parent.height).toBe(true)
      }
    }
    expect(layoutConversationCanvas(nodes.map(node => ({ ...node, text: 'streaming answer'.repeat(100) })), direction)).toEqual(positions)
  })

  it.each<ConversationCanvasDirection>(['horizontal', 'vertical'])('connects card boundaries and includes inline resources in %s layout', (direction) => {
    const source = { ...node('a', null), artifactCount: 3 }
    const target = { ...node('q', 'a'), attachmentCount: 1, quoteCount: 1 }
    const positions = layoutConversationCanvas([source, target], direction)
    const from = conversationNodeSize(source)
    const to = conversationNodeSize(target)
    expect(from.width).toBe(to.width)
    expect(from.height).toBeGreaterThan(conversationNodeSize(node('a', null)).height)
    expect(to.height).toBeGreaterThan(conversationNodeSize(node('q', 'a')).height)
    const first = positions.get('a')!
    const second = positions.get('q')!
    const connection = conversationCanvasConnection(first, second, direction)
    if (direction === 'horizontal') {
      expect(first.y + from.height / 2).toBe(second.y + to.height / 2)
      expect(connection.sourceAnchor).toEqual({ x: from.width, y: from.height / 2 })
      expect(connection.targetAnchor).toEqual({ x: 0, y: to.height / 2 })
      expect(connection.vertices.every(vertex => vertex.x > first.x + from.width && vertex.x < second.x)).toBe(true)
    }
    else {
      expect(first.x).toBe(second.x)
      expect(connection.sourceAnchor).toEqual({ x: from.width / 2, y: from.height })
      expect(connection.targetAnchor).toEqual({ x: to.width / 2, y: 0 })
      expect(connection.vertices.every(vertex => vertex.y > first.y + from.height && vertex.y < second.y)).toBe(true)
    }
  })

  it('lays out deep history without recursion and rejects cycles', () => {
    const nodes = Array.from({ length: 10000 }, (_, index) => node(String(index), index ? String(index - 1) : null))
    expect(layoutConversationCanvas(nodes, 'vertical').size).toBe(10000)
    expect(() => layoutConversationCanvas([node('a', 'b'), node('b', 'a')], 'vertical')).toThrow('ancestry')
  })
})

function node(id: string, parentId: string | null): ConversationCanvasNode {
  return { id, parentId, branchId: 'branch', kind: id.startsWith('q') ? 'question' : 'answer', messageId: id, runId: null, text: 'preview', quotes: [], quoteCount: 0, attachments: [], attachmentCount: 0, artifacts: [], artifactCount: 0, metadata: null, status: null, active: false, toolCount: 0, attempts: [] }
}

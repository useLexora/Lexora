import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Selection } from '@tiptap/pm/state'
import { NodeSelection } from '@tiptap/pm/state'
import { isAddressableBodyBlock } from '../content/blockId'

export interface CurrentBlockSelection {
  node: ProseMirrorNode
  parent: ProseMirrorNode
  index: number
  from: number
  to: number
}

export function getCurrentBlock(selection: Selection): CurrentBlockSelection | null {
  const { $from } = selection

  if (selection instanceof NodeSelection) {
    const parent = $from.parent

    if (isAddressableBodyBlock(selection.node, parent)) {
      return {
        node: selection.node,
        parent,
        index: $from.index(),
        from: selection.from,
        to: selection.to,
      }
    }
  }

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    const parent = $from.node(depth - 1)

    if (!isAddressableBodyBlock(node, parent)) {
      continue
    }

    return {
      node,
      parent,
      index: $from.index(depth - 1),
      from: $from.before(depth),
      to: $from.after(depth),
    }
  }

  return null
}

export function findBlockById(doc: ProseMirrorNode, blockId: string): CurrentBlockSelection | null {
  let matchedBlock: CurrentBlockSelection | null = null

  doc.descendants((node, pos, parent, index) => {
    if (matchedBlock || !shouldUseMatchedBlock(node, blockId, parent)) {
      return
    }

    const matchedParent = parent!

    matchedBlock = {
      node,
      parent: matchedParent,
      index,
      from: pos,
      to: pos + node.nodeSize,
    }
  })

  return matchedBlock
}

function shouldUseMatchedBlock(
  node: ProseMirrorNode,
  blockId: string,
  parent: ProseMirrorNode | null,
) {
  if (!parent || !isAddressableBodyBlock(node, parent)) {
    return false
  }

  return typeof node.attrs.id === 'string' && node.attrs.id === blockId
}

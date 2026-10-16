import type { CommandProps } from '@tiptap/core'
import type { Selection as ProseMirrorSelection } from '@tiptap/pm/state'
import type { CurrentBlockSelection } from '../currentBlock'
import { NodeSelection, Selection } from '@tiptap/pm/state'
import { TIPTAP_STRUCTURAL_BACKSPACE_BOUNDARY_NODE_NAMES } from '../../content/blockTaxonomy'
import { getCurrentBlock } from '../currentBlock'

const STRUCTURAL_BACKSPACE_BOUNDARY_NODE_NAMES = new Set<string>(TIPTAP_STRUCTURAL_BACKSPACE_BOUNDARY_NODE_NAMES)

type LexoraBackspaceAction
  = | { type: 'reset-empty-heading' }
    | {
      type: 'move-into-previous-structural-boundary'
      currentBlock: CurrentBlockSelection
      deleteCurrentBlock: boolean
      selection: ProseMirrorSelection
    }
    | { type: 'preserve-current-caret-landing' }
    | {
      type: 'select-previous-structural-boundary'
      boundary: StructuralBackspaceBoundary
    }

interface StructuralBackspaceBoundary {
  from: number
}

export function runLexoraBackspacePolicy(props: CommandProps) {
  const action = resolveLexoraBackspaceAction(props.tr.selection)

  if (!action) {
    return false
  }

  switch (action.type) {
    case 'reset-empty-heading':
      return props.commands.setNode('paragraph')
    case 'move-into-previous-structural-boundary': {
      if (action.deleteCurrentBlock) {
        props.tr.delete(action.currentBlock.from, action.currentBlock.to)
        props.tr.setSelection(action.selection.map(props.tr.doc, props.tr.mapping))
        props.tr.scrollIntoView()
        return true
      }

      props.tr.setSelection(action.selection)
      props.tr.scrollIntoView()
      return true
    }
    case 'preserve-current-caret-landing':
      // 找不到可落入的文本位置时故意吞掉 Backspace，避免 fallback 误删前序结构块。
      return true
    case 'select-previous-structural-boundary':
      props.tr.setSelection(NodeSelection.create(props.tr.doc, action.boundary.from))
      props.tr.scrollIntoView()
      return true
  }
}

export function resolveLexoraBackspaceAction(
  selection: ProseMirrorSelection,
): LexoraBackspaceAction | null {
  if (shouldResetEmptyHeading(selection)) {
    return { type: 'reset-empty-heading' }
  }

  const currentBlock = getCurrentBlock(selection)
  const boundary = currentBlock ? resolvePreviousStructuralBackspaceBoundary(currentBlock) : null

  if (!currentBlock || !boundary) {
    return null
  }

  if (currentBlock.node.content.size === 0) {
    return resolveEmptyBlockAfterStructuralBoundaryAction(selection, currentBlock)
  }

  return {
    type: 'select-previous-structural-boundary',
    boundary,
  }
}

function shouldResetEmptyHeading(selection: ProseMirrorSelection) {
  return selection.empty
    && selection.$from.parentOffset === 0
    && selection.$from.parent.type.name === 'heading'
    && selection.$from.parent.content.size === 0
}

function resolvePreviousStructuralBackspaceBoundary(
  currentBlock: CurrentBlockSelection,
): StructuralBackspaceBoundary | null {
  if (currentBlock.index <= 0) {
    return null
  }

  const node = currentBlock.parent.child(currentBlock.index - 1)

  if (!STRUCTURAL_BACKSPACE_BOUNDARY_NODE_NAMES.has(node.type.name)) {
    return null
  }

  return {
    from: currentBlock.from - node.nodeSize,
  }
}

function resolveEmptyBlockAfterStructuralBoundaryAction(
  selection: ProseMirrorSelection,
  currentBlock: CurrentBlockSelection,
): LexoraBackspaceAction {
  const previousTextSelection = Selection.findFrom(
    selection.$from.doc.resolve(currentBlock.from),
    -1,
    true,
  )

  if (!previousTextSelection) {
    return { type: 'preserve-current-caret-landing' }
  }

  return {
    type: 'move-into-previous-structural-boundary',
    currentBlock,
    deleteCurrentBlock: currentBlock.index < currentBlock.parent.childCount - 1,
    selection: previousTextSelection,
  }
}

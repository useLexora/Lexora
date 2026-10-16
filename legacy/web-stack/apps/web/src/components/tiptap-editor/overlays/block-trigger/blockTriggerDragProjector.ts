import type { Editor } from '@tiptap/core'
import type { EditorBlockPlacement } from '../../commands/editorActions'
import { translate } from '@/i18n'
import { findBlockById, getCurrentBlock } from '../../commands/currentBlock'
import { findBlockElement, readBlockPreviewText } from './blockTriggerDom'

export interface BlockDropTarget {
  blockId: string
  placement: EditorBlockPlacement
  top: number
  left: number
  width: number
}

interface SiblingBlockCandidate {
  blockId: string
  targetBlock: NonNullable<ReturnType<typeof findBlockById>>
  rect: DOMRect
}

export interface BlockDragSource {
  currentBlock: NonNullable<ReturnType<typeof getCurrentBlock>>
  blockId: string
  element: HTMLElement
  previewText: string
}

export function resolveBlockDragSource(editor: Editor): BlockDragSource | null {
  const currentBlock = getCurrentBlock(editor.state.selection)
  const blockId = readBlockId(currentBlock?.node)
  const element = blockId ? findBlockElement(editor, blockId) : null

  if (!currentBlock || !blockId || !element) {
    return null
  }

  return {
    currentBlock,
    blockId,
    element,
    previewText: readBlockPreviewText(element) || getBlockPreviewFallback(currentBlock),
  }
}

export function projectBlockDropTarget(
  editor: Editor,
  sourceBlockId: string,
  clientX: number,
  clientY: number,
): BlockDropTarget | null {
  if (!(editor.view.dom instanceof HTMLElement)) {
    return null
  }

  const sourceBlock = getCurrentBlock(editor.state.selection)

  if (!sourceBlock || !isPointInsideEditor(editor, clientX, clientY)) {
    return null
  }

  const siblingCandidates = collectSiblingBlockCandidates(editor, sourceBlock)
  const dropCandidates = siblingCandidates.filter(candidate => candidate.blockId !== sourceBlockId)

  if (!dropCandidates.length) {
    return null
  }

  const nearestCandidate = dropCandidates.reduce((bestCandidate, currentCandidate) =>
    getVerticalDistance(currentCandidate.rect, clientY) < getVerticalDistance(bestCandidate.rect, clientY)
      ? currentCandidate
      : bestCandidate,
  )
  const placement = clientY <= nearestCandidate.rect.top + nearestCandidate.rect.height / 2
    ? 'before'
    : 'after'

  if (isNoopDrop(sourceBlock, nearestCandidate.targetBlock.index, placement)) {
    return null
  }

  return {
    blockId: nearestCandidate.blockId,
    placement,
    top: resolveDropIndicatorTop(siblingCandidates, nearestCandidate, placement),
    left: nearestCandidate.rect.left,
    width: nearestCandidate.rect.width,
  }
}

export function isPointInsideEditor(editor: Editor, clientX: number, clientY: number) {
  if (!(editor.view.dom instanceof HTMLElement)) {
    return false
  }

  const editorRect = editor.view.dom.getBoundingClientRect()

  return clientX >= editorRect.left
    && clientX <= editorRect.right
    && clientY >= editorRect.top
    && clientY <= editorRect.bottom
}

function collectSiblingBlockCandidates(
  editor: Editor,
  sourceBlock: NonNullable<ReturnType<typeof getCurrentBlock>>,
) {
  return Array.from(editor.view.dom.querySelectorAll<HTMLElement>('[data-block-id]')).flatMap((element) => {
    const blockId = element.dataset.blockId

    if (!blockId) {
      return []
    }

    const targetBlock = findBlockById(editor.state.doc, blockId)

    if (!targetBlock || targetBlock.parent !== sourceBlock.parent) {
      return []
    }

    return [{
      blockId,
      targetBlock,
      rect: element.getBoundingClientRect(),
    }] satisfies SiblingBlockCandidate[]
  })
}

function getVerticalDistance(rect: DOMRect, clientY: number) {
  if (clientY < rect.top) {
    return rect.top - clientY
  }

  if (clientY > rect.bottom) {
    return clientY - rect.bottom
  }

  return 0
}

function isNoopDrop(
  sourceBlock: NonNullable<ReturnType<typeof getCurrentBlock>>,
  targetIndex: number,
  placement: EditorBlockPlacement,
) {
  if (placement === 'before' && targetIndex === sourceBlock.index + 1) {
    return true
  }

  if (placement === 'after' && targetIndex === sourceBlock.index - 1) {
    return true
  }

  return false
}

function resolveDropIndicatorTop(
  siblingCandidates: SiblingBlockCandidate[],
  targetCandidate: SiblingBlockCandidate,
  placement: EditorBlockPlacement,
) {
  const sortedCandidates = [...siblingCandidates].sort((left, right) => left.targetBlock.index - right.targetBlock.index)
  const targetIndex = sortedCandidates.findIndex(candidate => candidate.blockId === targetCandidate.blockId)

  if (targetIndex === -1) {
    return placement === 'before' ? targetCandidate.rect.top : targetCandidate.rect.bottom
  }

  if (placement === 'before') {
    const previousCandidate = sortedCandidates[targetIndex - 1]

    if (!previousCandidate) {
      return targetCandidate.rect.top - 8
    }

    return (previousCandidate.rect.bottom + targetCandidate.rect.top) / 2
  }

  const nextCandidate = sortedCandidates[targetIndex + 1]

  if (!nextCandidate) {
    return targetCandidate.rect.bottom + 8
  }

  return (targetCandidate.rect.bottom + nextCandidate.rect.top) / 2
}

function getBlockPreviewFallback(currentBlock: NonNullable<ReturnType<typeof getCurrentBlock>>) {
  switch (currentBlock.node.type.name) {
    case 'heading':
      return translate('editor.common.heading')
    case 'blockquote':
      return translate('editor.common.blockquote')
    case 'codeBlock':
      return translate('editor.common.codeBlock')
    case 'blockMath':
      return translate('editor.common.blockMath')
    case 'horizontalRule':
      return translate('editor.common.divider')
    case 'taskItem':
      return translate('editor.common.taskList')
    case 'listItem':
      return currentBlock.parent.type.name === 'orderedList'
        ? translate('editor.common.orderedList')
        : translate('editor.common.bulletList')
    default:
      return translate('editor.common.paragraph')
  }
}

function readBlockId(node?: { attrs?: Record<string, unknown> } | null) {
  return typeof node?.attrs?.id === 'string' ? node.attrs.id : null
}

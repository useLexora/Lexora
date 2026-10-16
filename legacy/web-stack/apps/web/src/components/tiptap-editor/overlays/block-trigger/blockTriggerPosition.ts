import type { Editor } from '@tiptap/core'
import { getCurrentBlock } from '../../commands/currentBlock'
import { resolveCurrentBlockElement } from './blockTriggerDom'

const LIST_BLOCK_NODE_TYPES = new Set(['listItem', 'taskItem'])
const LIST_MARKER_SAFE_OFFSET = 18

export function resolveBlockTriggerAnchorRect(editor: Editor): DOMRect {
  const currentBlock = getCurrentBlock(editor.state.selection)

  if (!currentBlock) {
    throw new Error('[lexora:tiptap] Current selection does not resolve to a block node. Cannot position block menu.')
  }

  if (!(editor.view.dom instanceof HTMLElement) || typeof editor.view.dom.getBoundingClientRect !== 'function') {
    throw new TypeError('[lexora:tiptap] Editor view is missing the ProseMirror root node. Cannot position block menu.')
  }

  const blockElement = resolveCurrentBlockElement(editor, currentBlock)
  const blockRect = blockElement.getBoundingClientRect()
  const lineRect = resolveBlockFirstLineRect(currentBlock.node.type.name, blockElement)
  const anchorLeft = resolveBlockTriggerAnchorLeft(currentBlock.node.type.name, blockElement, blockRect.left)
  const data = {
    top: lineRect.top,
    bottom: lineRect.bottom,
    left: anchorLeft,
    right: anchorLeft,
    width: 0,
    height: Math.max(lineRect.bottom - lineRect.top, 0),
    x: anchorLeft,
    y: lineRect.top,
  }

  return {
    ...data,
    toJSON: () => data,
  } satisfies DOMRect
}

function resolveBlockTriggerAnchorLeft(nodeTypeName: string, blockElement: HTMLElement, fallbackLeft: number) {
  if (!LIST_BLOCK_NODE_TYPES.has(nodeTypeName)) {
    return fallbackLeft
  }

  const listElement = blockElement.closest<HTMLElement>('ul, ol')

  if (!listElement) {
    return fallbackLeft
  }

  const listLeft = listElement.getBoundingClientRect().left
  return Math.min(Math.max(listLeft, fallbackLeft - LIST_MARKER_SAFE_OFFSET), fallbackLeft)
}

function resolveBlockFirstLineRect(nodeTypeName: string, blockElement: HTMLElement) {
  const lineHost = resolveBlockFirstLineHost(nodeTypeName, blockElement)

  return resolveFirstTextLineRect(lineHost)
    ?? resolveFirstChildLineRect(lineHost)
    ?? lineHost.getBoundingClientRect()
}

function resolveBlockFirstLineHost(nodeTypeName: string, blockElement: HTMLElement) {
  if (!LIST_BLOCK_NODE_TYPES.has(nodeTypeName)) {
    return blockElement
  }

  return Array.from(blockElement.children).find((child): child is HTMLElement =>
    child instanceof HTMLElement
    && !isListStructureElement(child),
  ) ?? blockElement
}

function isListStructureElement(element: HTMLElement) {
  return element.matches('ul, ol, label, input')
    || element.getAttribute('contenteditable') === 'false'
}

function resolveFirstTextLineRect(blockElement: HTMLElement) {
  const textNode = findFirstTextNode(blockElement)

  if (!textNode) {
    return null
  }

  const range = blockElement.ownerDocument.createRange()
  const text = textNode.data
  const startOffset = Math.max(text.search(/\S/), 0)
  const endOffset = Math.min(startOffset + 1, text.length)

  if (endOffset <= startOffset) {
    return null
  }

  range.setStart(textNode, startOffset)
  range.setEnd(textNode, endOffset)

  const rect = readFirstUsableRangeRect(range)
  range.detach?.()

  return rect
}

function findFirstTextNode(blockElement: HTMLElement) {
  const walker = blockElement.ownerDocument.createTreeWalker(blockElement, NodeFilter.SHOW_TEXT)
  let currentNode = walker.nextNode()

  while (currentNode) {
    if (currentNode instanceof Text && currentNode.data.length > 0) {
      return currentNode
    }

    currentNode = walker.nextNode()
  }

  return null
}

function readFirstUsableRangeRect(range: Range) {
  if (typeof range.getClientRects !== 'function') {
    return null
  }

  const rects = Array.from(range.getClientRects())
  return rects.find(isUsableLineRect) ?? null
}

function resolveFirstChildLineRect(blockElement: HTMLElement) {
  return Array.from(blockElement.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .map(child => child.getBoundingClientRect())
    .find(isUsableLineRect) ?? null
}

function isUsableLineRect(rect: DOMRect | DOMRectReadOnly) {
  return Number.isFinite(rect.top)
    && Number.isFinite(rect.bottom)
    && rect.bottom > rect.top
}

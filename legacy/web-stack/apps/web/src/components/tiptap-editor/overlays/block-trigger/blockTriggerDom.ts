import type { Editor } from '@tiptap/core'
import type { CurrentBlockSelection } from '../../commands/currentBlock'

const FLASHED_BLOCK_CLASS = 'tiptap-block-flash-target'
const flashedBlockTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

export function findBlockElement(editor: Editor, blockId: string) {
  if (!(editor.view.dom instanceof HTMLElement)) {
    return null
  }

  return editor.view.dom.querySelector<HTMLElement>(`[data-block-id="${blockId}"], [id="${blockId}"]`)
}

export function scrollDocumentBlockIntoView(editor: Editor, blockId: string) {
  const blockElement = findBlockElement(editor, blockId)

  if (!blockElement) {
    return false
  }

  blockElement.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  })

  return true
}

export function flashDocumentBlock(editor: Editor, blockId: string) {
  const blockElement = findBlockElement(editor, blockId)

  if (!blockElement) {
    return false
  }

  const previousTimer = flashedBlockTimers.get(blockElement)

  if (previousTimer) {
    clearTimeout(previousTimer)
  }

  blockElement.classList.remove(FLASHED_BLOCK_CLASS)
  void blockElement.offsetWidth
  blockElement.classList.add(FLASHED_BLOCK_CLASS)

  const nextTimer = setTimeout(() => {
    blockElement.classList.remove(FLASHED_BLOCK_CLASS)
    flashedBlockTimers.delete(blockElement)
  }, 1600)

  flashedBlockTimers.set(blockElement, nextTimer)
  return true
}

export function resolveCurrentBlockElement(editor: Editor, currentBlock: CurrentBlockSelection) {
  const directElement = normalizeBlockElement(readBlockNodeDom(editor, currentBlock.from))

  if (directElement) {
    return directElement
  }

  const blockId = readBlockId(currentBlock.node)

  if (blockId) {
    const matchedElement = findBlockElement(editor, blockId)

    if (matchedElement) {
      return matchedElement
    }
  }

  throw new TypeError('[lexora:tiptap] Current block is missing an available DOM node. Cannot position block menu.')
}

export function readBlockPreviewText(blockElement: HTMLElement) {
  const clone = blockElement.cloneNode(true) as HTMLElement

  clone.querySelectorAll<HTMLElement>('[data-block-id]').forEach((element) => {
    element.remove()
  })

  return normalizeBlockPreviewText(clone.textContent || '')
}

function readBlockNodeDom(editor: Editor, position: number) {
  const view = editor.view as {
    nodeDOM?: (position: number) => unknown
  }

  return typeof view.nodeDOM === 'function' ? view.nodeDOM(position) : null
}

function normalizeBlockElement(nodeDom: unknown) {
  if (nodeDom instanceof HTMLElement) {
    return nodeDom.closest<HTMLElement>('[data-block-id]') ?? nodeDom
  }

  if (nodeDom instanceof Text) {
    return nodeDom.parentElement?.closest<HTMLElement>('[data-block-id]')
      ?? nodeDom.parentElement
      ?? null
  }

  return null
}

function normalizeBlockPreviewText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function readBlockId(node?: { attrs?: Record<string, unknown> } | null) {
  return typeof node?.attrs?.id === 'string' ? node.attrs.id : null
}

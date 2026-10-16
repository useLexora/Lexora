import type { TiptapJsonContent, TiptapJsonNode } from '@haohaoxue/lexora-contracts'
import { TIPTAP_BODY_BLOCK_ID_ATTRIBUTE } from '@haohaoxue/lexora-contracts/tiptap/constants'

export function unwrapTiptapContent(content: TiptapJsonNode): TiptapJsonContent {
  if (!Array.isArray(content.content) || !content.content.length) {
    return []
  }

  const normalizedContent = content.content.map(normalizeTiptapJsonNode)

  return isEmptyParagraphContent(normalizedContent) ? [] : normalizedContent
}

export function wrapTiptapContent(content: TiptapJsonContent): TiptapJsonNode {
  return {
    type: 'doc',
    content: content.length ? content : createEmptyTiptapContent(),
  }
}

export function createEmptyTiptapContent(): TiptapJsonContent {
  return [{ type: 'paragraph' }]
}

function isEmptyParagraphContent(content: TiptapJsonContent) {
  if (content.length !== 1) {
    return false
  }

  return isEmptyParagraphNode(content[0])
}

function isEmptyParagraphNode(node: TiptapJsonNode | undefined) {
  if (!node || node.type !== 'paragraph') {
    return false
  }

  if (!Array.isArray(node.content) || node.content.length === 0) {
    return true
  }

  return node.content.every(child =>
    child?.type === 'text' && typeof child.text === 'string' && child.text.length === 0,
  )
}

function normalizeTiptapJsonNode(node: TiptapJsonNode): TiptapJsonNode {
  const normalizedNode = normalizeDefinedObject(node) as TiptapJsonNode

  if (node.attrs) {
    const attrs = Object.fromEntries(
      Object.entries(node.attrs).filter(([key, value]) =>
        value !== undefined
        && !(key === TIPTAP_BODY_BLOCK_ID_ATTRIBUTE && value === null),
      ),
    )

    if (Object.keys(attrs).length) {
      normalizedNode.attrs = attrs
    }
    else {
      delete normalizedNode.attrs
    }
  }

  if (Array.isArray(node.content)) {
    normalizedNode.content = node.content.map(normalizeTiptapJsonNode)
  }

  if (Array.isArray(node.marks)) {
    normalizedNode.marks = node.marks.map((mark) => {
      const normalizedMark = normalizeDefinedObject(mark)

      if (!mark.attrs) {
        return normalizedMark
      }

      const attrs = Object.fromEntries(
        Object.entries(mark.attrs).filter(([, value]) => value !== undefined),
      )

      if (Object.keys(attrs).length) {
        normalizedMark.attrs = attrs
      }
      else {
        delete normalizedMark.attrs
      }

      return normalizedMark
    })
  }

  return normalizedNode
}

function normalizeDefinedObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T
}

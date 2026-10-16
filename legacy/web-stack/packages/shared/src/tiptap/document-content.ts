import type { TiptapJsonContent, TiptapJsonNode } from '@haohaoxue/lexora-contracts'
import {
  TIPTAP_BODY_BLOCK_ID_ATTRIBUTE,
  TIPTAP_BODY_BLOCK_ID_NODE_TYPES,
  TIPTAP_BODY_BLOCK_ID_PATTERN,
  TIPTAP_BODY_NESTED_PARAGRAPH_PARENT_NODE_TYPES,
  TIPTAP_CODE_BLOCK_TAB_SIZES,
} from '@haohaoxue/lexora-contracts/tiptap/document-body'
import { getSchema } from '@tiptap/core'
import { wrapTiptapContent } from './content'
import { createTiptapDocumentBodySchemaExtensions } from './document-schema'

const documentBodySchema = getSchema(createTiptapDocumentBodySchemaExtensions())
const bodyBlockIdNodeTypeSet = new Set<string>(TIPTAP_BODY_BLOCK_ID_NODE_TYPES)
const nestedParagraphParentNodeTypeSet = new Set<string>(TIPTAP_BODY_NESTED_PARAGRAPH_PARENT_NODE_TYPES)
type TiptapSchema = ReturnType<typeof getSchema>

export function isValidTiptapDocumentBodyContent(content: TiptapJsonContent): boolean {
  try {
    if (!hasKnownNodeShape(documentBodySchema, wrapTiptapContent(content))) {
      return false
    }

    documentBodySchema.nodeFromJSON(wrapTiptapContent(content)).check()
    return hasValidBlockIdentities(content)
  }
  catch {
    return false
  }
}

function hasValidBlockIdentities(content: TiptapJsonContent): boolean {
  const seenBlockIds = new Set<string>()

  return content.every(node => hasValidBlockIdentity(node, null, seenBlockIds))
}

function hasValidBlockIdentity(
  node: TiptapJsonNode,
  parentNodeType: string | null,
  seenBlockIds: Set<string>,
): boolean {
  const nodeType = node.type

  if (!nodeType) {
    return false
  }

  if (!hasValidCriticalAttributeValues(node)) {
    return false
  }

  const blockId = node.attrs?.[TIPTAP_BODY_BLOCK_ID_ATTRIBUTE]
  const isNestedParagraph = nodeType === 'paragraph'
    && parentNodeType !== null
    && nestedParagraphParentNodeTypeSet.has(parentNodeType)
  const requiresBlockId = bodyBlockIdNodeTypeSet.has(nodeType) && !isNestedParagraph

  if (requiresBlockId) {
    if (
      typeof blockId !== 'string'
      || !TIPTAP_BODY_BLOCK_ID_PATTERN.test(blockId)
      || seenBlockIds.has(blockId)
    ) {
      return false
    }

    seenBlockIds.add(blockId)
  }
  else if (blockId !== undefined && blockId !== null) {
    return false
  }

  return node.content?.every(child => hasValidBlockIdentity(child, nodeType, seenBlockIds)) ?? true
}

function hasValidCriticalAttributeValues(node: TiptapJsonNode): boolean {
  const attrs = node.attrs ?? {}

  switch (node.type) {
    case 'paragraph':
      return isOptionalTextAlign(attrs.textAlign)
    case 'heading':
      return isOptionalTextAlign(attrs.textAlign)
        && (attrs.level === undefined || attrs.level === null || isHeadingLevel(attrs.level))
    case 'taskItem':
      return attrs.checked === undefined || attrs.checked === null || typeof attrs.checked === 'boolean'
    case 'codeBlock':
      return isOptionalString(attrs.language)
        && isOptionalString(attrs.name)
        && (attrs.collapsed === undefined || attrs.collapsed === null || typeof attrs.collapsed === 'boolean')
        && (
          attrs.tabSize === undefined
          || attrs.tabSize === null
          || TIPTAP_CODE_BLOCK_TAB_SIZES.includes(attrs.tabSize as typeof TIPTAP_CODE_BLOCK_TAB_SIZES[number])
        )
    case 'inlineMath':
    case 'blockMath':
      return isOptionalString(attrs.latex)
    case 'image':
      return isNonEmptyString(attrs.assetId)
        && isOptionalString(attrs.alt)
        && isOptionalPositiveNumber(attrs.width)
        && isOptionalPositiveNumber(attrs.height)
        && isOptionalTextAlign(attrs.textAlign)
        && isOptionalString(attrs.caption)
    case 'file':
      return isNonEmptyString(attrs.assetId)
    default:
      return true
  }
}

function isHeadingLevel(value: unknown): boolean {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5
}

function isOptionalTextAlign(value: unknown): boolean {
  return value === undefined || value === null || value === 'left' || value === 'center' || value === 'right'
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function isOptionalPositiveNumber(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasKnownNodeShape(schema: TiptapSchema, node: TiptapJsonNode): boolean {
  if (!node.type) {
    return false
  }

  const nodeType = schema.nodes[node.type]

  if (!nodeType || !hasKnownAttributes(node.attrs, nodeType.spec.attrs ?? {})) {
    return false
  }

  if (node.marks?.some((mark) => {
    const markType = schema.marks[mark.type]
    return !markType || !hasKnownAttributes(mark.attrs, markType.spec.attrs ?? {})
  })) {
    return false
  }

  return node.content?.every(child => hasKnownNodeShape(schema, child)) ?? true
}

function hasKnownAttributes(
  attributes: Record<string, unknown> | undefined,
  attributeSpec: Record<string, unknown>,
): boolean {
  return !attributes || Object.keys(attributes).every(attribute => attribute in attributeSpec)
}

import {
  TIPTAP_BODY_BLOCK_ID_ALPHABET,
  TIPTAP_BODY_BLOCK_ID_ATTRIBUTE,
  TIPTAP_BODY_BLOCK_ID_NODE_TYPES,
  TIPTAP_BODY_BLOCK_ID_PATTERN,
  TIPTAP_BODY_BLOCK_ID_PREFIX,
  TIPTAP_BODY_BLOCK_ID_SUFFIX_LENGTH,
} from '@haohaoxue/lexora-contracts/tiptap/document-body'
import { customAlphabet } from 'nanoid'
import { TIPTAP_NESTED_PARAGRAPH_PARENT_NODE_NAMES } from './blockTaxonomy'

export const BODY_BLOCK_ID_ATTRIBUTE = TIPTAP_BODY_BLOCK_ID_ATTRIBUTE
export const BODY_BLOCK_ID_NODE_TYPES = TIPTAP_BODY_BLOCK_ID_NODE_TYPES

export type BodyBlockIdNodeType = (typeof TIPTAP_BODY_BLOCK_ID_NODE_TYPES)[number]

interface BodyBlockIdNodeLike {
  isBlock: boolean
  type: {
    name: string
  }
}

interface BodyBlockIdParentLike {
  type?: {
    name?: string
  }
}

const BODY_BLOCK_ID_NODE_TYPE_SET = new Set<string>(BODY_BLOCK_ID_NODE_TYPES)
const NESTED_PARAGRAPH_PARENT_NODE_TYPE_SET = new Set<string>(TIPTAP_NESTED_PARAGRAPH_PARENT_NODE_NAMES)

const createBlockIdSuffix = customAlphabet(TIPTAP_BODY_BLOCK_ID_ALPHABET, TIPTAP_BODY_BLOCK_ID_SUFFIX_LENGTH)

export function createBlockId(_nodeType: BodyBlockIdNodeType) {
  return `${TIPTAP_BODY_BLOCK_ID_PREFIX}${createBlockIdSuffix()}`
}

export function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && TIPTAP_BODY_BLOCK_ID_PATTERN.test(value)
}

export function isBodyBlockIdNodeTypeName(value: string): value is BodyBlockIdNodeType {
  return BODY_BLOCK_ID_NODE_TYPE_SET.has(value)
}

export function isAddressableBodyBlock(
  node: BodyBlockIdNodeLike,
  parent: BodyBlockIdParentLike | null | undefined,
): boolean {
  if (!node.isBlock || !isBodyBlockIdNodeTypeName(node.type.name)) {
    return false
  }

  if (node.type.name !== 'paragraph') {
    return true
  }

  const parentTypeName = parent?.type?.name

  return !parentTypeName || !NESTED_PARAGRAPH_PARENT_NODE_TYPE_SET.has(parentTypeName)
}

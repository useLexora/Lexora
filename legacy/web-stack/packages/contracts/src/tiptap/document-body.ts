export const TIPTAP_BODY_BLOCK_ID_PREFIX = 'block_' as const
export const TIPTAP_BODY_BLOCK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz' as const
export const TIPTAP_BODY_BLOCK_ID_SUFFIX_LENGTH = 12 as const
export const TIPTAP_BODY_BLOCK_ID_PATTERN = new RegExp(
  `^${TIPTAP_BODY_BLOCK_ID_PREFIX}[0-9a-z]{${TIPTAP_BODY_BLOCK_ID_SUFFIX_LENGTH}}$`,
)
export { TIPTAP_BODY_BLOCK_ID_ATTRIBUTE } from './constants'
export const TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE = 2 as const
export const TIPTAP_CODE_BLOCK_TAB_SIZES = [2, 4, 8] as const
export const TIPTAP_BODY_BLOCK_ID_NODE_TYPES = [
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'blockMath',
  'table',
  'image',
  'file',
] as const
export const TIPTAP_BODY_NESTED_PARAGRAPH_PARENT_NODE_TYPES = [
  'blockquote',
  'listItem',
  'taskItem',
  'tableCell',
  'tableHeader',
] as const
export const TIPTAP_DOCUMENT_FILE_NODE_TYPE = 'document-file' as const
export const TIPTAP_DOCUMENT_FILE_NODE_PART = {
  TITLE: 'title',
  META: 'meta',
} as const

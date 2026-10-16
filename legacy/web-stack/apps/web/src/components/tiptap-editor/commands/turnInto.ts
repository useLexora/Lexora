export const TURN_INTO_BLOCK_TYPES = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'bulletList',
  'orderedList',
  'codeBlock',
  'blockMath',
  'blockquote',
  'divider',
  'taskList',
] as const

export type TurnIntoBlockType = (typeof TURN_INTO_BLOCK_TYPES)[number]

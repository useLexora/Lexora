import type { Editor } from '@tiptap/core'
import type {
  BubbleToolbarAction,
  IndentAction,
  InlineMarkAction,
  TextAlignAction,
} from './actionRegistry'
import {
  canIndentBlock,
  canOutdentBlock,
  getCurrentTextAlign,
  isInlineSelectionMarkFullyActive,
} from '../../commands/editorActions'

export const TEXT_ALIGN_ACTION_TARGETS = {
  'align-left': 'left',
  'align-center': 'center',
  'align-right': 'right',
} as const satisfies Record<TextAlignAction, 'left' | 'center' | 'right'>

const BUBBLE_ACTIVE_HANDLERS: Partial<Record<BubbleToolbarAction, (editor: Editor) => boolean>> = {
  'bold': (editor: Editor) => isInlineSelectionMarkFullyActive(editor, 'bold'),
  'italic': (editor: Editor) => isInlineSelectionMarkFullyActive(editor, 'italic'),
  'underline': (editor: Editor) => isInlineSelectionMarkFullyActive(editor, 'underline'),
  'strike': (editor: Editor) => isInlineSelectionMarkFullyActive(editor, 'strike'),
  'code': (editor: Editor) => isInlineSelectionMarkFullyActive(editor, 'code'),
  'align-left': (editor: Editor) => getCurrentTextAlign(editor) === 'left',
  'align-center': (editor: Editor) => getCurrentTextAlign(editor) === 'center',
  'align-right': (editor: Editor) => getCurrentTextAlign(editor) === 'right',
  'link': (editor: Editor) => isInlineSelectionMarkFullyActive(editor, 'link'),
}

const INDENT_DISABLED_HANDLERS: Record<IndentAction, (editor: Editor) => boolean> = {
  indent: (editor: Editor) => !canIndentBlock(editor),
  outdent: (editor: Editor) => !canOutdentBlock(editor),
}

export function isBubbleActionActive(editor: Editor, action: BubbleToolbarAction) {
  return BUBBLE_ACTIVE_HANDLERS[action]?.(editor) ?? false
}

export function isBubbleActionDisabled(editor: Editor, action: BubbleToolbarAction) {
  if (isIndentAction(action)) {
    return INDENT_DISABLED_HANDLERS[action](editor)
  }

  return false
}

export function isIndentDisabled(editor: Editor, action: IndentAction) {
  return INDENT_DISABLED_HANDLERS[action](editor)
}

export function isInlineMarkAction(action: BubbleToolbarAction): action is InlineMarkAction {
  return action === 'bold'
    || action === 'italic'
    || action === 'underline'
    || action === 'strike'
    || action === 'code'
}

export function isTextAlignAction(action: BubbleToolbarAction): action is TextAlignAction {
  return action === 'align-left'
    || action === 'align-center'
    || action === 'align-right'
}

export function isIndentAction(action: BubbleToolbarAction): action is IndentAction {
  return action === 'indent' || action === 'outdent'
}

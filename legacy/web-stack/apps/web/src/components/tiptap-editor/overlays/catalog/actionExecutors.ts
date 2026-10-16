import type { Editor } from '@tiptap/core'
import type { EditorSelectionRange } from '../../commands/editorActions'
import type { TurnIntoBlockType } from '../../commands/turnInto'
import type { MenuActionEffects } from './actionEffects'
import type {
  BlockMenuLeafAction,
  BubbleToolbarAction,
  IndentAction,
  InlineMarkAction,
  InsertQuickAction,
  MenuActionRegistry,
  TextAlignAction,
} from './actionRegistry'
import { translate } from '@/i18n'
import {
  applyHighlightColor as applyEditorHighlightColor,
  applyTextAlign as applyEditorTextAlign,
  applyTextColor as applyEditorTextColor,
  deleteCurrentBlock,
  indentBlock,
  outdentBlock,
  toggleInlineMark,
  turnIntoBlock,
} from '../../commands/editorActions'
import { copyCurrentBlockToClipboard, cutCurrentBlockToClipboard } from '../../content/blockClipboard'
import {
  isIndentAction,
  isInlineMarkAction,
  isTextAlignAction,
  TEXT_ALIGN_ACTION_TARGETS,
} from './actionState'

/** 菜单动作执行器。 */
export interface MenuActionExecutors {
  /** 执行气泡工具栏动作 */
  executeBubbleAction: MenuActionRegistry['bubble']['execute']
  /** 执行文本对齐动作 */
  executeTextAlignAction: MenuActionRegistry['align']['executeTextAlign']
  /** 执行缩进动作 */
  executeIndentAction: MenuActionRegistry['align']['executeIndent']
  /** 执行块菜单叶子动作 */
  executeLeafAction: MenuActionRegistry['leaf']['execute']
  /** 执行快捷插入动作 */
  executeQuickInsertAction: MenuActionRegistry['quickInsert']['execute']
  /** 执行块转换动作 */
  executeTurnIntoAction: MenuActionRegistry['turnInto']['execute']
  /** 应用文字颜色 */
  applyTextColor: MenuActionRegistry['colors']['applyText']
  /** 应用背景颜色 */
  applyBackgroundColor: MenuActionRegistry['colors']['applyBackground']
  /** 处理上传插入 */
  handleFileInsert: MenuActionRegistry['uploads']['handleFileInsert']
}

export function createMenuActionExecutors(
  editor: Editor,
  effects: MenuActionEffects,
): MenuActionExecutors {
  const inlineMarkExecutors: Record<InlineMarkAction, () => void> = {
    bold: () => toggleInlineMark(editor, 'bold'),
    italic: () => toggleInlineMark(editor, 'italic'),
    underline: () => toggleInlineMark(editor, 'underline'),
    strike: () => toggleInlineMark(editor, 'strike'),
    code: () => toggleInlineMark(editor, 'code'),
  }

  const textAlignExecutors: Record<TextAlignAction, () => void> = {
    'align-left': () => effects.runAndCloseMenu(() => applyEditorTextAlign(editor, TEXT_ALIGN_ACTION_TARGETS['align-left'])),
    'align-center': () => effects.runAndCloseMenu(() => applyEditorTextAlign(editor, TEXT_ALIGN_ACTION_TARGETS['align-center'])),
    'align-right': () => effects.runAndCloseMenu(() => applyEditorTextAlign(editor, TEXT_ALIGN_ACTION_TARGETS['align-right'])),
  }

  const indentExecutors: Record<IndentAction, () => void> = {
    indent: () => effects.runAndCloseMenu(() => indentBlock(editor)),
    outdent: () => effects.runAndCloseMenu(() => outdentBlock(editor)),
  }

  const leafExecutors: Record<BlockMenuLeafAction, () => Promise<void> | void> = {
    comment: effects.requestComment,
    cut: () => effects.runClipboardAction(() => cutCurrentBlockToClipboard(editor), translate('editor.common.cutFailed')),
    copy: () => effects.runClipboardAction(() => copyCurrentBlockToClipboard(editor), translate('editor.common.copyFailed')),
    delete: () => effects.runAndCloseMenu(() => deleteCurrentBlock(editor)),
  }

  const quickInsertExecutors: Record<InsertQuickAction, () => Promise<void> | void> = {
    'insert-link': effects.openEmptyBlockLinkPanel,
    'insert-inline-math': () => effects.runAndCloseMenu(() => insertInlineMath(editor)),
    'insert-image': effects.pickImage,
    'insert-file': effects.pickFile,
  }

  return {
    executeBubbleAction,
    executeTextAlignAction,
    executeIndentAction,
    executeLeafAction,
    executeQuickInsertAction,
    executeTurnIntoAction,
    applyTextColor,
    applyBackgroundColor,
    handleFileInsert: effects.handleFileInsert,
  }

  function executeBubbleAction(action: BubbleToolbarAction) {
    if (isInlineMarkAction(action)) {
      return inlineMarkExecutors[action]()
    }

    if (isTextAlignAction(action)) {
      return textAlignExecutors[action]()
    }

    if (isIndentAction(action)) {
      return indentExecutors[action]()
    }

    if (action === 'link') {
      return effects.toggleLinkPanel()
    }

    if (action === 'edit-image-alt') {
      return effects.editImageAlt()
    }

    if (action === 'add-selection-context') {
      return effects.requestAddSelectionContext()
    }

    return leafExecutors.comment()
  }

  function executeTextAlignAction(action: TextAlignAction) {
    return textAlignExecutors[action]()
  }

  function executeIndentAction(action: IndentAction) {
    return indentExecutors[action]()
  }

  function executeLeafAction(action: BlockMenuLeafAction) {
    return leafExecutors[action]()
  }

  function executeQuickInsertAction(action: InsertQuickAction) {
    return quickInsertExecutors[action]()
  }

  function executeTurnIntoAction(target: TurnIntoBlockType) {
    effects.runAndCloseMenu(() => turnIntoBlock(editor, target))
  }

  function applyTextColor(color: string, range?: EditorSelectionRange) {
    effects.runAndCloseMenu(() => applyEditorTextColor(editor, color, range))
  }

  function applyBackgroundColor(color: string, range?: EditorSelectionRange) {
    effects.runAndCloseMenu(() => applyEditorHighlightColor(editor, color, range))
  }
}

function insertInlineMath(editor: Editor) {
  const position = editor.state.selection.from

  editor
    .chain()
    .focus()
    .insertContent({
      type: 'inlineMath',
      attrs: {
        latex: '',
      },
    })
    .setNodeSelection(position)
    .run()
}

import type { Editor } from '@tiptap/core'
import type { Ref } from 'vue'
import type { EditorSelectionRange } from '../../commands/editorActions'
import type { TurnIntoBlockType } from '../../commands/turnInto'
import type { TiptapEditorUploadedFile, TiptapEditorUploadedImage } from '../../content/typing'
import type {
  TiptapEditorCommentRequest,
  TiptapEditorCommentTriggerSource,
} from '../../core/typing'
import type { LinkPanelController } from '../shared/useLinkPanel'
import { createMenuActionEffects } from './actionEffects'
import { createMenuActionExecutors } from './actionExecutors'
import {
  isBubbleActionActive,
  isBubbleActionDisabled,
  isIndentDisabled,
} from './actionState'

export type InlineMarkAction = 'bold' | 'italic' | 'underline' | 'strike' | 'code'
export type TextAlignAction = 'align-left' | 'align-center' | 'align-right'
export type IndentAction = 'indent' | 'outdent'
export type BlockMenuAlignAction = TextAlignAction | IndentAction
export type BubbleToolbarAction
  = | BlockMenuAlignAction
    | InlineMarkAction
    | 'link'
    | 'comment'
    | 'add-selection-context'
    | 'edit-image-alt'
export type BlockMenuQuickAction = 'turn-into' | 'insert-link' | 'insert-inline-math' | 'insert-image' | 'insert-file'
export type BlockMenuLeafAction = 'comment' | 'cut' | 'copy' | 'delete'
export type InsertQuickAction = Exclude<BlockMenuQuickAction, 'turn-into'>

/** 菜单动作注册表参数 */
export interface MenuActionRegistryOptions {
  /** 编辑器实例 */
  editor: Editor
  /** 链接面板控制器 */
  linkPanel?: LinkPanelController
  /** 菜单关闭能力 */
  closeMenu?: () => void
  /** 评论请求回调 */
  onRequestComment?: (request: TiptapEditorCommentRequest) => void
  onRequestAddSelectionContext?: () => void
  /** 评论来源 */
  commentSource?: TiptapEditorCommentTriggerSource
  /** 图片选择输入框 */
  imageInputRef?: Ref<HTMLInputElement | null>
  /** 文件选择输入框 */
  fileInputRef?: Ref<HTMLInputElement | null>
  /** 图片上传能力 */
  uploadImage?: (file: File) => Promise<TiptapEditorUploadedImage>
  /** 文件上传能力 */
  uploadFile?: (file: File) => Promise<TiptapEditorUploadedFile>
}

/** 菜单动作注册表 */
export interface MenuActionRegistry {
  /** 选择工具栏动作 */
  bubble: {
    isActive: (action: BubbleToolbarAction) => boolean
    isDisabled: (action: BubbleToolbarAction) => boolean
    execute: (action: BubbleToolbarAction) => Promise<void> | void
  }
  /** 对齐与缩进动作 */
  align: {
    isIndentDisabled: (action: IndentAction) => boolean
    executeTextAlign: (action: TextAlignAction) => void
    executeIndent: (action: IndentAction) => void
  }
  /** 块菜单叶子动作 */
  leaf: {
    execute: (action: BlockMenuLeafAction) => Promise<void> | void
  }
  /** 快捷插入动作 */
  quickInsert: {
    execute: (action: InsertQuickAction) => Promise<void> | void
  }
  /** 块转换动作 */
  turnInto: {
    execute: (target: TurnIntoBlockType) => void
  }
  /** 颜色动作 */
  colors: {
    applyText: (color: string, range?: EditorSelectionRange) => void
    applyBackground: (color: string, range?: EditorSelectionRange) => void
  }
  /** 上传动作 */
  uploads: {
    handleFileInsert: (event: Event, kind: 'image' | 'file') => Promise<void>
  }
}

export function createMenuActionRegistry(options: MenuActionRegistryOptions): MenuActionRegistry {
  const { editor } = options
  const effects = createMenuActionEffects(options)
  const executors = createMenuActionExecutors(editor, effects)

  return {
    bubble: {
      isActive(action) {
        return isBubbleActionActive(editor, action)
      },
      isDisabled(action) {
        return isBubbleActionDisabled(editor, action)
      },
      execute: executors.executeBubbleAction,
    },
    align: {
      isIndentDisabled(action) {
        return isIndentDisabled(editor, action)
      },
      executeTextAlign: executors.executeTextAlignAction,
      executeIndent: executors.executeIndentAction,
    },
    leaf: {
      execute: executors.executeLeafAction,
    },
    quickInsert: {
      execute: executors.executeQuickInsertAction,
    },
    turnInto: {
      execute: executors.executeTurnIntoAction,
    },
    colors: {
      applyText: executors.applyTextColor,
      applyBackground: executors.applyBackgroundColor,
    },
    uploads: {
      handleFileInsert: executors.handleFileInsert,
    },
  }
}

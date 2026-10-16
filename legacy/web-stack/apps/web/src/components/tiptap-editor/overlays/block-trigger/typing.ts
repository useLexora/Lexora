import type { Editor } from '@tiptap/core'
import type { TiptapEditorUploadedFile, TiptapEditorUploadedImage } from '../../content/typing'
import type { TiptapEditorBlockContextRequest, TiptapEditorCommentRequest } from '../../core/typing'

/**
 * 块触发菜单属性。
 */
export interface BlockTriggerMenuProps {
  /** 编辑器实例 */
  editor: Editor
  /** 图片上传能力 */
  uploadImage?: (file: File) => Promise<TiptapEditorUploadedImage>
  /** 文件上传能力 */
  uploadFile?: (file: File) => Promise<TiptapEditorUploadedFile>
  /** 是否显示块级 AI 重写入口 */
  aiBlockRewriteEnabled?: boolean
}

/**
 * 块触发菜单事件。
 */
export interface BlockTriggerMenuEmits {
  requestComment: [request: TiptapEditorCommentRequest]
  requestAiBlockRewrite: [request: TiptapEditorBlockContextRequest]
}

/**
 * 块触发菜单暴露能力。
 */
export interface BlockTriggerMenuExposed {
  openMenu: () => boolean
}

import type { DocumentPageWidthMode, TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import type {
  TiptapEditorBlockContextRequest,
  TiptapEditorCommentRequest,
  TiptapEditorSelectionContextRequest,
} from '../../core/typing'
import type { DocumentBodyEditorAiDraftPreview } from '../body/typing'

/**
 * 文档内容面页脚元信息。
 */
export interface DocumentContentSurfaceFooterMetaItem {
  /** 元信息名称 */
  label: string
  /** 元信息展示值 */
  value: string
}

/**
 * 文档内容面属性。
 */
export interface DocumentContentSurfaceProps {
  /** 文档 ID */
  documentId?: string | null
  /** 标题内容 */
  title: TiptapJsonContent
  /** 正文内容 */
  body: TiptapJsonContent
  /** 是否可编辑 */
  editable?: boolean
  /** 是否应自动聚焦标题 */
  autofocusTitle?: boolean
  /** 当前 URL 对应的块 ID */
  activeBlockId?: string | null
  /** 页面宽度模式 */
  pageWidthMode?: DocumentPageWidthMode
  /** 是否展示大纲 */
  showOutline?: boolean
  /** 页脚元信息 */
  footerMetaItems?: DocumentContentSurfaceFooterMetaItem[]
  /**
   * 正文 AI 候选修改
   * @description 本地预览，不写入正式正文
   */
  bodyAiDraftPreview?: DocumentBodyEditorAiDraftPreview | null
  /**
   * 是否显示正文块级 AI 重写入口
   * @description 只控制入口，目标状态由上层页面能力维护
   */
  bodyAiBlockRewriteEnabled?: boolean
}

/**
 * 文档内容面事件。
 */
export interface DocumentContentSurfaceEmits {
  updateTitle: [title: TiptapJsonContent]
  updateContent: [content: TiptapJsonContent]
  contentError: [error: Error]
  requestComment: [request: TiptapEditorCommentRequest]
  requestAddSelectionContext: [request: TiptapEditorSelectionContextRequest]
  requestBodyAiBlockRewrite: [request: TiptapEditorBlockContextRequest]
  selectionChange: [request: TiptapEditorSelectionContextRequest]
  acceptBodyAiDraftPreview: [candidateId: string]
  rejectBodyAiDraftPreview: [candidateId: string]
  titleAutofocusApplied: []
}

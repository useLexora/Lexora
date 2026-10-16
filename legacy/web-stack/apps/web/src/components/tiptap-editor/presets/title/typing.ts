import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'

export interface DocumentTitleEditorProps {
  /**
   * 标题
   * @description 文档标题轻量内容
   */
  title: TiptapJsonContent
  /**
   * 是否自动聚焦
   * @description 新建文档后一次性把光标放到标题上
   */
  autofocus?: boolean
  /**
   * 是否可编辑
   * @description 历史预览时关闭编辑能力
   */
  editable?: boolean
}

export interface DocumentTitleEditorEmits {
  'update:title': [title: TiptapJsonContent]
  'autofocusApplied': []
}

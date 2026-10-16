export type ChatMarkdownRenderPhase = 'streaming' | 'final'

export interface ChatMarkdownRenderOptions {
  phase?: ChatMarkdownRenderPhase
}

export interface ChatMarkdownBlock {
  key: string
  kind: 'markdown' | 'incomplete-code' | 'incomplete-table' | 'incomplete-math'
  source: string
  html: string
}

export interface ChatMarkdownBlocksResult {
  blocks: ChatMarkdownBlock[]
}

export interface ChatMarkdownContentProps {
  messageId: string
  partId: string
  source: string
  phase?: ChatMarkdownRenderPhase
}

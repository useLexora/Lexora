/**
 * Tiptap mark 载荷。
 */
export interface TiptapJsonMarkPayload {
  type: string
  attrs?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Tiptap 节点载荷。
 */
export interface TiptapJsonNodePayload {
  type?: string
  attrs?: Record<string, unknown>
  text?: string
  content?: TiptapJsonNodePayload[]
  marks?: TiptapJsonMarkPayload[]
  [key: string]: unknown
}

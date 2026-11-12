import { z } from 'zod'

export const extensionTaskCleanupListSchema = z.object({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()

export const extensionTaskCleanupDeleteSchema = z.object({
  conversationId: z.string().min(1).max(180),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

export const extensionTaskCleanupItemSchema = z.object({
  conversationId: z.string().min(1).max(180),
  title: z.string().nullable(),
  removedAt: z.string(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  estimatedBytes: z.number().int().nonnegative().nullable(),
  canDelete: z.boolean(),
  blockedReason: z.string().nullable(),
}).strict()

export const extensionTaskCleanupPageSchema = z.object({
  items: z.array(extensionTaskCleanupItemSchema).max(100),
  nextCursor: z.string().nullable(),
}).strict()

export const extensionTaskCleanupResultSchema = z.object({
  status: z.enum(['deleted', 'pending', 'failed']),
  errorCode: z.string().optional(),
}).strict()

export type ExtensionTaskCleanupList = z.infer<typeof extensionTaskCleanupListSchema>
export type ExtensionTaskCleanupDelete = z.infer<typeof extensionTaskCleanupDeleteSchema>
export type ExtensionTaskCleanupItem = z.infer<typeof extensionTaskCleanupItemSchema>
export type ExtensionTaskCleanupPage = z.infer<typeof extensionTaskCleanupPageSchema>
export type ExtensionTaskCleanupResult = z.infer<typeof extensionTaskCleanupResultSchema>
export interface ExtensionTaskCleanupPreview {
  total: number
  skipped: number
}

export interface ExtensionTaskCleanupProgress {
  phase: 'scanning' | 'confirming' | 'running' | 'completed' | 'cancelled' | 'failed'
  /** @description 完整扫描后冻结的可清理目标数；扫描未完成为 null，不含 skipped。 */
  total: number | null
  /** @description 已取得结果的目标数，等于 deleted + pending + failed。 */
  processed: number
  deleted: number
  /** @description Core 已受理、仍在后台处理；不代表已删除。 */
  pending: number
  failed: number
  /** @description 扫描时不可清理的任务数，不计入 total。 */
  skipped: number
  errorCode: string | null
}

export interface ExtensionTaskCleanup {
  list: (input: ExtensionTaskCleanupList) => Promise<ExtensionTaskCleanupPage>
  delete: (input: ExtensionTaskCleanupDelete) => Promise<ExtensionTaskCleanupResult>
}

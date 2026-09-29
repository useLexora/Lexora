import type { DatabaseSync } from 'node:sqlite'
import type { ExtensionActionTrigger } from '../../../shared/extensions/extensionAgent'

export interface ExtensionActionRecord {
  id: string
  extensionId: string
  actionId: string
  conversationId: string
  trigger: ExtensionActionTrigger
  startedAt: string
  branchId?: string
  sourceMessageId?: string | null
  extensionName?: string
  title?: string
}

export function createExtensionInvocationRepository(database: DatabaseSync) {
  const start = database.prepare(`INSERT INTO extension_invocations
    (id, extension_id, action_id, conversation_id, trigger, status, started_at, branch_id, source_message_id, extension_name, action_title)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
  const finish = database.prepare(`UPDATE extension_invocations SET status = ?, completed_at = ?, result_message = ? WHERE id = ? AND status = 'running'`)
  return {
    recover() {
      database.prepare(`UPDATE extension_invocations SET status = 'interrupted', completed_at = ? WHERE status = 'running'`).run(new Date().toISOString())
    },
    start(input: ExtensionActionRecord) {
      start.run(input.id, input.extensionId, input.actionId, input.conversationId, input.trigger, input.startedAt, input.branchId ?? null, input.sourceMessageId ?? null, input.extensionName ?? null, input.title ?? null)
    },
    finish(id: string, status: 'completed' | 'skipped' | 'failed' | 'cancelled', message: string | null = null) {
      finish.run(status, new Date().toISOString(), message, id)
    },
  }
}
export type ExtensionInvocationRepository = ReturnType<typeof createExtensionInvocationRepository>

import type { DatabaseSync } from 'node:sqlite'
import type { BuddyInputDelivery } from '../../../shared/conversation/chatApi'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { createExecutionRepository, ExecutionAdmissionError, executionFence } from '../storage/executionRepository'
import { assertCommittedRead, withTransaction } from '../storage/transaction'

export async function readProductInputDelivery(database: DatabaseSync, { conversationId, branchId }: { conversationId: string, branchId: string }, getBehavior: () => Promise<'queue' | 'steer'>): Promise<BuddyInputDelivery> {
  assertCommittedRead(database)
  const { actorId, target } = withTransaction(database, () => {
    const task = database.prepare(`SELECT c.buddy_id, c.archived_at, a.enabled, a.deleted_at FROM conversations c
      JOIN conversation_branches b ON b.conversation_id = c.id JOIN buddies a ON a.id = c.buddy_id AND a.kind = 'actor'
      WHERE c.id = ? AND b.id = ? AND c.deleted_at IS NULL`).get(conversationId, branchId)
    if (!task)
      throw new ProductProtocolError('SOURCE_CHANGED')
    if (task.archived_at !== null || !task.enabled || task.deleted_at !== null)
      throw new ProductProtocolError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    const actorId = String(task.buddy_id)
    const rows = database.prepare(`SELECT r.id FROM runs r JOIN execution_state e ON e.run_id = r.id
      WHERE r.conversation_id = ? AND r.branch_id = ? AND r.buddy_id = ? AND r.purpose = 'chat' AND r.execution_kind IN ('root', 'actor_child')
      AND (e.phase <> 'closed' OR r.status IN ('queued', 'running') OR e.cleanup_state = 'pending') LIMIT 2`).all(conversationId, branchId, actorId)
    if (rows.length > 1)
      throw new ProductProtocolError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    if (!rows.length)
      return { actorId, target: null }
    const executions = createExecutionRepository(database)
    const record = executions.find(String(rows[0]!.id))!
    const root = executions.find(record.run.rootRunId)
    if (!root || root.run.executionKind !== 'root' || root.run.branchId !== branchId || root.run.conversationId !== conversationId)
      throw new ProductProtocolError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    try {
      executions.assertCurrent(executionFence(record, root))
    }
    catch (error) {
      if (error instanceof ExecutionAdmissionError)
        throw new ProductProtocolError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
      throw error
    }
    if (database.prepare(`SELECT 1 FROM user_questions WHERE run_id = ? AND json_extract(request_json, '$.status') = 'pending' LIMIT 1`).get(record.run.id))
      throw new ProductProtocolError('INPUT_DELIVERY_INCOMPATIBLE')
    return { actorId, target: { rootRunId: root.run.id, runId: record.run.id } }
  })
  return { actorId, target, mode: target && await getBehavior() === 'queue' ? 'next' : 'current' }
}

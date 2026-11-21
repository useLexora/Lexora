import type { DatabaseSync } from 'node:sqlite'
import { productErrorCodeSchema } from '../../../shared/productProtocol/errors'
import { productRunSchema } from '../../../shared/productProtocol/views'

export function readProductRun(database: DatabaseSync, id: string) {
  const row = database.prepare(`SELECT r.id,r.conversation_id AS conversationId,r.branch_id AS branchId,r.triggering_message_id AS triggeringMessageId,
    r.buddy_id AS buddyId,r.approval_policy AS approvalPolicy,r.execution_profile AS executionProfile,r.completed_at AS completedAt,
    r.error_code AS errorCode,r.execution_kind AS executionKind,CAST(r.generation AS TEXT) AS generation,
    CAST(COALESCE(r.next_event_sequence,1)-1 AS TEXT) AS lastEventSequence,r.model AS modelId,r.provider AS providerId,r.purpose,
    i.reasoning AS reasoningLevel,r.started_at AS startedAt,r.status FROM runs r JOIN conversations c ON c.id = r.conversation_id
    LEFT JOIN run_inputs i ON i.run_id = r.id WHERE r.id = ? AND c.deleted_at IS NULL AND r.execution_kind IN ('root','actor_child','maintenance')`).get(id)
  if (!row)
    return null
  const error = productErrorCodeSchema.safeParse(row.errorCode)
  return productRunSchema.parse({ ...row, errorCode: row.errorCode ? error.success ? error.data : 'INTERNAL_ERROR' : null })
}

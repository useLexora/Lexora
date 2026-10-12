import type {
  AutomationErrorCode,
  AutomationExecutionSnapshot,
  AutomationOccurrence,
} from '../../../shared/automation'
import type { BuddyConfigurationSnapshot } from '../buddies/BuddyExecutionDefinition'
import {
  automationExecutionSnapshotSchema,
  automationOccurrenceSchema,
} from '../../../shared/automation'
import { buddyConfigurationSnapshotSchema } from '../buddies/BuddyExecutionDefinition'

export interface AutomationOccurrenceRecord extends AutomationOccurrence {
  actorSnapshot: BuddyConfigurationSnapshot | null
  dedupeKey: string
  executionSnapshot: AutomationExecutionSnapshot
  leaseExpiresAt: string | null
  leaseOwner: string | null
  requestId: string | null
}

export interface AutomationOccurrenceRow {
  actor_snapshot_json: string | null
  automation_id: string
  automation_revision: number
  bound_at: string | null
  coalesced_missed_count: number
  conversation_id: string | null
  dedupe_key: string
  deleted_at: string | null
  error_code: AutomationErrorCode | null
  error_summary: string | null
  execution_snapshot_json: string
  finished_at: string | null
  id: string
  lease_expires_at: string | null
  lease_owner: string | null
  queued_at: string
  request_id: string | null
  run_id: string | null
  scheduled_for: string
  status: AutomationOccurrence['status']
  trigger_kind: AutomationOccurrence['triggerKind']
}

export function requireAutomationOccurrenceRecord(
  value: unknown,
  id: string,
): AutomationOccurrenceRecord {
  const row = value as AutomationOccurrenceRow | undefined
  if (!row)
    throw new Error(`Lexora Buddy automation occurrence was not persisted: ${id}`)
  return toAutomationOccurrenceRecord(row)
}

export function toAutomationOccurrenceRecord(
  row: AutomationOccurrenceRow,
): AutomationOccurrenceRecord {
  const occurrence = automationOccurrenceSchema.parse({
    automationId: row.automation_id,
    automationRevision: row.automation_revision,
    boundAt: row.bound_at,
    coalescedMissedCount: row.coalesced_missed_count,
    conversationId: row.conversation_id,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    finishedAt: row.finished_at,
    id: row.id,
    queuedAt: row.queued_at,
    runId: row.run_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    triggerKind: row.trigger_kind,
  })
  return {
    ...occurrence,
    actorSnapshot: row.actor_snapshot_json ? buddyConfigurationSnapshotSchema.parse(JSON.parse(row.actor_snapshot_json)) : null,
    dedupeKey: row.dedupe_key,
    executionSnapshot: automationExecutionSnapshotSchema.parse(
      JSON.parse(row.execution_snapshot_json),
    ),
    leaseExpiresAt: row.lease_expires_at,
    leaseOwner: row.lease_owner,
    requestId: row.request_id,
  }
}

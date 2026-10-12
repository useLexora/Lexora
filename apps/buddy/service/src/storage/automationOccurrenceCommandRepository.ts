import type { DatabaseSync } from 'node:sqlite'
import type { AutomationErrorCode } from '../../../shared/automation'
import type {
  AutomationOccurrenceRecord,
  AutomationOccurrenceRow,
} from './automationOccurrenceRecord'
import { buddyConfigurationSnapshotSchema } from '../buddies/BuddyExecutionDefinition'
import { toAutomationOccurrenceRecord } from './automationOccurrenceRecord'
import { withTransaction } from './database'

interface AutomationOccurrenceRecordReader {
  requireById: (id: string) => AutomationOccurrenceRecord
}

export interface FinishQueuedAutomationOccurrenceInput {
  errorCode: AutomationErrorCode
  errorSummary?: string | null
  finishedAt: string
  id: string
  leaseOwner?: string | null
  status: 'cancelled' | 'expired' | 'skipped'
}

export interface AutomationOccurrenceCommandRepository {
  finishQueued: (
    input: FinishQueuedAutomationOccurrenceInput,
  ) => AutomationOccurrenceRecord | null
  leaseQueued: (input: {
    leaseExpiresAt: string
    limit: number
    now: string
    owner: string
  }) => { leased: AutomationOccurrenceRecord[], skipped: AutomationOccurrenceRecord[] }
  markOccurrenceDeleted: (id: string, deletedAt: string) => { occurrence: AutomationOccurrenceRecord, previousStatus: AutomationOccurrenceRecord['status'] } | null
}

export interface AutomationOccurrenceCommandStore {
  repository: AutomationOccurrenceCommandRepository
  tryFinishQueued: (input: FinishQueuedAutomationOccurrenceInput) => boolean
}

export function createAutomationOccurrenceCommandStore(
  database: DatabaseSync,
  occurrenceRecords: AutomationOccurrenceRecordReader,
): AutomationOccurrenceCommandStore {
  const selectLeaseCandidates = database.prepare(`
    SELECT * FROM automation_occurrences
    WHERE deleted_at IS NULL AND status = 'queued' AND run_id IS NULL
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    ORDER BY scheduled_for, id
    LIMIT ?
  `)
  const acquireLease = database.prepare(`
    UPDATE automation_occurrences
    SET lease_owner = ?, lease_expires_at = ?, actor_snapshot_json = COALESCE(actor_snapshot_json, ?)
    WHERE id = ? AND deleted_at IS NULL AND status = 'queued' AND run_id IS NULL
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `)
  const finishQueued = database.prepare(`
    UPDATE automation_occurrences
    SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
        finished_at = ?, error_code = ?, error_summary = ?
    WHERE id = ? AND deleted_at IS NULL AND status = 'queued' AND run_id IS NULL
      AND (? IS NULL OR lease_owner = ?)
  `)
  const markOccurrenceDeleted = database.prepare(`
    UPDATE automation_occurrences
    SET deleted_at = ?,
        status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
        finished_at = CASE
          WHEN status = 'queued' THEN COALESCE(finished_at, ?)
          ELSE finished_at
        END,
        lease_owner = NULL,
        lease_expires_at = NULL
    WHERE id = ? AND deleted_at IS NULL
    RETURNING *
  `)

  const tryFinishQueued = (input: FinishQueuedAutomationOccurrenceInput): boolean => {
    const owner = input.leaseOwner ?? null
    return Number(finishQueued.run(
      input.status,
      input.finishedAt,
      input.errorCode,
      input.errorSummary ?? null,
      input.id,
      owner,
      owner,
    ).changes) === 1
  }

  return {
    repository: {
      finishQueued(input) {
        return withTransaction(database, () => {
          if (!tryFinishQueued(input))
            return null
          return occurrenceRecords.requireById(input.id)
        })
      },
      leaseQueued(input) {
        return withTransaction(database, () => {
          const candidates = selectLeaseCandidates.all(
            input.now,
            input.limit,
          ) as unknown as AutomationOccurrenceRow[]
          const leased: AutomationOccurrenceRecord[] = []
          const skipped: AutomationOccurrenceRecord[] = []
          for (const candidate of candidates) {
            const captured = toAutomationOccurrenceRecord(candidate)
            let actorSnapshot = captured.actorSnapshot
            if (!actorSnapshot) {
              const actorId = captured.executionSnapshot.actorId ?? (database.prepare('SELECT default_buddy_id FROM buddy_catalog WHERE id = 1').get() as { default_buddy_id: string }).default_buddy_id
              const actor = database.prepare('SELECT id,kind,revision,settings_json FROM buddies WHERE id = ? AND kind = \'actor\' AND enabled = 1 AND deleted_at IS NULL').get(actorId) as { id: string, kind: 'actor', revision: number, settings_json: string } | undefined
              if (!actor) {
                if (tryFinishQueued({ id: candidate.id, finishedAt: input.now, errorCode: 'AUTOMATION_ACTOR_UNAVAILABLE', status: 'skipped' }))
                  skipped.push(occurrenceRecords.requireById(candidate.id))
                continue
              }
              actorSnapshot = buddyConfigurationSnapshotSchema.parse({ version: 1, id: actor.id, kind: actor.kind, revision: actor.revision, settings: JSON.parse(actor.settings_json) })
            }
            if (Number(acquireLease.run(
              input.owner,
              input.leaseExpiresAt,
              JSON.stringify(actorSnapshot),
              candidate.id,
              input.now,
            ).changes) !== 1) {
              continue
            }
            leased.push(occurrenceRecords.requireById(candidate.id))
          }
          return { leased, skipped }
        })
      },
      markOccurrenceDeleted(id, deletedAt) {
        return withTransaction(database, () => {
          const previous = database.prepare('SELECT status FROM automation_occurrences WHERE id = ? AND deleted_at IS NULL').get(id) as { status: AutomationOccurrenceRecord['status'] } | undefined
          if (!previous)
            return null
          const row = markOccurrenceDeleted.get(deletedAt, deletedAt, id) as unknown as AutomationOccurrenceRow
          return { occurrence: toAutomationOccurrenceRecord(row), previousStatus: previous.status }
        })
      },
    },
    tryFinishQueued,
  }
}

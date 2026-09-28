import type { DatabaseSync } from 'node:sqlite'
import type { AutomationErrorCode } from '../../../shared/automation'
import type {
  AutomationOccurrenceRecord,
  AutomationOccurrenceRow,
} from './automationOccurrenceRecord'
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
  }) => AutomationOccurrenceRecord[]
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
    SET lease_owner = ?, lease_expires_at = ?
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
          for (const candidate of candidates) {
            if (Number(acquireLease.run(
              input.owner,
              input.leaseExpiresAt,
              candidate.id,
              input.now,
            ).changes) !== 1) {
              continue
            }
            leased.push(occurrenceRecords.requireById(candidate.id))
          }
          return leased
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

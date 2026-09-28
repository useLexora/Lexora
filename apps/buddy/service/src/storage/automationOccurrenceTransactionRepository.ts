import type { DatabaseSync } from 'node:sqlite'
import type {
  Automation,
  AutomationErrorCode,
  AutomationOccurrence,
  AutomationRunNowResult,
} from '../../../shared/automation'
import type { SpaceExecutionContext } from '../../../shared/conversation/space'
import type { AutomationDefinitionCommandStore } from './automationDefinitionCommandRepository'
import type { AutomationDefinitionIndexStore } from './automationDefinitionIndexRepository'
import type {
  AutomationMutationIdentity,
  AutomationMutationStore,
} from './automationMutationStore'
import type { AutomationOccurrenceCommandStore } from './automationOccurrenceCommandRepository'
import type { AutomationOccurrenceIndexStore } from './automationOccurrenceIndexRepository'
import type { AutomationOccurrenceRecord } from './automationOccurrenceRecord'
import type { AutomationRow } from './automationRecord'
import {
  automationOccurrenceSchema,
  automationRunNowResultSchema,
} from '../../../shared/automation'
import { spaceExecutionContextSchema } from '../../../shared/conversation/space'
import { createAutomationExecutionSnapshot } from './automationRecord'
import { AutomationRepositoryError } from './automationRepositoryError'
import { withTransaction } from './database'

export interface AutomationOccurrenceTransactionRepository {
  claimScheduled: (input: {
    automationId: string
    coalescedMissedCount: number
    expectedNextRunAt: string
    expectedRevision: number
    id: string
    nextRunAt: string | null
    queuedAt: string
    scheduledFor: string
  }) => AutomationOccurrenceRecord | null
  createManualOccurrence: (input: {
    automationId: string
    expectedRevision: number
    id: string
    queuedAt: string
    scheduledFor: string
  }, mutation: AutomationMutationIdentity) => { result: AutomationRunNowResult, committed: boolean }
  finishQueuedAndBlock: (input: {
    automationId: string
    expectedRevision: number
    finishedAt: string
    id: string
    leaseOwner: string
    reason: Automation['blockedReason'] & string
  }) => {
    automation: Automation | null
    occurrence: AutomationOccurrenceRecord
    cancelledOccurrenceIds: readonly string[]
  } | null
  settleScheduled: (input: {
    automationId: string
    coalescedMissedCount: number
    errorCode: AutomationErrorCode
    errorSummary?: string | null
    expectedNextRunAt: string
    expectedRevision: number
    finishedAt: string
    id: string
    nextRunAt: string | null
    scheduledFor: string
    status: 'expired' | 'skipped'
  }) => AutomationOccurrenceRecord | null
}

export interface AutomationOccurrenceTransactionRepositoryOptions {
  database: DatabaseSync
  definitionCommands: Pick<
    AutomationDefinitionCommandStore,
    'cancelQueuedOccurrences' | 'tryBlock'
  >
  definitions: Pick<
    AutomationDefinitionIndexStore,
    'findAnyRow' | 'requireById'
  >
  mutations: AutomationMutationStore
  occurrenceCommands: Pick<AutomationOccurrenceCommandStore, 'tryFinishQueued'>
  occurrences: AutomationOccurrenceIndexStore
}

export function createAutomationOccurrenceTransactionRepository(
  options: AutomationOccurrenceTransactionRepositoryOptions,
): AutomationOccurrenceTransactionRepository {
  const insertOccurrence = options.database.prepare(`
    INSERT INTO automation_occurrences (
      id, automation_id, request_id, dedupe_key, trigger_kind, scheduled_for,
      coalesced_missed_count, automation_revision, execution_snapshot_json,
      status, lease_owner, lease_expires_at, queued_at, bound_at, finished_at,
      conversation_id, run_id, error_code, error_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL)
  `)
  const insertTerminalOccurrence = options.database.prepare(`
    INSERT INTO automation_occurrences (
      id, automation_id, request_id, dedupe_key, trigger_kind, scheduled_for,
      coalesced_missed_count, automation_revision, execution_snapshot_json,
      status, lease_owner, lease_expires_at, queued_at, bound_at, finished_at,
      conversation_id, run_id, error_code, error_summary
    ) VALUES (?, ?, NULL, ?, 'scheduled', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, ?, ?)
  `)
  const advanceAfterClaim = options.database.prepare(`
    UPDATE automations
    SET status = ?, blocked_reason = NULL, next_run_at = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND status = 'active'
      AND deleted_at IS NULL AND next_run_at = ?
  `)
  const findActiveSpace = options.database.prepare(`
    SELECT id FROM spaces WHERE id = ? AND revoked_at IS NULL
  `)
  const listSpaceDirectories = options.database.prepare(`
    SELECT id, revision, is_primary
    FROM space_directory_bindings
    WHERE space_id = ? AND revoked_at IS NULL
    ORDER BY is_primary DESC, id
  `)

  const resolveSpaceContext = (spaceId: string | null): SpaceExecutionContext | null => {
    if (!spaceId || !findActiveSpace.get(spaceId))
      return null
    const directories = listSpaceDirectories.all(spaceId) as unknown as Array<{
      id: string
      is_primary: number
      revision: number
    }>
    return spaceExecutionContextSchema.parse({
      additionalDirectoryBindings: directories
        .filter(directory => directory.is_primary !== 1)
        .map(directory => ({
          id: directory.id,
          revision: directory.revision,
        })),
      primaryDirectoryBinding: directories
        .filter(directory => directory.is_primary === 1)
        .map(directory => ({ id: directory.id, revision: directory.revision }))[0] ?? null,
      spaceId,
    })
  }

  const findClaimableAutomation = (input: {
    automationId: string
    expectedNextRunAt: string
    expectedRevision: number
  }): AutomationRow | null => {
    const row = options.definitions.findAnyRow(input.automationId)
    if (
      !row
      || row.deleted_at
      || row.status !== 'active'
      || row.revision !== input.expectedRevision
      || row.next_run_at !== input.expectedNextRunAt
    ) {
      return null
    }
    return row
  }
  const advanceAutomation = (input: {
    changedAt: string
    expectedNextRunAt: string
    nextRunAt: string | null
    row: AutomationRow
  }): void => {
    const status = input.nextRunAt ? 'active' : 'completed'
    if (Number(advanceAfterClaim.run(
      status,
      input.nextRunAt,
      input.changedAt,
      input.row.id,
      input.row.revision,
      input.expectedNextRunAt,
    ).changes) !== 1) {
      throw new AutomationRepositoryError('conflict')
    }
  }

  return {
    claimScheduled(input) {
      return withTransaction(options.database, () => {
        const row = findClaimableAutomation(input)
        if (!row)
          return null
        const snapshot = createAutomationExecutionSnapshot(
          row,
          resolveSpaceContext(row.space_id),
        )
        if (options.occurrences.hasActiveOccurrence(row.id)) {
          insertTerminalOccurrence.run(
            input.id,
            row.id,
            `scheduled:${row.id}:${input.scheduledFor}`,
            input.scheduledFor,
            input.coalescedMissedCount,
            row.revision,
            JSON.stringify(snapshot),
            'skipped',
            input.queuedAt,
            input.queuedAt,
            'OVERLAP_SKIPPED',
            null,
          )
        }
        else {
          insertOccurrence.run(
            input.id,
            row.id,
            null,
            `scheduled:${row.id}:${input.scheduledFor}`,
            'scheduled',
            input.scheduledFor,
            input.coalescedMissedCount,
            row.revision,
            JSON.stringify(snapshot),
            input.queuedAt,
          )
        }
        advanceAutomation({
          changedAt: input.queuedAt,
          expectedNextRunAt: input.expectedNextRunAt,
          nextRunAt: input.nextRunAt,
          row,
        })
        return options.occurrences.requireById(input.id)
      })
    },
    createManualOccurrence(input, mutation) {
      return withTransaction(options.database, () => {
        const replay = options.mutations.repository.replayRunNowMutation(mutation)
        if (replay)
          return { result: replay, committed: false }
        const row = options.definitions.findAnyRow(input.automationId)
        if (!row || row.deleted_at)
          throw new AutomationRepositoryError('not_found')
        const active = options.occurrences.repository.findActiveOccurrence(row.id)
        if (active) {
          const result = automationRunNowResultSchema.parse({
            occurrence: toPublicOccurrence(active),
            outcome: 'already_running',
          })
          options.mutations.save(row.id, mutation, result)
          return { result, committed: false }
        }
        if (row.revision !== input.expectedRevision)
          throw new AutomationRepositoryError('conflict')
        const snapshot = createAutomationExecutionSnapshot(
          row,
          resolveSpaceContext(row.space_id),
        )
        insertOccurrence.run(
          input.id,
          row.id,
          mutation.requestId,
          `manual:${mutation.requestId}`,
          'manual',
          input.scheduledFor,
          0,
          row.revision,
          JSON.stringify(snapshot),
          input.queuedAt,
        )
        const occurrence = options.occurrences.requireById(input.id)
        const result = automationRunNowResultSchema.parse({
          occurrence: toPublicOccurrence(occurrence),
          outcome: 'started',
        })
        options.mutations.save(row.id, mutation, result)
        return { result, committed: true }
      })
    },
    finishQueuedAndBlock(input) {
      return withTransaction(options.database, () => {
        if (!options.occurrenceCommands.tryFinishQueued({
          errorCode: input.reason,
          errorSummary: null,
          finishedAt: input.finishedAt,
          id: input.id,
          leaseOwner: input.leaseOwner,
          status: 'skipped',
        })) {
          return null
        }
        const blocked = options.definitionCommands.tryBlock({
          automationId: input.automationId,
          blockedAt: input.finishedAt,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        })
        const cancelledOccurrenceIds = blocked
          ? options.definitionCommands.cancelQueuedOccurrences(
              input.automationId,
              input.finishedAt,
            )
          : []
        return {
          automation: blocked
            ? options.definitions.requireById(input.automationId)
            : null,
          occurrence: options.occurrences.requireById(input.id),
          cancelledOccurrenceIds,
        }
      })
    },
    settleScheduled(input) {
      return withTransaction(options.database, () => {
        const row = findClaimableAutomation(input)
        if (!row)
          return null
        const snapshot = createAutomationExecutionSnapshot(
          row,
          resolveSpaceContext(row.space_id),
        )
        insertTerminalOccurrence.run(
          input.id,
          row.id,
          `scheduled:${row.id}:${input.scheduledFor}`,
          input.scheduledFor,
          input.coalescedMissedCount,
          row.revision,
          JSON.stringify(snapshot),
          input.status,
          input.finishedAt,
          input.finishedAt,
          input.errorCode,
          input.errorSummary ?? null,
        )
        advanceAutomation({
          changedAt: input.finishedAt,
          expectedNextRunAt: input.expectedNextRunAt,
          nextRunAt: input.nextRunAt,
          row,
        })
        return options.occurrences.requireById(input.id)
      })
    },
  }
}

function toPublicOccurrence(record: AutomationOccurrenceRecord): AutomationOccurrence {
  return automationOccurrenceSchema.parse({
    automationId: record.automationId,
    automationRevision: record.automationRevision,
    boundAt: record.boundAt,
    coalescedMissedCount: record.coalescedMissedCount,
    conversationId: record.conversationId,
    errorCode: record.errorCode,
    errorSummary: record.errorSummary,
    finishedAt: record.finishedAt,
    id: record.id,
    queuedAt: record.queuedAt,
    runId: record.runId,
    scheduledFor: record.scheduledFor,
    status: record.status,
    triggerKind: record.triggerKind,
  })
}

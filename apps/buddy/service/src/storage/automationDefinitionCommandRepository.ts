import type { DatabaseSync } from 'node:sqlite'
import type { Automation } from '../../../shared/automation'
import type { AutomationDefinitionIndexStore } from './automationDefinitionIndexRepository'
import type {
  AutomationMutationIdentity,
  AutomationMutationStore,
} from './automationMutationStore'
import type { AutomationRow } from './automationRecord'
import { toStorageBlockedReason } from './automationRecord'
import { AutomationRepositoryError } from './automationRepositoryError'
import { withTransaction } from './database'

export interface BlockAutomationInput {
  automationId: string
  blockedAt: string
  expectedRevision: number
  reason: Automation['blockedReason'] & string
}

export interface AutomationDefinitionCommandRepository {
  block: (input: BlockAutomationInput) => AutomationDefinitionCommit | null
  blockActiveByPinnedModel: (input: {
    blockedAt: string
    modelId?: string
    providerId: string
  }) => AutomationDefinitionCommit[]
  blockActiveBySpace: (input: {
    blockedAt: string
    spaceId: string
  }) => AutomationDefinitionCommit[]
  create: (automation: Automation, mutation: AutomationMutationIdentity) => AutomationDefinitionCommit
  replace: (input: {
    automation: Automation
    cancelQueued: boolean
    expectedRevision: number
  }, mutation: AutomationMutationIdentity) => AutomationDefinitionCommit
}

export interface AutomationDefinitionCommit {
  automation: Automation
  committed: boolean
  cancelledOccurrenceIds: readonly string[]
}

export interface AutomationDefinitionCommandStore {
  cancelQueuedOccurrences: (automationId: string, cancelledAt: string) => string[]
  repository: AutomationDefinitionCommandRepository
  tryBlock: (input: BlockAutomationInput) => boolean
}

export function createAutomationDefinitionCommandStore(
  database: DatabaseSync,
  records: Pick<AutomationDefinitionIndexStore, 'findAnyRow' | 'requireById'>,
  mutations: AutomationMutationStore,
): AutomationDefinitionCommandStore {
  const insertAutomation = database.prepare(`
    INSERT INTO automations (
      id, name, prompt, space_id, execution_profile, model_mode, provider_id, model_id, reasoning,
      schedule_kind, schedule_json, timezone, active_from, active_until,
      status, blocked_reason, next_run_at, last_run_at, deleted_at, revision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `)
  const replaceAutomation = database.prepare(`
    UPDATE automations SET
      name = ?, prompt = ?, space_id = ?, execution_profile = ?, model_mode = ?, provider_id = ?,
      model_id = ?, reasoning = ?, schedule_kind = ?, schedule_json = ?,
      timezone = ?, active_from = ?, active_until = ?, status = ?,
      blocked_reason = ?, next_run_at = ?, deleted_at = ?, revision = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `)
  const cancelQueued = database.prepare(`
    UPDATE automation_occurrences
    SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
        finished_at = ?, error_code = NULL, error_summary = NULL
    WHERE automation_id = ? AND status = 'queued' AND run_id IS NULL
    RETURNING id
  `)
  const blockAutomation = database.prepare(`
    UPDATE automations
    SET status = 'blocked', blocked_reason = ?, next_run_at = NULL,
        revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `)
  const findActiveBySpace = database.prepare(`
    SELECT * FROM automations
    WHERE deleted_at IS NULL AND status = 'active' AND space_id = ?
    ORDER BY id
  `)
  const findActiveByPinnedProvider = database.prepare(`
    SELECT * FROM automations
    WHERE deleted_at IS NULL AND status = 'active'
      AND model_mode = 'pinned' AND provider_id = ?
    ORDER BY id
  `)
  const findActiveByPinnedModel = database.prepare(`
    SELECT * FROM automations
    WHERE deleted_at IS NULL AND status = 'active'
      AND model_mode = 'pinned' AND provider_id = ? AND model_id = ?
    ORDER BY id
  `)

  const cancelQueuedOccurrences = (automationId: string, cancelledAt: string): string[] => {
    return (cancelQueued.all(cancelledAt, automationId) as { id: string }[]).map(row => row.id)
  }
  const tryBlock = (input: BlockAutomationInput): boolean => {
    return Number(blockAutomation.run(
      toStorageBlockedReason(input.reason),
      input.blockedAt,
      input.automationId,
      input.expectedRevision,
    ).changes) === 1
  }
  const blockActiveRows = (
    rows: AutomationRow[],
    reason: Automation['blockedReason'] & string,
    blockedAt: string,
  ): AutomationDefinitionCommit[] => {
    return withTransaction(database, () => {
      const blocked: AutomationDefinitionCommit[] = []
      for (const row of rows) {
        if (!tryBlock({
          automationId: row.id,
          blockedAt,
          expectedRevision: row.revision,
          reason,
        })) {
          continue
        }
        const cancelledOccurrenceIds = cancelQueuedOccurrences(row.id, blockedAt)
        blocked.push({ automation: records.requireById(row.id), committed: true, cancelledOccurrenceIds })
      }
      return blocked
    })
  }

  return {
    cancelQueuedOccurrences,
    repository: {
      block(input) {
        return withTransaction(database, () => {
          if (!tryBlock(input))
            return null
          const cancelledOccurrenceIds = cancelQueuedOccurrences(input.automationId, input.blockedAt)
          return { automation: records.requireById(input.automationId), committed: true, cancelledOccurrenceIds }
        })
      },
      blockActiveByPinnedModel(input) {
        const rows = (input.modelId
          ? findActiveByPinnedModel.all(input.providerId, input.modelId)
          : findActiveByPinnedProvider.all(input.providerId)) as unknown as AutomationRow[]
        return blockActiveRows(
          rows,
          'AUTOMATION_PINNED_MODEL_UNAVAILABLE',
          input.blockedAt,
        )
      },
      blockActiveBySpace(input) {
        const rows = findActiveBySpace.all(input.spaceId) as unknown as AutomationRow[]
        return blockActiveRows(
          rows,
          'AUTOMATION_SPACE_UNAVAILABLE',
          input.blockedAt,
        )
      },
      create(automation, mutation) {
        return withTransaction(database, () => {
          const replay = mutations.repository.replayAutomationMutation(mutation)
          if (replay)
            return { automation: replay, committed: false, cancelledOccurrenceIds: [] }
          persistAutomation(insertAutomation, automation)
          const stored = records.requireById(automation.id)
          mutations.save(automation.id, mutation, stored)
          return { automation: stored, committed: true, cancelledOccurrenceIds: [] }
        })
      },
      replace(input, mutation) {
        return withTransaction(database, () => {
          const replay = mutations.repository.replayAutomationMutation(mutation)
          if (replay)
            return { automation: replay, committed: false, cancelledOccurrenceIds: [] }
          const existing = records.findAnyRow(input.automation.id)
          if (!existing || existing.deleted_at)
            throw new AutomationRepositoryError('not_found')
          if (existing.revision !== input.expectedRevision)
            throw new AutomationRepositoryError('conflict')
          if (Number(replaceAutomation.run(
            input.automation.name,
            input.automation.prompt,
            input.automation.spaceId,
            input.automation.executionProfile,
            input.automation.model.mode,
            input.automation.model.mode === 'pinned' ? input.automation.model.providerId : null,
            input.automation.model.mode === 'pinned' ? input.automation.model.modelId : null,
            input.automation.model.mode === 'pinned' ? input.automation.model.reasoning : null,
            input.automation.timing.schedule.kind,
            JSON.stringify(input.automation.timing.schedule),
            input.automation.timing.timezone,
            input.automation.timing.activeFrom,
            input.automation.timing.activeUntil,
            input.automation.status,
            toStorageBlockedReason(input.automation.blockedReason),
            input.automation.nextRunAt,
            mutation.operation === 'delete' ? input.automation.updatedAt : null,
            input.automation.revision,
            input.automation.updatedAt,
            input.automation.id,
            input.expectedRevision,
          ).changes) !== 1) {
            throw new AutomationRepositoryError('conflict')
          }
          const cancelledOccurrenceIds = input.cancelQueued
            ? cancelQueuedOccurrences(
                input.automation.id,
                input.automation.updatedAt,
              )
            : []
          const stored = records.requireById(input.automation.id)
          mutations.save(stored.id, mutation, stored)
          return { automation: stored, committed: true, cancelledOccurrenceIds }
        })
      },
    },
    tryBlock,
  }
}

function persistAutomation(
  statement: ReturnType<DatabaseSync['prepare']>,
  automation: Automation,
): void {
  statement.run(
    automation.id,
    automation.name,
    automation.prompt,
    automation.spaceId,
    automation.executionProfile,
    automation.model.mode,
    automation.model.mode === 'pinned' ? automation.model.providerId : null,
    automation.model.mode === 'pinned' ? automation.model.modelId : null,
    automation.model.mode === 'pinned' ? automation.model.reasoning : null,
    automation.timing.schedule.kind,
    JSON.stringify(automation.timing.schedule),
    automation.timing.timezone,
    automation.timing.activeFrom,
    automation.timing.activeUntil,
    automation.status,
    toStorageBlockedReason(automation.blockedReason),
    automation.nextRunAt,
    automation.lastRunAt,
    automation.revision,
    automation.createdAt,
    automation.updatedAt,
  )
}

import type { DatabaseSync } from 'node:sqlite'
import type { MutationClaim, MutationIdentity, MutationLifetime } from './MutationCoordinator'
import { z } from 'zod'
import { withTransaction } from '../storage/database'

export type OwnedProcessSettlement = 'pending' | 'released' | 'unknown'

export interface MutationExecutionUpdate {
  executionId?: string
  dispatchId?: string
  launchState?: 'prepared' | 'authorized' | 'settled'
}

export interface StoredMutation extends MutationIdentity {
  segmentId: string
  lifetime: MutationLifetime
  claims: readonly MutationClaim[]
  status: 'active' | 'released' | 'hazard'
  reason: string | null
  processes: readonly { processId: string, settlement: OwnedProcessSettlement }[]
}

export interface MutationRepository {
  createLease: (lease: MutationIdentity & { segmentId: string, claims: readonly MutationClaim[], lifetime: MutationLifetime }) => void
  settle: (invocationId: string, status: 'released' | 'hazard', reason: string | null) => void
  recordProcess: (invocationId: string, processId: string, settlement: OwnedProcessSettlement, execution?: MutationExecutionUpdate) => void
  listUnreleased: () => StoredMutation[]
  isReleased: (invocationId: string) => boolean
}

const claimsSchema = z.array(z.union([
  z.object({ kind: z.enum(['file', 'tree']), canonicalPath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('host') }).strict(),
]))

interface MutationRow {
  invocation_id: string
  run_id: string
  segment_id: string
  lifetime: MutationLifetime
  claims_json: string
  status: StoredMutation['status']
  reason: string | null
}

export function createMutationRepository(database: DatabaseSync): MutationRepository {
  const insert = database.prepare(`
    INSERT INTO run_mutation_leases (invocation_id, run_id, segment_id, claims_json, lifetime, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `)
  const settle = database.prepare(`
    UPDATE run_mutation_leases SET status = ?, reason = ?, updated_at = ? WHERE invocation_id = ?
  `)
  const recordProcess = database.prepare(`
    INSERT INTO run_mutation_processes (invocation_id, process_id, settlement, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (invocation_id, process_id) DO UPDATE SET settlement = excluded.settlement, updated_at = excluded.updated_at
    WHERE run_mutation_processes.settlement <> 'released'
  `)
  const executionSchema = z.object({ executionId: z.uuid(), dispatchId: z.uuid(), launchState: z.enum(['prepared', 'authorized', 'settled']) })
  const updateExecution = database.prepare(`
    INSERT INTO run_mutation_executions (execution_id, invocation_id, dispatch_id, launch_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (execution_id) DO UPDATE SET
      launch_state = CASE WHEN excluded.launch_state = 'prepared' THEN run_mutation_executions.launch_state ELSE excluded.launch_state END,
      updated_at = excluded.updated_at
    WHERE run_mutation_executions.invocation_id = excluded.invocation_id
      AND run_mutation_executions.dispatch_id = excluded.dispatch_id
      AND (run_mutation_executions.launch_state <> 'settled' OR excluded.launch_state = 'settled')
      AND (excluded.launch_state <> 'authorized' OR run_mutation_executions.launch_state = 'prepared')
  `)
  const listUnreleased = database.prepare('SELECT * FROM run_mutation_leases WHERE status <> \'released\' ORDER BY created_at, invocation_id')
  const findStatus = database.prepare('SELECT status FROM run_mutation_leases WHERE invocation_id = ?')
  const listProcesses = database.prepare('SELECT process_id, settlement FROM run_mutation_processes WHERE invocation_id = ? ORDER BY process_id')
  return {
    isReleased(invocationId) {
      return (findStatus.get(invocationId) as { status: string } | undefined)?.status === 'released'
    },
    createLease(lease) {
      const now = new Date().toISOString()
      insert.run(lease.invocationId, lease.runId, lease.segmentId, JSON.stringify(claimsSchema.parse(lease.claims)), lease.lifetime, now, now)
    },
    settle(invocationId, status, reason) {
      if (Number(settle.run(status, reason, new Date().toISOString(), invocationId).changes) !== 1)
        throw new Error('MUTATION_LEASE_NOT_FOUND')
    },
    recordProcess(invocationId, processId, settlement, execution) {
      withTransaction(database, () => {
        const now = new Date().toISOString()
        if (execution?.launchState) {
          const value = executionSchema.parse(execution)
          if (Number(updateExecution.run(value.executionId, invocationId, value.dispatchId, value.launchState, now, now).changes) !== 1)
            throw new Error('MUTATION_EXECUTION_CONFLICT')
        }
        recordProcess.run(invocationId, processId, settlement, now)
      })
    },
    listUnreleased() {
      return (listUnreleased.all() as unknown as MutationRow[]).map(row => ({
        invocationId: row.invocation_id,
        runId: row.run_id,
        segmentId: row.segment_id,
        lifetime: row.lifetime,
        claims: claimsSchema.parse(JSON.parse(row.claims_json)),
        status: row.status,
        reason: row.reason,
        processes: (listProcesses.all(row.invocation_id) as { process_id: string, settlement: OwnedProcessSettlement }[]).map(process => ({ processId: process.process_id, settlement: process.settlement })),
      }))
    },
  }
}

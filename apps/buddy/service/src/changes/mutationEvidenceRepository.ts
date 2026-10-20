import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from '../storage/database'

export interface MutationEvidence {
  invocationId: string
  kind: 'constructive' | 'quiesced' | 'observed' | 'waived'
  outcome: 'active' | 'unknown' | 'requested' | 'applied'
  reason: string
  actor: 'system' | 'user'
  processId?: string
  relatedRunId?: string
}

export interface StoredMutationEvidence extends MutationEvidence {
  sequence: number
  createdAt: string
}

export interface MutationEvidenceRepository {
  append: (evidence: MutationEvidence) => void
  latest: (invocationId: string) => StoredMutationEvidence | null
  decision: (invocationId: string) => StoredMutationEvidence | null
  recordOverlap: (invocationId: string, runId: string) => void
  relatedRuns: (invocationId: string) => string[]
  applyResolution: (invocationId: string, kind: 'quiesced' | 'waived') => void
  createdAt: (invocationId: string) => string | null
}

interface EvidenceRow {
  sequence: number
  invocation_id: string
  kind: MutationEvidence['kind']
  outcome: MutationEvidence['outcome']
  reason: string
  actor: MutationEvidence['actor']
  process_id: string | null
  related_run_id: string | null
  created_at: string
}

export function createMutationEvidenceRepository(database: DatabaseSync): MutationEvidenceRepository {
  const insert = database.prepare(`
    INSERT INTO run_mutation_evidence (invocation_id, kind, outcome, reason, actor, process_id, related_run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (invocation_id, related_run_id) WHERE related_run_id IS NOT NULL DO NOTHING
  `)
  const latest = database.prepare(`
    SELECT * FROM run_mutation_evidence WHERE invocation_id = ? AND related_run_id IS NULL AND process_id IS NULL
    ORDER BY sequence DESC LIMIT 1
  `)
  const decision = database.prepare(`
    SELECT * FROM run_mutation_evidence WHERE invocation_id = ? AND outcome IN ('requested', 'applied') AND process_id IS NULL AND related_run_id IS NULL
    ORDER BY sequence DESC LIMIT 1
  `)
  const relatedRuns = database.prepare('SELECT related_run_id FROM run_mutation_evidence WHERE invocation_id = ? AND related_run_id IS NOT NULL')
  const createdAt = database.prepare('SELECT created_at FROM run_mutation_leases WHERE invocation_id = ?')
  const settle = database.prepare('UPDATE run_mutation_leases SET status = \'released\', reason = ?, updated_at = ? WHERE invocation_id = ?')
  const append = (evidence: MutationEvidence) => {
    insert.run(evidence.invocationId, evidence.kind, evidence.outcome, evidence.reason, evidence.actor, evidence.processId ?? null, evidence.relatedRunId ?? null, new Date().toISOString())
  }
  return {
    append,
    latest: invocationId => toEvidence(latest.get(invocationId) as EvidenceRow | undefined),
    decision: invocationId => toEvidence(decision.get(invocationId) as EvidenceRow | undefined),
    recordOverlap: (invocationId, runId) => append({ invocationId, kind: 'observed', outcome: 'unknown', actor: 'system', reason: 'RESOURCE_OVERLAP', relatedRunId: runId }),
    relatedRuns: invocationId => (relatedRuns.all(invocationId) as { related_run_id: string }[]).map(row => row.related_run_id),
    createdAt: invocationId => (createdAt.get(invocationId) as { created_at: string } | undefined)?.created_at ?? null,
    applyResolution(invocationId, kind) {
      withTransaction(database, () => {
        append({ invocationId, kind, outcome: 'applied', actor: kind === 'waived' ? 'user' : 'system', reason: kind === 'waived' ? 'USER_ACCEPTED_RISK' : 'PROCESS_RELEASE_CONFIRMED' })
        if (Number(settle.run(kind === 'waived' ? 'USER_ACCEPTED_RISK' : null, new Date().toISOString(), invocationId).changes) !== 1)
          throw new Error('MUTATION_LEASE_NOT_FOUND')
      })
    },
  }
}

function toEvidence(row: EvidenceRow | undefined): StoredMutationEvidence | null {
  return row
    ? {
        sequence: row.sequence,
        invocationId: row.invocation_id,
        kind: row.kind,
        outcome: row.outcome,
        reason: row.reason,
        actor: row.actor,
        processId: row.process_id ?? undefined,
        relatedRunId: row.related_run_id ?? undefined,
        createdAt: row.created_at,
      }
    : null
}

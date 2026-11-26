import type { DatabaseSync } from 'node:sqlite'
import type { StorageReporter } from '../../../../platform/storage/storageTree'
import type { LegacyCheckpointEvidence } from './legacyRunHistory'
import type { MigrationReferences } from './migrationReferences'
import { storageHistoryIdentityFieldSchema } from '../../../../shared/diagnostics/storageHistoryFailure'
import { RunEventQueries } from '../../events/RunEventQueries'
import { isTerminalRecoveryRun, RUN_EVENT_COMPACTION_VERSION, RUN_EVENT_PROJECTION_VERSION } from '../../events/RunEventRecovery'
import { parseLegacyRunHistory, PersistenceMigrationError, reconcileLegacyRunHistory } from './legacyRunHistory'

import { countedUpgradeItems } from './upgradeProgress'

interface LegacyCheckpoint {
  id: string
  conversation: string
  status: string
  fingerprint: string | null
  version: number | null
  last: number | null
  projectedLast: number
  retained: number
  compacted: number
}

export function readLegacyCheckpoints(database: DatabaseSync): Map<string, LegacyCheckpoint> {
  const hasTable = database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?')
  if (!hasTable.get('run_event_checkpoints'))
    return new Map()
  const maintenance = !!hasTable.get('run_event_maintenance')
  const rows = database.prepare(`
    SELECT r.id, r.conversation_id AS conversation, r.status, c.file_fingerprint AS fingerprint,
      c.projection_version AS version, c.last_sequence AS last,
      COALESCE(MAX(e.sequence), 0) AS projectedLast, COUNT(e.sequence) AS retained,
      ${maintenance ? `(m.recovery_pending = 0 AND m.compaction_pending = 0 AND m.projection_version = ${RUN_EVENT_PROJECTION_VERSION} AND m.compaction_version = ${RUN_EVENT_COMPACTION_VERSION})` : '0'} AS compacted
    FROM runs r LEFT JOIN run_event_checkpoints c ON c.run_id = r.id
    LEFT JOIN run_events e ON e.run_id = r.id
    ${maintenance ? 'LEFT JOIN run_event_maintenance m ON m.run_id = r.id' : ''}
    GROUP BY r.id
  `).all() as unknown as LegacyCheckpoint[]
  return new Map(rows.map(row => [row.id, row]))
}

const identityFields = storageHistoryIdentityFieldSchema.options
const identityFormat = /^-?\d+(?::-?\d+){5}$/

export function checkpointEvidence(checkpoint: LegacyCheckpoint | undefined, identity: string | undefined): LegacyCheckpointEvidence {
  const details = {
    checkpointVersion: checkpoint?.version ?? null,
    checkpointLastSequence: checkpoint?.last ?? null,
    identityChanges: [] as LegacyCheckpointEvidence['identityChanges'],
  }
  const reject = (reason: NonNullable<LegacyCheckpointEvidence['reason']>): LegacyCheckpointEvidence => ({
    ...details,
    reason,
    certifiedThrough: null,
    compactedThrough: null,
  })
  if (!identity)
    return reject('journal_missing')
  if (!checkpoint?.fingerprint)
    return reject('checkpoint_missing')
  if (checkpoint.version !== RUN_EVENT_PROJECTION_VERSION)
    return reject('projection_version')
  if (checkpoint.last !== checkpoint.projectedLast)
    return reject('checkpoint_watermark')
  if (checkpoint.fingerprint === identity)
    return { ...details, reason: null, certifiedThrough: checkpoint.last, compactedThrough: null }
  if (!identityFormat.test(checkpoint.fingerprint) || !identityFormat.test(identity))
    return reject('identity_format')
  const previous = checkpoint.fingerprint.split(':')
  const current = identity.split(':')
  details.identityChanges = identityFields.filter((_, index) => previous[index] !== current[index])
  if (details.identityChanges.includes('size'))
    return reject('file_size')
  if (!isTerminalRecoveryRun(checkpoint.status))
    return reject('run_not_terminal')
  if (!checkpoint.compacted)
    return reject('maintenance_pending')
  return { ...details, reason: null, certifiedThrough: null, compactedThrough: checkpoint.last }
}

export function legacyEventPath(conversation: string, run: string): string {
  if ([conversation, run].some(id => !id || id === '.' || id === '..' || /[\\/]/.test(id)))
    throw new PersistenceMigrationError('MIGRATION_EVENT_CORRUPTED')
  return `buddy/conversations/${conversation}/events/${run}.jsonl`
}

export async function verifySparseCheckpoints(database: DatabaseSync, checkpoints: Map<string, LegacyCheckpoint>, references: MigrationReferences, signal: AbortSignal, report?: StorageReporter) {
  const queries = new RunEventQueries(database)
  const sparse = [...checkpoints.values()].filter(row => row.retained !== row.projectedLast)
  for (const checkpoint of countedUpgradeItems(sparse, 'checkpoints', report)) {
    signal.throwIfAborted()
    const path = legacyEventPath(checkpoint.conversation, checkpoint.id)
    const identity = await references.journalIdentity(path)
    const evidence = checkpointEvidence(checkpoint, identity ?? undefined)
    if (evidence.certifiedThrough !== null)
      continue
    const journal = await references.readJournal(path)
    const { events } = parseLegacyRunHistory(journal?.content ?? '', checkpoint.id)
    reconcileLegacyRunHistory({ events, projected: queries.read(checkpoint.id), hasProductFacts: true, ...evidence, diagnostics: { step: 'checkpoints', runId: checkpoint.id, evidence } })
  }
}

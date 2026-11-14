import type { DatabaseSync } from 'node:sqlite'
import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { buddyRunEventSchema, terminalRunStatus } from '../../events/BuddyRunEvent'
import { createRunEventCompactionPlan } from '../../events/RunEventCompaction'
import { RunEventProjector } from '../../events/RunEventProjector'
import { RunEventQueries } from '../../events/RunEventQueries'
import { withTransaction } from '../transaction'

export const PERSISTENCE_MIGRATION_ID = 'legacy-jsonl-v1'

export class PersistenceMigrationError extends Error {
  readonly code: string

  constructor(code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'PersistenceMigrationError'
    this.code = code
  }
}

export function parseLegacyRunHistory(content: string, runId: string): { events: BuddyRunEvent[], repairedNewline: boolean } {
  const events: BuddyRunEvent[] = []
  try {
    for (const line of content.split('\n')) {
      if (!line.trim())
        continue
      const event = buddyRunEventSchema.parse(JSON.parse(line))
      if (event.runId !== runId || !Number.isSafeInteger(event.sequence) || event.sequence >= Number.MAX_SAFE_INTEGER
        || event.sequence <= (events.at(-1)?.sequence ?? 0)) {
        throw new Error('Invalid event identity or sequence')
      }
      events.push(event)
    }
  }
  catch (cause) {
    throw new PersistenceMigrationError('MIGRATION_EVENT_CORRUPTED', { cause })
  }
  return { events, repairedNewline: content.length > 0 && !content.endsWith('\n') }
}

export function reconcileLegacyRunHistory(input: {
  events: readonly BuddyRunEvent[]
  projected: readonly BuddyRunEvent[]
  certifiedThrough: number | null
  hasProductFacts: boolean
}): { events: BuddyRunEvent[], nextSequence: number, compacted: boolean } {
  const { events, projected } = input
  if (!events.length && (projected.length || input.hasProductFacts))
    throw new PersistenceMigrationError('MIGRATION_EVENT_SOURCE_MISSING')
  const bySequence = new Map(events.map(event => [event.sequence, event]))
  const merged = new Map(projected.map(event => [event.sequence, event]))
  for (const event of events) {
    const existing = merged.get(event.sequence)
    if (existing && !isDeepStrictEqual(existing, event))
      throw new PersistenceMigrationError('MIGRATION_EVENT_CONFLICT')
    merged.set(event.sequence, event)
  }
  const all = [...merged.values()].sort((a, b) => a.sequence - b.sequence)
  const last = all.at(-1)?.sequence ?? 0
  const terminal = all.some(event => terminalRunStatus(event.type) !== null)
  const removable = new Set(terminal ? createRunEventCompactionPlan(all).removed.map(event => event.sequence) : [])
  const missing = projected.filter(event => !bySequence.has(event.sequence))
  if (missing.some(event => !removable.has(event.sequence)))
    throw new PersistenceMigrationError('MIGRATION_EVENT_SOURCE_BEHIND')
  const gaps = all.filter((event, index) => event.sequence !== (all[index - 1]?.sequence ?? 0) + 1)
  const hasGaps = gaps.length > 0
  if (gaps.some(event => input.certifiedThrough === null || event.sequence > input.certifiedThrough))
    throw new PersistenceMigrationError('MIGRATION_EVENT_GAP_UNVERIFIED')
  return { events: [...events], nextSequence: last + 1, compacted: hasGaps || missing.length > 0 }
}

export function importLegacyRunHistory(database: DatabaseSync, input: {
  runId: string
  content: string | null
  sourceFingerprint: string
  certifiedThrough: number | null
}): { events: number, nextSequence: number } {
  const { runId, sourceFingerprint } = input
  const parsed = parseLegacyRunHistory(input.content ?? '', runId)
  const existing = database.prepare(`SELECT source_fingerprint, evidence_json FROM persistence_migration_entries
    WHERE migration_id = ? AND kind = 'run' AND source_id = ?`).get(PERSISTENCE_MIGRATION_ID, runId)
  if (existing) {
    if (existing.source_fingerprint !== sourceFingerprint)
      throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
    const evidence = JSON.parse(String(existing.evidence_json)) as { events: number, nextSequence: number, importedFingerprint: string }
    const current = new RunEventQueries(database).read(runId)
    const run = database.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get(runId)
    if (digest(current) !== evidence.importedFingerprint || run?.next_event_sequence !== evidence.nextSequence)
      throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
    return { events: evidence.events, nextSequence: evidence.nextSequence }
  }
  const profile = database.prepare('SELECT authority, migration_state FROM storage_profile WHERE id = 1').get()
  if (profile?.authority !== 'legacy_jsonl' || profile.migration_state !== 'pending')
    throw new PersistenceMigrationError('MIGRATION_NOT_PENDING')
  const queries = new RunEventQueries(database)
  const reconciled = reconcileLegacyRunHistory({
    events: parsed.events,
    projected: queries.read(runId),
    hasProductFacts: queries.hasProjectedEvents(runId),
    certifiedThrough: input.certifiedThrough,
  })
  return withTransaction(database, () => {
    assertLegacyMessageProjection(database, runId, reconciled.events)
    const projected = queries.read(runId)
    const existingSequences = new Set(projected.map(event => event.sequence))
    new RunEventProjector(database).project(reconciled.events.filter(event => !existingSequences.has(event.sequence)))
    const retained = new Set(reconciled.events.map(event => event.sequence))
    const remove = database.prepare('DELETE FROM run_events WHERE run_id = ? AND sequence = ?')
    for (const event of projected) {
      if (!retained.has(event.sequence))
        remove.run(runId, event.sequence)
    }
    const updated = database.prepare('UPDATE runs SET next_event_sequence = ? WHERE id = ?').run(reconciled.nextSequence, runId)
    if (updated.changes !== 1)
      throw new PersistenceMigrationError('MIGRATION_RUN_MISSING')
    const evidence = {
      events: reconciled.events.length,
      nextSequence: reconciled.nextSequence,
      compacted: reconciled.compacted,
      repairedNewline: parsed.repairedNewline,
      importedFingerprint: digest(queries.read(runId)),
    }
    database.prepare(`INSERT INTO persistence_migration_entries
      (migration_id, kind, source_id, source_fingerprint, evidence_json) VALUES (?, 'run', ?, ?, ?)`)
      .run(PERSISTENCE_MIGRATION_ID, runId, sourceFingerprint, JSON.stringify(evidence))
    return { events: evidence.events, nextSequence: evidence.nextSequence }
  })
}

function assertLegacyMessageProjection(database: DatabaseSync, runId: string, events: readonly BuddyRunEvent[]): void {
  const messages = new Map(events.flatMap((event) => {
    if (!['message.completed', 'message.interrupted', 'message.tool_result'].includes(event.type)
      || !event.payload || typeof event.payload !== 'object') {
      return []
    }
    const value = event.payload as Record<string, unknown>
    return typeof value.messageId === 'string' ? [[value.messageId, value] as const] : []
  }))
  for (const row of database.prepare(`SELECT id, role, content_json FROM messages WHERE run_id = ? AND role IN ('assistant', 'tool')`).iterate(runId)) {
    const source = messages.get(String(row.id))
    if (!source || source.role !== row.role || !isDeepStrictEqual(source.content, JSON.parse(String(row.content_json))))
      throw new PersistenceMigrationError('MIGRATION_PROJECTION_CONFLICT')
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

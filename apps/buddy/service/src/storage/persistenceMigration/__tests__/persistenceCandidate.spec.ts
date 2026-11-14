import type { BuddyRunEvent } from '../../../events/BuddyRunEvent'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { RunEventQueries } from '../../../events/RunEventQueries'
import { SqliteRunEventLog } from '../../../events/SqliteRunEventLog'
import { openBuddyDatabase, openBuddyMigrationCandidate } from '../../database'
import { activatePersistenceCandidate } from '../activatePersistenceCandidate'
import { importPersistenceCandidate } from '../importPersistenceCandidate'
import { parseLegacyRunHistory, reconcileLegacyRunHistory } from '../legacyRunHistory'

const roots: string[] = []
const now = '2026-11-06T00:00:00.000Z'
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function sourceFixture(options: { compact?: boolean, attachment?: boolean, pi?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-persistence-candidate-'))
  roots.push(directory)
  const sourceRoot = join(directory, 'original')
  const candidateRoot = join(directory, 'candidate')
  const databasePath = join(sourceRoot, 'buddy/buddy.sqlite3')
  const database = openBuddyDatabase({ databasePath })
  database.exec(`
    INSERT INTO conversations (id, created_at, updated_at) VALUES ('task', '${now}', '${now}');
    INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch', 'task', '${now}');
    UPDATE conversations SET active_branch_id = 'branch' WHERE id = 'task';
    INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at)
      VALUES ('input', 'task', 'branch', 'user', '{"text":"fixture"}', '${now}');
    INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('run', 'task', 'branch', 'input', 'fixture', 'fixture', 'chat', 'queued', '${now}');
    INSERT INTO turn_requests (request_id, request_fingerprint, conversation_id, branch_id, run_id, created_at)
      VALUES ('same-id', 'old-turn', 'task', 'branch', 'run', '${now}');
    INSERT INTO command_requests (request_id, request_fingerprint, conversation_id, branch_id, run_id, command, arguments, created_at)
      VALUES ('same-id', 'old-command', 'task', 'branch', 'run', 'compact', '', '${now}');
  `)
  const eventFile = join(sourceRoot, 'buddy/conversations/task/events/run.jsonl')
  const log = createRunEventLog({ database, conversationsDirectory: join(sourceRoot, 'buddy/conversations') })
  await log.appendBatch([
    { runId: 'run', type: 'run.queued', payload: {}, createdAt: now },
    { runId: 'run', type: 'message.delta', payload: { messageId: 'answer', delta: 'hello' }, createdAt: now },
    { runId: 'run', type: 'future.event', payload: { untouched: true }, createdAt: now },
    { runId: 'run', type: 'message.completed', payload: { messageId: 'answer', role: 'assistant', content: { text: 'hello' }, stopReason: 'completed' }, createdAt: now },
    { runId: 'run', type: 'run.completed', payload: {}, createdAt: now },
  ])
  if (options.compact)
    await log.compactTerminalRun('run')
  if (options.attachment) {
    const path = join(sourceRoot, 'buddy/conversations/task/inputs/input/attachment.txt')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'attachment')
    database.prepare(`INSERT INTO attachments (id, message_id, draft_id, name, mime_type, size_bytes, stored_path, source_path, created_at)
      VALUES ('attachment', 'input', NULL, 'attachment.txt', 'text/plain', 10, ?, NULL, ?)`)
      .run(path, now)
  }
  if (options.pi) {
    const path = join(sourceRoot, 'buddy/conversations/task/session/branch/session.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ type: 'session', id: 'session', version: 3, cwd: join(sourceRoot, 'buddy/conversations/task/workspace') })}\n${JSON.stringify({ type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: 'fixture' } })}\n`)
    database.prepare('UPDATE runs SET pi_session_file = ? WHERE id = ?').run(path, 'run')
  }
  await writeFile(join(sourceRoot, 'buddy/unknown-preserved.bin'), 'unknown bytes')
  await log.close()
  database.close()
  return { sourceRoot, candidateRoot, databasePath, eventFile, leaseDirectory: join(directory, 'locks'), signal: new AbortController().signal }
}

describe('persistence candidate migration', () => {
  it('limits in-place upgrades to owned data while leaving independent stores outside the candidate', async () => {
    const fixture = await sourceFixture({ attachment: true, pi: true })
    const excluded = ['buddy/unknown-preserved.bin', 'buddy/extensions/inference/model.bin', 'buddy/backups/old.bin', 'buddy/themes/custom.json', 'device/chromium/Cache/page', 'recovery/old/data', 'config.toml']
    for (const path of excluded) {
      await mkdir(dirname(join(fixture.sourceRoot, path)), { recursive: true })
      await writeFile(join(fixture.sourceRoot, path), 'untouched')
    }
    const result = await activatePersistenceCandidate({ ...fixture, scope: 'upgrade' })
    const manifest = JSON.parse(await readFile(join(fixture.candidateRoot, '.persistence-migration.json'), 'utf8'))
    expect(manifest.scope).toBe('upgrade')
    for (const path of excluded) {
      expect(manifest.entries.some((entry: { path: string }) => entry.path === path)).toBe(false)
      await expect(readFile(join(result.profileRoot, path))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(fixture.sourceRoot, path), 'utf8')).toBe('untouched')
    }
    expect(result).toMatchObject({ runs: 1, files: 1 })
    await expect(activatePersistenceCandidate(fixture)).rejects.toThrow('MIGRATION_SOURCE_CHANGED')
  })

  it('preserves unknown facts, aliases, bytes and Pi continuity and can resume verification', async () => {
    const fixture = await sourceFixture({ compact: true, attachment: true, pi: true })
    const original = await readFile(fixture.databasePath)
    const events = await readFile(fixture.eventFile)
    const result = await importPersistenceCandidate(fixture)
    expect(result).toMatchObject({ runs: 1, files: 1 })
    expect(await importPersistenceCandidate(fixture)).toEqual(result)
    expect(await readFile(fixture.databasePath)).toEqual(original)
    expect(await readFile(fixture.eventFile)).toEqual(events)
    expect(await readFile(join(result.profileRoot, 'buddy/unknown-preserved.bin'), 'utf8')).toBe('unknown bytes')
    const database = openBuddyMigrationCandidate({ databasePath: join(result.profileRoot, 'buddy/buddy.sqlite3') })
    try {
      expect(new RunEventQueries(database).read('run').map(event => event.sequence)).toEqual([1, 3, 4, 5])
      expect(database.prepare('SELECT next_event_sequence, status FROM runs').get()).toMatchObject({ next_event_sequence: 6, status: 'completed' })
      expect(database.prepare('SELECT namespace, request_id FROM legacy_request_aliases ORDER BY namespace').all()).toEqual([
        { namespace: 'command_requests', request_id: 'same-id' },
        { namespace: 'turn_requests', request_id: 'same-id' },
      ])
      expect(database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()?.count).toBe(0)
      expect(database.prepare('SELECT authority, migration_state FROM storage_profile').get()).toMatchObject({ authority: 'legacy_jsonl', migration_state: 'pending' })
      expect(database.prepare('SELECT state FROM persistence_migrations').get()?.state).toBe('verified')
      expect(database.prepare('SELECT state, size_bytes FROM managed_files').get()).toMatchObject({ state: 'ready', size_bytes: 10 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM file_references').get()?.count).toBeGreaterThan(0)
    }
    finally { database.close() }
  })

  it('activates only the verified candidate and keeps the source compatible with its old reader', async () => {
    const fixture = await sourceFixture({ attachment: true })
    const result = await activatePersistenceCandidate(fixture)
    expect(await activatePersistenceCandidate(fixture)).toEqual(result)
    const database = openBuddyMigrationCandidate({ databasePath: join(result.profileRoot, 'buddy/buddy.sqlite3') })
    const log = new SqliteRunEventLog({ database })
    try {
      expect(await log.read('run')).toHaveLength(5)
      expect(database.prepare('SELECT authority, migration_state FROM storage_profile').get()).toMatchObject({ authority: 'sqlite', migration_state: 'ready' })
      expect(() => openBuddyDatabase({ databasePath: join(result.profileRoot, 'buddy/buddy.sqlite3') })).toThrow('newer schema version')
    }
    finally {
      await log.close()
      database.close()
    }
    const original = openBuddyDatabase({ databasePath: fixture.databasePath })
    original.close()
  })

  it('refuses altered candidate files instead of declaring the source copy verified', async () => {
    const fixture = await sourceFixture()
    const result = await importPersistenceCandidate(fixture)
    await writeFile(join(result.profileRoot, 'buddy/unknown-preserved.bin'), 'changed candidate')
    await expect(activatePersistenceCandidate(fixture)).rejects.toThrow('MIGRATION_CANDIDATE_CHANGED')
    expect(await readFile(join(fixture.sourceRoot, 'buddy/unknown-preserved.bin'), 'utf8')).toBe('unknown bytes')
  })

  it('resumes a committed per-run checkpoint without duplicating facts', async () => {
    const fixture = await sourceFixture()
    await expect(importPersistenceCandidate({ ...fixture, checkpoint: async (phase) => {
      if (phase === 'run')
        throw new Error('interrupted')
    } })).rejects.toThrow('interrupted')
    const result = await importPersistenceCandidate(fixture)
    const database = openBuddyMigrationCandidate({ databasePath: join(result.profileRoot, 'buddy/buddy.sqlite3') })
    try {
      expect(new RunEventQueries(database).read('run')).toHaveLength(5)
      expect(database.prepare(`SELECT COUNT(*) AS count FROM persistence_migration_entries WHERE kind = 'run'`).get()?.count).toBe(1)
    }
    finally { database.close() }
  })

  it('blocks changed source data on resume and retains both copies', async () => {
    const fixture = await sourceFixture()
    await importPersistenceCandidate(fixture)
    await writeFile(join(fixture.sourceRoot, 'buddy/unknown-preserved.bin'), 'changed')
    await expect(importPersistenceCandidate(fixture)).rejects.toThrow('MIGRATION_SOURCE_CHANGED')
    expect(await readFile(join(fixture.candidateRoot, 'source/buddy/unknown-preserved.bin'), 'utf8')).toBe('unknown bytes')
  })

  it('blocks missing logs without deleting projected replies', async () => {
    const fixture = await sourceFixture()
    await unlink(fixture.eventFile)
    await expect(importPersistenceCandidate(fixture)).rejects.toThrow('MIGRATION_EVENT_SOURCE_MISSING')
    const database = openBuddyMigrationCandidate({ databasePath: join(fixture.candidateRoot, 'profile/buddy/buddy.sqlite3') })
    try {
      expect(database.prepare('SELECT id FROM messages WHERE id = ?').get('answer')?.id).toBe('answer')
    }
    finally { database.close() }
  })

  it('blocks missing attachments before any authority switch', async () => {
    const fixture = await sourceFixture({ attachment: true })
    await unlink(join(fixture.sourceRoot, 'buddy/conversations/task/inputs/input/attachment.txt'))
    await expect(importPersistenceCandidate(fixture)).rejects.toThrow('MIGRATION_REFERENCE_MISSING')
  })
})

const event = (sequence: number, type = 'future.event'): BuddyRunEvent => ({ runId: 'run', sequence, type, payload: {}, createdAt: now })

describe('legacy event evidence', () => {
  it('accepts a complete last line without newline and rejects incomplete JSON', () => {
    expect(parseLegacyRunHistory(JSON.stringify(event(1)), 'run')).toMatchObject({ repairedNewline: true, events: [event(1)] })
    expect(() => parseLegacyRunHistory(`${JSON.stringify(event(1))}\n{"runId":`, 'run')).toThrow('MIGRATION_EVENT_CORRUPTED')
  })
  it('does not discard conflicting SQL facts or silently accept sequence holes', () => {
    expect(() => reconcileLegacyRunHistory({ events: [event(1, 'run.queued')], projected: [event(1)], certifiedThrough: null, hasProductFacts: true })).toThrow('MIGRATION_EVENT_CONFLICT')
    expect(() => reconcileLegacyRunHistory({ events: [event(1), event(3)], projected: [event(1), event(3)], certifiedThrough: null, hasProductFacts: true })).toThrow('MIGRATION_EVENT_GAP_UNVERIFIED')
    expect(() => reconcileLegacyRunHistory({ events: [event(1)], projected: [event(1), event(2)], certifiedThrough: 2, hasProductFacts: true })).toThrow('MIGRATION_EVENT_SOURCE_BEHIND')
  })
})

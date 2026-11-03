import type { BuddyRunEvent } from '../BuddyRunEvent'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { BUDDY_SCHEMA_MIGRATIONS, BUDDY_SCHEMA_VERSION } from '../../storage/schema'
import { createRunEventLog } from '../createRunEventLog'
import { RunEventProjector } from '../RunEventProjector'
import { RUN_EVENT_PROJECTION_VERSION } from '../RunEventRecovery'
import { RunEventStore } from '../RunEventStore'

interface BootstrapFixture {
  root: string
  database: DatabaseSync
  file: string
  log: ReturnType<typeof createRunEventLog> | null
  reopen: () => Promise<void>
}

const NOW = '2026-10-04T00:00:00.000Z'
const fixtures: BootstrapFixture[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    await f.log?.close()
    f.database.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

describe('v40 bootstrap checkpoint certification', () => {
  it('upgrades real v38 storage without replaying trusted history or altering rowids, then enumerates no history', async () => {
    const f = await fixture()
    const before = projection(f.database)
    const content = await readFile(f.file, 'utf8')
    await f.reopen()
    expect(f.database.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect(maintenance(f.database)).toMatchObject({
      recovery_pending: 1,
      compaction_pending: 1,
      projection_version: 0,
      compaction_version: 0,
      revision: 0,
    })
    expect(await f.log!.recoverAll()).toMatchObject({ scanned: 1, skipped: 1, rebuilt: 0, events: 0, failed: 0 })
    expect(projection(f.database)).toEqual(before)
    expect(await readFile(f.file, 'utf8')).toBe(content)
    expect(maintenance(f.database)).toMatchObject({
      recovery_pending: 0,
      compaction_pending: 1,
      projection_version: RUN_EVENT_PROJECTION_VERSION,
      compaction_version: 0,
      revision: 0,
    })
    await f.reopen()
    const inspect = vi.spyOn(RunEventStore.prototype, 'fingerprint')
    const enumerate = vi.spyOn(RunEventStore.prototype, 'listPersistedRunIds')
    expect(await f.log!.recoverAll()).toMatchObject({ scanned: 0, skipped: 0, rebuilt: 0, events: 0 })
    expect(inspect).not.toHaveBeenCalled()
    expect(enumerate).not.toHaveBeenCalled()
    expect(projection(f.database)).toEqual(before)
    expect(await f.log!.append({ runId: 'run-1', type: 'future.audit', payload: {} })).toMatchObject({ sequence: 5 })
  })

  it.each([
    'DELETE FROM run_event_checkpoints',
    'UPDATE run_event_checkpoints SET projection_version = 2',
    'UPDATE run_event_checkpoints SET projection_version = 4',
    'UPDATE run_event_checkpoints SET last_sequence = 2',
    'UPDATE run_event_checkpoints SET file_fingerprint = \'untrusted\'',
  ])('rebuilds untrusted pre-upgrade metadata: %s', async (sql) => {
    const f = await fixture()
    f.database.exec(sql)
    await f.reopen()
    expect(maintenance(f.database)).toMatchObject({ revision: 0 })
    expect(await f.log!.recoverAll()).toMatchObject({ skipped: 0, rebuilt: 1, events: 4, failed: 0 })
    expect(f.database.prepare('SELECT content_json FROM messages').get()).toEqual({ content_json: '{"text":"durable answer"}' })
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 0, compaction_pending: 1 })
  })

  it.each([
    'recovery_pending = 0',
    'projection_version = 2',
    'compaction_version = 1',
    'compaction_pending = 0',
    'revision = 1',
  ])('does not treat non-bootstrap maintenance as initialization: %s', async (change) => {
    const f = await fixture()
    await f.reopen()
    f.database.exec(`UPDATE run_event_maintenance SET ${change}`)
    expect(await f.log!.recoverAll()).toMatchObject({ skipped: 0, rebuilt: 1, failed: 0 })
    expect(f.database.prepare('SELECT content_json FROM messages').get()).toEqual({ content_json: '{"text":"durable answer"}' })
  })

  it.each(['before inspection', 'during inspection'] as const)('rejects SQL changes %s even if the old checkpoint is reinserted', async (when) => {
    const f = await fixture()
    await f.reopen()
    const checkpoint = f.database.prepare('SELECT * FROM run_event_checkpoints').get()!
    const damage = () => {
      f.database.exec(`UPDATE messages SET content_json = '{"text":"damaged"}'`)
      f.database.prepare('INSERT INTO run_event_checkpoints (run_id, last_sequence, projection_version, file_fingerprint) VALUES (?, ?, ?, ?)')
        .run('run-1', checkpoint.last_sequence!, checkpoint.projection_version!, checkpoint.file_fingerprint!)
    }
    if (when === 'before inspection') {
      damage()
    }
    else {
      const fingerprint = RunEventStore.prototype.fingerprint
      vi.spyOn(RunEventStore.prototype, 'fingerprint').mockImplementationOnce(async function (this: RunEventStore, ...args) {
        const result = await fingerprint.apply(this, args)
        damage()
        return result
      })
    }
    expect(await f.log!.recoverAll()).toMatchObject({ skipped: 0, rebuilt: 1, failed: 0 })
    expect(f.database.prepare('SELECT content_json FROM messages').get()).toEqual({ content_json: '{"text":"durable answer"}' })
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 0 })
  })

  it('revalidates checkpoint changes made during asynchronous inspection', async () => {
    const f = await fixture()
    await f.reopen()
    const fingerprint = RunEventStore.prototype.fingerprint
    vi.spyOn(RunEventStore.prototype, 'fingerprint').mockImplementationOnce(async function (this: RunEventStore, ...args) {
      const result = await fingerprint.apply(this, args)
      f.database.exec('UPDATE run_event_checkpoints SET last_sequence = 3')
      return result
    })
    expect(await f.log!.recoverAll()).toMatchObject({ skipped: 0, rebuilt: 1, failed: 0 })
    expect(f.database.prepare('SELECT last_sequence FROM run_event_checkpoints').get()).toEqual({ last_sequence: 4 })
  })

  it('rebuilds a changed file instead of retaining its old answer', async () => {
    const f = await fixture()
    const content = await readFile(f.file, 'utf8')
    await f.reopen()
    await writeFile(f.file, content.replace('durable answer', 'updated answer'))
    expect(await f.log!.recoverAll()).toMatchObject({ skipped: 0, rebuilt: 1, failed: 0 })
    expect(f.database.prepare('SELECT content_json FROM messages').get()).toEqual({ content_json: '{"text":"updated answer"}' })
  })

  it.each(['missing', 'empty', 'corrupt'] as const)('quarantines %s upgraded logs without losing product facts', async (damage) => {
    const f = await fixture()
    const before = projection(f.database)
    await f.reopen()
    if (damage === 'missing')
      await rm(f.file)
    else if (damage === 'empty')
      await writeFile(f.file, '')
    else
      await appendFile(f.file, '{broken}\n')
    expect(await f.log!.recoverAll()).toMatchObject({ skipped: 0, rebuilt: 0, failed: 1 })
    expect(projection(f.database)).toEqual(before)
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 1 })
  })

  it('replays incomplete runs even with an otherwise matching legacy checkpoint', async () => {
    const f = await fixture(false)
    await f.reopen()
    expect(maintenance(f.database)).toMatchObject({ revision: 0 })
    expect(await f.log!.recoverAll()).toMatchObject({ skipped: 0, rebuilt: 1, events: 3, failed: 0 })
    expect(f.database.prepare('SELECT status FROM runs').get()).toEqual({ status: 'running' })
  })

  it('keeps certification failures fatal and rolls back without changing history', async () => {
    const f = await fixture()
    const before = projection(f.database)
    await f.reopen()
    const checkpoint = f.database.prepare('SELECT * FROM run_event_checkpoints').get()
    f.database.exec(`CREATE TRIGGER reject_certification BEFORE UPDATE ON run_event_maintenance
      WHEN NEW.recovery_pending = 0 BEGIN SELECT RAISE(ABORT, 'certification failed'); END;`)
    const progress: { completed: number, total: number }[] = []
    await expect(f.log!.recoverAll({ onProgress: value => progress.push(value) })).rejects.toMatchObject({ code: 'EVENT_PROJECTION_FAILED' })
    expect(f.log!.state).toBe('failed')
    expect(projection(f.database)).toEqual(before)
    expect(f.database.prepare('SELECT * FROM run_event_checkpoints').get()).toEqual(checkpoint)
    expect(maintenance(f.database)).toMatchObject({ recovery_pending: 1, projection_version: 0, revision: 0 })
    expect(progress).toEqual([{ completed: 0, total: 1 }])
  })

  it('honors force full validation for a trusted bootstrap checkpoint', async () => {
    const f = await fixture()
    const before = projection(f.database)
    await f.reopen()
    expect(await f.log!.recoverAll({ force: true })).toMatchObject({ skipped: 0, rebuilt: 1, events: 4, failed: 0 })
    expect(f.database.prepare('SELECT content_json FROM messages').get()).toEqual({ content_json: '{"text":"durable answer"}' })
    expect(projection(f.database).events).not.toEqual(before.events)
  })
})

async function fixture(terminal = true): Promise<BootstrapFixture> {
  const root = await mkdtemp(join(tmpdir(), 'lexora-bootstrap-recovery-'))
  const databasePath = join(root, 'buddy.sqlite3')
  const database = new DatabaseSync(databasePath)
  for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 38))
    database.exec(migration.sql)
  database.exec(`
    PRAGMA user_version = 38;
    INSERT INTO conversations (id, created_at, updated_at) VALUES ('conversation-1', '${NOW}', '${NOW}');
    INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES ('branch-1', 'conversation-1', '${NOW}');
    INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
      VALUES ('run-1', 'conversation-1', 'branch-1', 'user-1', 'fixture', 'fixture', 'chat', 'running', '${NOW}');
  `)
  const events: BuddyRunEvent[] = [
    { runId: 'run-1', sequence: 1, type: 'message.completed', createdAt: NOW, payload: { messageId: 'answer', role: 'assistant', content: { text: 'durable answer' }, stopReason: 'completed' } },
    { runId: 'run-1', sequence: 2, type: 'future.audit', createdAt: NOW, payload: { retained: true } },
    { runId: 'run-1', sequence: 3, type: 'run.progress', createdAt: NOW, payload: {} },
    ...terminal ? [{ runId: 'run-1', sequence: 4, type: 'run.completed', createdAt: NOW, payload: {} }] : [],
  ]
  const store = new RunEventStore({ conversationsDirectory: join(root, 'conversations'), resolveConversationId: () => 'conversation-1' })
  await store.append(events)
  new RunEventProjector(database).project(events)
  database.exec('UPDATE run_events SET rowid = rowid * 10 + 100; UPDATE messages SET rowid = 73')
  database.prepare('INSERT INTO run_event_checkpoints (run_id, last_sequence, projection_version, file_fingerprint) VALUES (?, ?, ?, ?)')
    .run('run-1', events.length, RUN_EVENT_PROJECTION_VERSION, await store.fingerprint('run-1'))
  const f: BootstrapFixture = {
    root,
    database,
    file: join(root, 'conversations', 'conversation-1', 'events', 'run-1.jsonl'),
    log: null,
    async reopen() {
      await f.log?.close()
      f.database.close()
      f.database = openBuddyDatabase({ databasePath })
      f.log = createRunEventLog({ database: f.database, conversationsDirectory: join(root, 'conversations') })
    },
  }
  fixtures.push(f)
  return f
}

function maintenance(database: DatabaseSync) {
  return database.prepare('SELECT * FROM run_event_maintenance WHERE run_id = ?').get('run-1')
}

function projection(database: DatabaseSync) {
  return {
    runs: database.prepare('SELECT rowid, * FROM runs ORDER BY id').all(),
    messages: database.prepare('SELECT rowid, * FROM messages ORDER BY id').all(),
    events: database.prepare('SELECT rowid, * FROM run_events ORDER BY run_id, sequence').all(),
  }
}

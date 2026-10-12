import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openBuddyDatabase } from '../database'
import { createExecutionRepository } from '../executionRepository'
import { createRunRepository } from '../runRepository'
import { BUDDY_SCHEMA_MIGRATIONS, BUDDY_SCHEMA_VERSION } from '../schema'
import { createThreadBindingRepository } from '../threadBindingRepository'
import { executionNow } from './executionFixture'
import { MIGRATION_TEST_TIMEOUT, openMigrationFixtureDatabase } from './migrationFixture'

it('upgrades v25 run phases, history and legacy journals without rewriting accepted inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-execution-migration-'))
  const path = join(directory, 'buddy.sqlite3')
  const previous = openMigrationFixtureDatabase(path)
  try {
    previous.exec('PRAGMA foreign_keys = OFF')
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 25))
      previous.exec(migration.sql)
    previous.prepare('INSERT INTO conversations (id, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run('conversation', 'branch', executionNow, executionNow)
    previous.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('branch', 'conversation', executionNow)
    previous.prepare('INSERT INTO conversation_pi_trees VALUES (?, ?, ?)').run('conversation', '/fixture/legacy.jsonl', 'legacy-root')
    previous.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('goal', 'conversation', 'branch', 'user', '{"text":"existing goal"}', executionNow)
    for (const [id, purpose, status] of [['chat', 'chat', 'completed'], ['compact', 'conversation.compaction', 'running'], ['queued', 'chat', 'queued']]) {
      previous.prepare('INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, pi_session_file, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id!, 'conversation', 'branch', 'goal', 'fixture', 'fixture', purpose!, status!, '/fixture/legacy.jsonl', executionNow, status === 'completed' ? executionNow : null)
    }
    previous.exec('PRAGMA user_version = 25')
  }
  finally {
    previous.close()
  }
  const database = openBuddyDatabase({ databasePath: path })
  try {
    const runs = createRunRepository(database)
    const executions = createExecutionRepository(database)
    const threads = createThreadBindingRepository(database)
    expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(BUDDY_SCHEMA_VERSION)
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(runs.findById('chat')).toMatchObject({ rootRunId: 'chat', parentRunId: null, executionKind: 'root', generation: 0, actorSnapshot: null, modelOverride: null, piSessionFile: '/fixture/legacy.jsonl' })
    expect(runs.findById('compact')).toMatchObject({ rootRunId: 'compact', executionKind: 'maintenance', threadId: runs.findById('chat')!.threadId })
    expect(executions.find('chat')).toMatchObject({ phase: 'closed', cleanupState: 'clean' })
    expect(executions.find('compact')).toMatchObject({ phase: 'working', cleanupState: 'pending' })
    expect(executions.find('queued')).toMatchObject({ phase: 'queued', cleanupState: 'pending' })
    expect(database.prepare('SELECT * FROM conversation_pi_trees').get()).toMatchObject({ session_file: '/fixture/legacy.jsonl', root_entry_id: 'legacy-root' })
    expect(threads.findBinding(runs.findById('chat')!.threadId)).toBeNull()
    expect(database.prepare('SELECT content_json FROM messages WHERE id = ?').get('goal')?.content_json).toBe('{"text":"existing goal"}')
  }
  finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, MIGRATION_TEST_TIMEOUT)

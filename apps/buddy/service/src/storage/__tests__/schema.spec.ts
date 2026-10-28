import type { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createChangeSetRepository } from '../../changes/changeSetRepository'
import { MutationCoordinator } from '../../changes/MutationCoordinator'
import { createMutationRepository } from '../../changes/mutationRepository'

import { createComposerResourceRepository } from '../composerResourceRepository'
import { openBuddyDatabase } from '../database'
import { createExtensionInvocationRepository } from '../extensionInvocationRepository'
import { BUDDY_V15_CAPABILITY_OVERRIDES_SCHEMA_SQL, BUDDY_V15_CATALOG_MODEL_ID_SCHEMA_SQL, BUDDY_V15_CATALOG_SELECTION_SCHEMA_SQL, BUDDY_V15_MODEL_SERVICES_SCHEMA_SQL, BUDDY_V15_PROVIDER_INSTANCES_SCHEMA_SQL, BUDDY_V15_REQUEST_HEADERS_SCHEMA_SQL } from '../migrations/v15ModelServices'
import { BUDDY_SCHEMA_MIGRATIONS, BUDDY_SCHEMA_VERSION } from '../schema'
import { createUsageAnalyticsRepository } from '../usageAnalyticsRepository'
import { createUsageRepository } from '../usageRepository'
import { MIGRATION_TEST_TIMEOUT, openMigrationFixtureDatabase } from './migrationFixture'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true })
})

function createDatabase(): DatabaseSync {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  return database
}

function seedRun(
  database: DatabaseSync,
  memoryScope: 'personal_and_project' | 'personal_and_space' = 'personal_and_space',
): void {
  database.exec(`
    INSERT INTO spaces (
      id, name, memory_scope, revoked_at, created_at, updated_at
    ) VALUES (
      'space-1', 'Workspace', '${memoryScope}', NULL,
      '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
    );
    INSERT INTO space_directory_bindings (
      id, space_id, root, canonical_root, access_granted_at, resources_trusted_at,
      is_primary, revision, revoked_at, created_at, updated_at
    ) VALUES (
      'directory-1', 'space-1', '/workspace', '/workspace',
      '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z',
      1, 1, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
    );
    INSERT INTO conversations (
      id, space_id, title, active_branch_id, created_at, updated_at
    ) VALUES (
      'conversation-1', 'space-1', 'Conversation', NULL,
      '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
    );
    INSERT INTO conversation_branches (
      id, conversation_id, parent_branch_id, forked_from_message_id, created_at
    ) VALUES (
      'branch-1', 'conversation-1', NULL, NULL, '2026-08-14T00:00:00.000Z'
    );
    UPDATE conversations SET active_branch_id = 'branch-1' WHERE id = 'conversation-1';
    INSERT INTO messages (
      id, conversation_id, branch_id, run_id, role, content_json, created_at
    ) VALUES (
      'message-1', 'conversation-1', 'branch-1', NULL, 'user',
      '{"text":"hello"}', '2026-08-14T00:00:00.000Z'
    );
    INSERT INTO runs (
      id, conversation_id, branch_id, triggering_message_id, provider, model,
      purpose, status, pi_session_file, error_code, started_at, completed_at
    ) VALUES (
      'run-1', 'conversation-1', 'branch-1', 'message-1', 'anthropic',
      'claude-sonnet-4-5', 'chat', 'running', '/tmp/run-1.jsonl', NULL,
      '2026-08-14T00:00:00.000Z', NULL
    );
  `)
}

describe('buddy schema', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
  it('upgrades schema 34 without rewriting queued input or historical data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-input-delivery-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 34))
      previous.exec(migration.sql)
    seedRun(previous)
    const legacy = JSON.stringify({ buddyId: 'default', userMessageContent: { text: 'Keep this queued input' }, requestId: 'legacy' }, null, 2)
    previous.prepare('INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at) VALUES (?, \'conversation-1\', \'branch-1\', ?, ?, ?, \'paused\', ?)').run('legacy', 'legacy', 'legacy-fingerprint', legacy, '2026-10-27T00:00:00.000Z')
    const before = {
      queue: previous.prepare('SELECT * FROM chat_queue ORDER BY id').all(),
      messages: previous.prepare('SELECT * FROM messages ORDER BY id').all(),
      runs: previous.prepare('SELECT * FROM runs ORDER BY id').all(),
    }
    previous.exec('PRAGMA user_version = 34')
    previous.close()

    const migrated = openBuddyDatabase({ databasePath })
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect(BUDDY_SCHEMA_VERSION).toBeGreaterThan(34)
    expect(migrated.prepare('SELECT * FROM chat_queue ORDER BY id').all()).toEqual(before.queue)
    expect(migrated.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before.messages)
    expect(migrated.prepare('SELECT * FROM runs ORDER BY id').all()).toEqual(before.runs)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    migrated.close()

    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(reopened.prepare('SELECT * FROM chat_queue ORDER BY id').all()).toEqual(before.queue)
    expect(reopened.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before.messages)
    expect(reopened.prepare('SELECT * FROM runs ORDER BY id').all()).toEqual(before.runs)
  })

  it('marks the actor identity format upgrade without rewriting legacy execution snapshots', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-actor-identity-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 33))
      previous.exec(migration.sql)
    seedRun(previous)
    const settings = previous.prepare('SELECT settings_json FROM buddies WHERE id = ?').get('default')!.settings_json
    const configuration = { version: 1, id: 'default', kind: 'actor', revision: 1, settings: JSON.parse(String(settings)) }
    const actorSnapshot = JSON.stringify({ ...configuration, model: { providerId: 'fixture', modelId: 'model', reasoning: null, serviceTier: null }, modelSource: 'application' }, null, 2)
    const automationSnapshot = JSON.stringify(configuration, null, 4)
    previous.prepare('UPDATE runs SET actor_snapshot_json = ? WHERE id = ?').run(actorSnapshot, 'run-1')
    previous.exec(`
      INSERT INTO automations (
        id, name, prompt, model_mode, schedule_kind, schedule_json, timezone,
        status, revision, created_at, updated_at
      ) VALUES (
        'automation-1', 'Scheduled review', 'Review', 'default', 'once',
        '{"kind":"once","runAt":"2026-10-27T00:00:00.000Z"}', 'UTC',
        'paused', 1, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z'
      );
    `)
    previous.prepare(`
      INSERT INTO automation_occurrences (
        id, automation_id, dedupe_key, trigger_kind, scheduled_for,
        automation_revision, execution_snapshot_json, status, queued_at, actor_snapshot_json
      ) VALUES (?, ?, ?, 'scheduled', ?, 1, ?, 'queued', ?, ?)
    `).run('occurrence-1', 'automation-1', 'scheduled-review', '2026-10-27T00:00:00.000Z', JSON.stringify({ actorId: 'default', executionProfile: 'workspace_write', model: { mode: 'default' }, name: 'Scheduled review', prompt: 'Review', spaceId: null }), '2026-10-26T00:00:00.000Z', automationSnapshot)
    previous.exec('PRAGMA user_version = 33')
    previous.close()

    const migrated = openBuddyDatabase({ databasePath })
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect(migrated.prepare('SELECT actor_snapshot_json FROM runs WHERE id = ?').get('run-1')).toEqual({ actor_snapshot_json: actorSnapshot })
    expect(migrated.prepare('SELECT actor_snapshot_json FROM automation_occurrences WHERE id = ?').get('occurrence-1')).toEqual({ actor_snapshot_json: automationSnapshot })
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    migrated.close()
    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(reopened.prepare('SELECT actor_snapshot_json FROM runs WHERE id = ?').get('run-1')).toEqual({ actor_snapshot_json: actorSnapshot })
    expect(reopened.prepare('SELECT actor_snapshot_json FROM automation_occurrences WHERE id = ?').get('occurrence-1')).toEqual({ actor_snapshot_json: automationSnapshot })
  })

  it('upgrades capture coverage without rewriting historical file snapshots or invocation identities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-capture-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 31))
      previous.exec(migration.sql)
    seedRun(previous)
    previous.exec(`
      INSERT INTO run_change_sets (id, run_id, conversation_id, coverage, status, file_count, created_at, updated_at)
        VALUES ('set', 'run-1', 'conversation-1', 'partial', 'completed', 1, '2026-10-01', '2026-10-01');
      INSERT INTO run_change_invocations (id, run_id, segment_id, tool_call_id, tool_name, status, created_at, completed_at)
        VALUES ('invocation', 'run-1', 'segment', 'call', 'bash', 'partial', '2026-10-01', '2026-10-01');
      INSERT INTO run_file_change_captures (id, change_set_id, sequence, tool_call_id, tool_name, relative_path, before_kind, before_snapshot_path, after_kind, after_snapshot_path, status, created_at, invocation_id)
        VALUES ('file', 'set', 1, 'call', 'write', 'file.txt', 'text', 'before.txt', 'text', 'after.txt', 'completed', '2026-10-01', 'invocation');
    `)
    const captures = previous.prepare('SELECT * FROM run_file_change_captures').all()
    previous.exec('PRAGMA user_version = 31')
    previous.close()
    const migrated = openBuddyDatabase({ databasePath })
    expect(createChangeSetRepository(migrated).findSetById('set')).toMatchObject({ coverage: 'partial', coverageReasons: ['legacy_partial'] })
    expect(createChangeSetRepository(migrated).findInvocation('invocation')).toMatchObject({ captureMode: 'legacy', segmentId: 'segment' })
    expect(migrated.prepare('SELECT * FROM run_file_change_captures').all()).toEqual(captures)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    migrated.close()
    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(reopened.prepare('SELECT * FROM run_file_change_captures').all()).toEqual(captures)
    expect(createChangeSetRepository(reopened).findSetById('set')?.coverageReasons).toEqual(['legacy_partial'])
  })

  it.each(['override', 'snapshot', 'original'])('freezes missing task models from the latest %s and preserves explicit choices on upgrade', (source) => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-task-model-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 29))
      previous.exec(migration.sql)
    seedRun(previous)
    const selection = { providerId: 'fixture', modelId: 'chosen-model', reasoning: 'high', serviceTier: 'priority' }
    previous.exec(`
      INSERT INTO conversation_members (conversation_id, actor_id, joined_at) VALUES ('conversation-1', 'default', '2026-08-14T00:00:00.000Z');
      INSERT INTO buddies (id, kind, name, settings_json, created_at, updated_at)
        SELECT 'second', 'actor', 'Second', settings_json, created_at, updated_at FROM buddies WHERE id = 'default';
      INSERT INTO buddies (id, kind, name, settings_json, created_at, updated_at)
        SELECT 'unused', 'actor', 'Unused', settings_json, created_at, updated_at FROM buddies WHERE id = 'default';
      INSERT INTO conversation_members (conversation_id, actor_id, joined_at) VALUES ('conversation-1', 'second', '2026-08-14T00:00:00.000Z'), ('conversation-1', 'unused', '2026-08-14T00:00:00.000Z');
      INSERT INTO run_inputs (run_id, prompt, attachment_ids_json, context_items_json, reasoning, service_tier, created_at)
        VALUES ('run-1', 'hello', '[]', '[]', 'high', 'priority', '2026-08-14T00:00:00.000Z');
      INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, buddy_id, execution_kind)
        VALUES ('run-2', 'conversation-1', 'branch-1', 'message-1', 'fixture', 'second-model', 'chat', 'completed', '2026-08-15T00:00:00.000Z', 'second', 'actor_child'),
        ('run-3', 'conversation-1', 'branch-1', 'message-1', 'fixture', 'latest-model', 'chat', 'running', '2026-08-16T00:00:00.000Z', 'default', 'root');
    `)
    if (source === 'override') {
      previous.prepare('UPDATE runs SET model_override_json = ? WHERE id = ?').run(JSON.stringify(selection), 'run-3')
    }
    else if (source === 'snapshot') {
      previous.prepare('UPDATE runs SET actor_snapshot_json = ? WHERE id = ?').run(JSON.stringify({ model: selection }), 'run-3')
    }
    else {
      previous.prepare('UPDATE runs SET provider = ?, model = ? WHERE id = ?').run(selection.providerId, selection.modelId, 'run-3')
      previous.prepare('INSERT INTO run_inputs (run_id, prompt, attachment_ids_json, context_items_json, reasoning, service_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('run-3', 'latest', '[]', '[]', selection.reasoning, selection.serviceTier, '2026-08-16T00:00:00.000Z')
    }
    previous.prepare('UPDATE conversation_members SET model_selection_json = ?, model_selection_source = \'explicit\', removed_at = \'2026-08-16T00:00:00.000Z\' WHERE actor_id = \'second\'').run(JSON.stringify(selection))
    const runs = previous.prepare('SELECT * FROM runs ORDER BY id').all()
    const messages = previous.prepare('SELECT * FROM messages ORDER BY id').all()
    previous.exec('PRAGMA user_version = 29')
    previous.close()

    const migrated = openBuddyDatabase({ databasePath })
    const members = migrated.prepare('SELECT actor_id, model_selection_json, model_selection_source, removed_at FROM conversation_members ORDER BY actor_id').all()
    expect(members).toEqual([
      { actor_id: 'default', model_selection_json: JSON.stringify(selection), model_selection_source: 'snapshot', removed_at: null },
      { actor_id: 'second', model_selection_json: JSON.stringify(selection), model_selection_source: 'explicit', removed_at: '2026-08-16T00:00:00.000Z' },
      { actor_id: 'unused', model_selection_json: null, model_selection_source: null, removed_at: null },
    ])
    expect(migrated.prepare('SELECT * FROM runs ORDER BY id').all()).toEqual(runs.map(run => ({ ...run, scheduling_lane: 'conversation' })))
    expect(migrated.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(messages)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    migrated.close()
    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(reopened.prepare('SELECT actor_id, model_selection_json, model_selection_source, removed_at FROM conversation_members ORDER BY actor_id').all()).toEqual(members)
  })

  it('upgrades reference authorization without rewriting existing messages and restores exclusions after reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-reference-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 28))
      previous.exec(migration.sql)
    seedRun(previous)
    const messages = previous.prepare('SELECT * FROM messages ORDER BY id').all()
    const runs = previous.prepare('SELECT * FROM runs ORDER BY id').all()
    const snapshot = previous.prepare('SELECT public_sequence FROM run_public_snapshots WHERE run_id = ?').get('run-1')
    previous.exec('PRAGMA user_version = 28')
    previous.close()
    const migrated = openBuddyDatabase({ databasePath })
    expect(migrated.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(messages)
    expect(migrated.prepare('SELECT * FROM runs ORDER BY id').all()).toEqual(runs.map(run => ({ ...run, scheduling_lane: 'conversation' })))
    expect(migrated.prepare('SELECT public_sequence FROM run_session_reference_scopes WHERE run_id = ?').get('run-1')).toEqual(snapshot)
    migrated.prepare('INSERT INTO session_reference_exclusions VALUES (?, ?, ?, ?)').run('conversation-1', 'branch-1', 'source', '2026-10-14T00:00:00.000Z')
    migrated.close()
    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(reopened.prepare('SELECT session_id FROM session_reference_exclusions').all()).toEqual([{ session_id: 'source' }])
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('retains existing and deleted profile avatars when upgrading to custom galleries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-avatar-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 27))
      previous.exec(migration.sql)
    const avatar = 'data:image/png;base64,AAAA'
    previous.prepare('UPDATE buddies SET avatar = ?, revision = 3 WHERE id IN (?, ?)').run(avatar, 'default', 'npc-reviewer')
    previous.prepare('UPDATE buddies SET deleted_at = ? WHERE id = ?').run('2026-10-13T00:00:00.000Z', 'npc-reviewer')
    const before = previous.prepare('SELECT * FROM buddies ORDER BY id').all()
    previous.exec('PRAGMA user_version = 27')
    previous.close()

    const migrated = openBuddyDatabase({ databasePath })
    const after = migrated.prepare('SELECT * FROM buddies ORDER BY id').all()
    expect(after.map(({ custom_avatars_json: gallery, ...profile }) => {
      expect(JSON.parse(gallery as string)).toEqual(profile.avatar ? [avatar] : [])
      return profile
    })).toEqual(before)
    expect(migrated.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    migrated.close()
    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(reopened.prepare('SELECT * FROM buddies ORDER BY id').all()).toEqual(after)
  })

  it('upgrades Azure source identifiers without changing account identities, selections or history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-azure-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 22))
      previous.exec(migration.sql)
    seedRun(previous)
    previous.exec(`
      PRAGMA user_version = 22;
      UPDATE runs SET provider = 'azure-openai-responses';
      INSERT INTO provider_states (provider_id, enabled, request_headers_json, created_at, updated_at)
      VALUES ('azure-openai-responses', 1, '[{"name":"api-key","value":"\${apiKey}"}]', 'created', 'updated');
      INSERT INTO builtin_provider_configs (id, builtin_provider_id, display_name, created_at, updated_at)
      VALUES ('azure-openai-responses', 'azure-openai-responses', 'Personal Azure', 'created', 'updated'),
        ('builtin-work', 'azure-openai-responses', 'Work Azure', 'created', 'updated'),
        ('anthropic', 'anthropic', NULL, 'created', 'updated');
      INSERT INTO default_model_setting (singleton, provider_id, model_id, reasoning, updated_at)
      VALUES (1, 'azure-openai-responses', 'model', 'high', 'updated');
      INSERT INTO provider_model_states (provider_id, model_id, display_name, api, input_json, reasoning, cost_json,
        context_window, max_tokens, override_context_window, override_max_tokens, source, enabled, available, created_at, updated_at)
      VALUES ('azure-openai-responses', 'model', 'Model', 'azure-openai-responses', '["text"]', 1, '{}',
        32000, 4000, 16000, 2000, 'builtin', 1, 1, 'created', 'updated');
      INSERT INTO provider_configs (id, display_name, api, base_url, models_json, enabled, created_at, updated_at)
      VALUES ('custom-azure', 'Custom Azure', 'azure-openai-responses', 'https://example.test/v1', '[]', 1, 'created', 'updated');
    `)
    const configs = previous.prepare('SELECT * FROM builtin_provider_configs ORDER BY id').all()
    const tables = ['runs', 'provider_states', 'provider_model_states', 'provider_configs', 'default_model_setting']
    const before = tables.map(table => previous.prepare(`SELECT * FROM ${table}`).all())
    previous.close()
    const upgraded = openBuddyDatabase({ databasePath })
    expect(upgraded.prepare('SELECT * FROM builtin_provider_configs ORDER BY id').all()).toEqual(configs.map(config => ({
      ...config,
      builtin_provider_id: config.builtin_provider_id === 'azure-openai-responses' ? 'azure' : config.builtin_provider_id,
    })))
    expect(tables.map(table => upgraded.prepare(`SELECT * FROM ${table}`).all())).toEqual(before.map((rows, index) => ['runs', 'conversations'].includes(tables[index]!) ? rows.map(row => ({ ...row, buddy_id: 'default', ...(tables[index] === 'runs' ? { actor_snapshot_json: null, model_override_json: null, root_run_id: row.id, parent_run_id: null, execution_kind: 'root', thread_id: 'actor:["conversation-1","default"]', generation: 0, scheduling_lane: 'conversation' } : {}) })) : rows.map(row => ({ ...row, ...(tables[index] === 'provider_model_states' ? { service_metadata_json: null } : {}) }))))
    upgraded.close()
    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(tables.map(table => reopened.prepare(`SELECT * FROM ${table}`).all())).toEqual(before.map((rows, index) => ['runs', 'conversations'].includes(tables[index]!) ? rows.map(row => ({ ...row, buddy_id: 'default', ...(tables[index] === 'runs' ? { actor_snapshot_json: null, model_override_json: null, root_run_id: row.id, parent_run_id: null, execution_kind: 'root', thread_id: 'actor:["conversation-1","default"]', generation: 0, scheduling_lane: 'conversation' } : {}) })) : rows.map(row => ({ ...row, ...(tables[index] === 'provider_model_states' ? { service_metadata_json: null } : {}) }))))
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each([22, 23])('upgrades v%i with checkpoints without changing historical data', (version) => {
    const root = mkdtempSync(join(tmpdir(), 'buddy-checkpoint-migration-'))
    directories.push(root)
    const databasePath = join(root, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= version)) {
      legacy.exec(migration.sql)
      legacy.exec(`PRAGMA user_version = ${migration.version}`)
    }
    seedRun(legacy)
    const before = {
      runs: legacy.prepare('SELECT * FROM runs').all(),
      messages: legacy.prepare('SELECT rowid, * FROM messages').all(),
      conversations: legacy.prepare('SELECT * FROM conversations').all(),
    }
    legacy.close()
    const migrated = openBuddyDatabase({ databasePath })
    databases.push(migrated)
    expect(migrated.prepare('SELECT * FROM runs').all()).toEqual(before.runs.map(run => ({ ...run, buddy_id: 'default', actor_snapshot_json: null, model_override_json: null, root_run_id: run.id, parent_run_id: null, execution_kind: 'root', thread_id: 'actor:["conversation-1","default"]', generation: 0, scheduling_lane: 'conversation' })))
    expect(migrated.prepare('SELECT rowid, * FROM messages').all()).toEqual(before.messages)
    expect(migrated.prepare('SELECT * FROM conversations').all()).toEqual(before.conversations.map(conversation => ({ ...conversation, buddy_id: 'default' })))
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
  })

  it('rejects a current database missing checkpoint invalidation triggers', () => {
    const root = mkdtempSync(join(tmpdir(), 'buddy-checkpoint-schema-'))
    directories.push(root)
    const databasePath = join(root, 'buddy.sqlite3')
    const database = openBuddyDatabase({ databasePath })
    database.exec('DROP TRIGGER invalidate_run_checkpoint_messages_delete')
    database.close()
    expect(() => openBuddyDatabase({ databasePath })).toThrow(/incomplete checkpoint invalidation schema/i)
  })
  it('preserves v21 usage and attributes independent actions without modifying completed runs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-action-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 21))
      previous.exec(migration.sql)
    seedRun(previous)
    previous.exec(`
      UPDATE runs SET status = 'completed', completed_at = '2026-08-14T00:01:00.000Z';
      INSERT INTO usage_records (
        id, run_id, source_entry_id, provider, model, purpose,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
        input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at
      ) VALUES ('usage-1', 'run-1', 'source-1', 'provider', 'model', 'turn', 10, 5, 3, 2, 1, 20, 0.1, 0.2, 0.3, 0.4, 1, '2026-08-14T00:00:00.000Z');
      PRAGMA user_version = 21;
    `)
    const before = previous.prepare('SELECT * FROM usage_records').all()
    const runs = previous.prepare('SELECT * FROM runs').all()
    previous.close()
    const upgraded = openBuddyDatabase({ databasePath })
    databases.push(upgraded)
    expect(upgraded.prepare('SELECT * FROM usage_records').all()).toEqual(before.map(record => ({ ...record, invocation_id: null })))
    const invocations = createExtensionInvocationRepository(upgraded)
    invocations.start({ id: 'invocation', extensionId: 'test.action', actionId: 'test.action.generate', conversationId: 'conversation-1', trigger: 'user', startedAt: '2026-08-14T00:02:00.000Z' })
    const usage = createUsageRepository(upgraded)
    const original = usage.listForRun('run-1')[0]!
    const action = { ...original, id: 'usage-2', runId: null, invocationId: 'invocation', purpose: 'extension.action' }
    expect(usage.recordInvocation(action)).toBe(true)
    expect(usage.recordInvocation({ ...action, id: 'duplicate' })).toBe(false)
    expect(usage.listForRun('run-1')).toEqual([original])
    expect(usage.summarize()).toMatchObject({ recordCount: 2, totalTokens: 40, totalCost: 2 })
    expect(createUsageAnalyticsRepository(upgraded).topTasks({ startDate: '2026-08-14', endDate: '2026-08-14', timeZone: 'UTC', model: null })).toMatchObject([{ conversationId: 'conversation-1', totalTokens: 40, recordCount: 2 }])
    expect(() => upgraded.prepare('UPDATE usage_records SET run_id = \'run-1\' WHERE id = \'usage-2\'').run()).toThrow(/CHECK constraint/)
    expect(() => upgraded.prepare('UPDATE usage_records SET invocation_id = NULL WHERE id = \'usage-2\'').run()).toThrow(/CHECK constraint/)
    expect(upgraded.prepare('SELECT * FROM runs').all()).toEqual(runs.map(run => ({ ...run, buddy_id: 'default', actor_snapshot_json: null, model_override_json: null, root_run_id: run.id, parent_run_id: null, execution_kind: 'root', thread_id: 'actor:["conversation-1","default"]', generation: 0, scheduling_lane: 'conversation' })))
    expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('upgrades v18 without rewriting legacy sources and permits independent local reference identities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-local-reference-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 18))
      previous.exec(migration.sql)
    previous.exec('PRAGMA user_version = 18')
    const metadata = { resourceId: 'legacy', name: 'note.txt', mimeType: 'text/plain', sizeBytes: 3 }
    const source = { spaceId: 'space', bindingId: 'binding', bindingRevision: 1, relativePath: 'note.txt' }
    const old = createComposerResourceRepository(previous).selectSource('draft', metadata, source, '2026-09-15T00:00:00.000Z')
    previous.close()
    const upgraded = openBuddyDatabase({ databasePath })
    databases.push(upgraded)
    const repository = createComposerResourceRepository(upgraded)
    expect(repository.findById('legacy')).toEqual(old)
    const localReference = { kind: 'file' as const, path: '/workspace/note.txt', name: 'note.txt', mimeType: 'text/plain', sizeBytes: 3 }
    repository.acceptBatch('draft', ['one', 'two'].map(resourceId => ({ metadata: { ...metadata, resourceId }, source: { localReference } })), '2026-09-15T00:00:00.000Z')
    expect(repository.listForDraft('draft').map(resource => resource.resourceId)).toEqual(['legacy', 'one', 'two'])
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it.each([14, 15])('preserves existing services and model references when completing model services from v%s', (version) => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-provider-instances-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 14))
      legacy.exec(migration.sql)
    if (version === 15) {
      legacy.exec(BUDDY_V15_MODEL_SERVICES_SCHEMA_SQL
        .replace(BUDDY_V15_PROVIDER_INSTANCES_SCHEMA_SQL, '')
        .replace(BUDDY_V15_CATALOG_MODEL_ID_SCHEMA_SQL, '')
        .replace(BUDDY_V15_CATALOG_SELECTION_SCHEMA_SQL, '')
        .replace(BUDDY_V15_REQUEST_HEADERS_SCHEMA_SQL, '')
        .replace(BUDDY_V15_CAPABILITY_OVERRIDES_SCHEMA_SQL, ''))
    }
    legacy.exec(`PRAGMA user_version = ${version}`)
    seedRun(legacy)
    const now = '2026-09-12T00:00:00.000Z'
    legacy.prepare('INSERT INTO provider_states VALUES (?, ?, ?, ?)').run('anthropic', 1, now, now)
    legacy.prepare('INSERT INTO provider_states VALUES (?, ?, ?, ?)').run('azure-openai-responses', 1, now, now)
    legacy.prepare('INSERT INTO provider_states VALUES (?, ?, ?, ?)').run('proxy', 1, now, now)
    legacy.prepare(`INSERT INTO provider_configs (id, display_name, api, base_url, models_json, credential_ref, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('proxy', 'Proxy', 'openai-completions', 'https://models.example.test/v1', '[]', 'proxy', 1, now, now)
    legacy.exec(`
      INSERT INTO provider_model_states (
        provider_id, model_id, display_name, api, input_json, reasoning, cost_json,
        context_window, max_tokens, override_context_window, override_max_tokens,
        source_revision, acknowledged_source_revision, source, enabled, available,
        last_seen_at, created_at, updated_at
      ) VALUES (
        'proxy', 'model-1', 'Model 1', 'openai-responses', '["text"]', 1,
        '{"input":1,"output":2,"cacheRead":0,"cacheWrite":0}',
        128000, 16384, 96000, 12000, 'source-v1', NULL, 'synced', 1, 1,
        '${now}', '${now}', '${now}'
      );
    `)
    const states = legacy.prepare('SELECT * FROM provider_states ORDER BY provider_id').all()
    const configs = legacy.prepare('SELECT * FROM provider_configs').all()
    const models = legacy.prepare('SELECT * FROM provider_model_states').all()
    const runs = legacy.prepare('SELECT * FROM runs').all()
    legacy.close()

    const upgraded = openBuddyDatabase({ databasePath })
    expect(upgraded.prepare('SELECT * FROM provider_states ORDER BY provider_id').all()).toEqual(states.map(state => ({ ...state, request_headers_json: '[]' })))
    expect(upgraded.prepare('SELECT * FROM provider_configs').all()).toEqual(configs)
    expect(upgraded.prepare('SELECT * FROM runs').all()).toEqual(runs.map(run => ({ ...run, buddy_id: 'default', actor_snapshot_json: null, model_override_json: null, root_run_id: run.id, parent_run_id: null, execution_kind: 'root', thread_id: 'actor:["conversation-1","default"]', generation: 0, scheduling_lane: 'conversation' })))
    expect(upgraded.prepare('SELECT id, builtin_provider_id, display_name FROM builtin_provider_configs').all()).toEqual([
      { id: 'anthropic', builtin_provider_id: 'anthropic', display_name: null },
      { id: 'azure-openai-responses', builtin_provider_id: 'azure', display_name: null },
    ])
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect(upgraded.prepare('SELECT * FROM provider_model_states').all()).toEqual(models.map(model => ({
      ...model,
      thinking_level_map_json: null,
      sampling_params_json: null,
      compat_json: null,
      catalog_provider_id: null,
      source_fingerprint: '',
      catalog_model_id: null,
      catalog_selection_json: null,
      capability_overrides_json: null,
      service_metadata_json: null,
    })))
    upgraded.prepare('UPDATE builtin_provider_configs SET display_name = ? WHERE id = ?').run('Personal', 'anthropic')
    upgraded.prepare('UPDATE provider_states SET request_headers_json = ? WHERE provider_id = ?').run(`[{"name":"api-key","value":"\${apiKey}"}]`, 'anthropic')
    upgraded.close()

    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(reopened.prepare('SELECT display_name FROM builtin_provider_configs').get()).toEqual({ display_name: 'Personal' })
    expect(reopened.prepare('SELECT request_headers_json FROM provider_states WHERE provider_id = ?').get('anthropic')).toEqual({ request_headers_json: `[{"name":"api-key","value":"\${apiKey}"}]` })
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('migrates v10 spaces with default appearance without altering grants, tasks or memory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-space-appearance-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 10)) {
      legacy.exec(migration.sql)
      legacy.exec(`PRAGMA user_version = ${migration.version}`)
    }
    seedRun(legacy)
    const space = legacy.prepare('SELECT * FROM spaces').get()
    const grants = legacy.prepare('SELECT * FROM space_directory_bindings').all()
    const tasks = legacy.prepare('SELECT * FROM conversations').all()
    const runs = legacy.prepare('SELECT * FROM runs').all()
    legacy.close()

    const migrated = openBuddyDatabase({ databasePath })
    expect(migrated.prepare('SELECT * FROM spaces').get()).toEqual({ ...space, icon: 'folder', icon_color: 'default' })
    expect(migrated.prepare('SELECT * FROM space_directory_bindings').all()).toEqual(grants)
    expect(migrated.prepare('SELECT * FROM conversations').all()).toEqual(tasks.map(conversation => ({ ...conversation, buddy_id: 'default', title_source: 'manual', title_revision: 0 })))
    expect(migrated.prepare('SELECT * FROM runs').all()).toEqual(runs.map(run => ({ ...run, buddy_id: 'default', actor_snapshot_json: null, model_override_json: null, root_run_id: run.id, parent_run_id: null, execution_kind: 'root', thread_id: 'actor:["conversation-1","default"]', generation: 0, scheduling_lane: 'conversation' })))
    migrated.exec('UPDATE spaces SET icon = \'code\', icon_color = \'blue\' WHERE id = \'space-1\'')
    migrated.close()

    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(reopened.prepare('SELECT icon, icon_color FROM spaces').get()).toEqual({ icon: 'code', icon_color: 'blue' })
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
  })

  it('requires an explicit database path before opening storage', () => {
    for (const invalid of [undefined, ':memory:', null, [], {}, { buddyHome: '/unused' }, { databasePath: '' }, { databasePath: 'buddy.sqlite3' }]) {
      expect(() => openBuddyDatabase(invalid as unknown as Parameters<typeof openBuddyDatabase>[0]))
        .toThrow(TypeError)
    }
  })

  it('recovers an interrupted v20 migration and preserves legacy draft identities and resources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-task-drafts-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 19))
      legacy.exec(migration.sql)
    legacy.exec(`PRAGMA user_version = 19;
      INSERT INTO composer_drafts VALUES (
        'legacy-draft', 'global', NULL, NULL, NULL, NULL, 7,
        '{"version":1,"body":[{"type":"paragraph","content":[{"type":"text","text":"Keep my draft"}]}],"panelResourceIds":["resource-1"]}',
        NULL, 'policy', 'workspace_write', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'
      );
      INSERT INTO composer_resources (id, draft_id, name, mime_type, size_bytes, state, created_at, updated_at)
      VALUES ('resource-1', 'legacy-draft', 'fixture.txt', 'text/plain', 1, 'importing', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
    `)
    const draft = legacy.prepare('SELECT * FROM composer_drafts').get()
    const resources = legacy.prepare('SELECT * FROM composer_resources').all()
    legacy.close()
    const migration = BUDDY_SCHEMA_MIGRATIONS.find(item => item.version === 20)!
    const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;'); db.exec(process.argv[2]); process.exit(23)`, databasePath, migration.sql], { encoding: 'utf8' })
    expect(interrupted.status).toBe(23)
    const recovered = openBuddyDatabase({ databasePath })
    databases.push(recovered)
    expect(recovered.prepare('SELECT * FROM composer_drafts').get()).toEqual({ ...draft, scope_kind: 'task', participants_json: null })
    expect(recovered.prepare('SELECT * FROM composer_resources').all()).toEqual(resources)
    expect(recovered.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(recovered.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(recovered.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
  }, MIGRATION_TEST_TIMEOUT)

  it('migrates v9 drafts and resources intact and adds independent followup scopes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-tree-schema-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 9)) {
      legacy.exec(migration.sql)
      legacy.exec(`PRAGMA user_version = ${migration.version}`)
    }
    seedRun(legacy)
    legacy.exec(`
      INSERT INTO messages VALUES ('answer-1', 'conversation-1', 'branch-1', 'run-1', 'assistant', '{"text":"answer"}', '2026-09-09T00:00:00.000Z');
      INSERT INTO composer_drafts VALUES (
        'draft-1', 'conversation_branch', NULL, 'conversation-1', 'branch-1', NULL, 7,
        '{"version":1,"body":[],"panelResourceIds":["resource-1"]}', NULL, 'policy', 'workspace_write',
        '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'
      );
      INSERT INTO composer_resources VALUES (
        'resource-1', 'draft-1', 'fixture.txt', 'text/plain', 1, 'importing', NULL, NULL, NULL, NULL,
        '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'
      );
    `)
    const drafts = legacy.prepare('SELECT * FROM composer_drafts').all()
    const resources = legacy.prepare('SELECT * FROM composer_resources').all()
    const messages = legacy.prepare('SELECT * FROM messages').all()
    legacy.close()
    const migrated = openBuddyDatabase({ databasePath })
    databases.push(migrated)
    expect(migrated.prepare('SELECT * FROM composer_drafts').all()).toEqual(drafts.map(draft => ({ ...draft, participants_json: null })))
    expect(migrated.prepare('SELECT * FROM composer_resources').all()).toEqual(resources.map(resource => ({ ...resource, name_source: 'file', source_path: null })))
    expect(migrated.prepare('SELECT * FROM messages').all()).toEqual(messages)
    migrated.exec(`
      INSERT INTO composer_drafts
      SELECT 'followup-1', 'message_followup', space_id, conversation_id, branch_id, 'answer-1', 0,
        content_json, model_selection_json, approval_policy, execution_profile, created_at, updated_at, participants_json
      FROM composer_drafts WHERE id = 'draft-1';
    `)
    expect(migrated.prepare('SELECT COUNT(*) AS count FROM composer_drafts').get()).toEqual({ count: 2 })
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  it('rejects partial or inverted model parameter pairs at the database boundary', () => {
    const database = createDatabase()
    database.exec(`
      INSERT INTO provider_model_states (
        provider_id, model_id, display_name, api, input_json, reasoning, cost_json,
        context_window, max_tokens, override_context_window, override_max_tokens,
        source_revision, acknowledged_source_revision, source, enabled, available,
        last_seen_at, created_at, updated_at
      ) VALUES (
        'anthropic', 'claude', 'Claude', 'anthropic-messages', '["text"]', 0,
        '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}',
        200000, 32000, NULL, NULL, '2026-08-20T00:00:00.000Z', NULL,
        'builtin', 1, 1, '2026-08-20T00:00:00.000Z',
        '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
      );
    `)

    expect(() => database.prepare(`
      UPDATE provider_model_states
      SET override_context_window = ?, override_max_tokens = ?
      WHERE provider_id = 'anthropic' AND model_id = 'claude'
    `).run(100_000, null)).toThrow(/valid pair/)
    expect(() => database.prepare(`
      UPDATE provider_model_states
      SET override_context_window = ?, override_max_tokens = ?
      WHERE provider_id = 'anthropic' AND model_id = 'claude'
    `).run(16_000, 32_000)).toThrow(/valid pair/)

    seedRun(database)
    expect(() => database.prepare(`
      UPDATE runs SET context_window = ?, max_tokens = ? WHERE id = 'run-1'
    `).run(200_000, null)).toThrow(/valid pair/)
  })

  it('restores persisted mutation lifetimes without replaying interrupted changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buddy-mutation-migration-'))
    directories.push(root)
    const databasePath = join(root, 'buddy.sqlite3')
    const previous = openBuddyDatabase({ databasePath })
    seedRun(previous)
    const insert = previous.prepare(`INSERT INTO run_mutation_leases (invocation_id, run_id, segment_id, claims_json, status, created_at, updated_at, lifetime) VALUES (?, 'run-1', 'segment', ?, 'active', 'now', 'now', ?)`)
    for (const id of ['file', 'shell', 'unrecorded'])
      insert.run(id, JSON.stringify([{ kind: 'file', canonicalPath: `/fixture/${id}` }]), id === 'file' ? 'runtime' : 'external')
    previous.exec(`
      INSERT INTO run_change_invocations (id, run_id, segment_id, tool_call_id, tool_name, status, created_at)
      VALUES ('file', 'run-1', 'segment', 'write-call', 'write', 'pending', 'now');
      INSERT INTO run_mutation_processes (invocation_id, process_id, settlement, updated_at)
      VALUES ('shell', 'supervisor', 'pending', 'now');
    `)
    const captures = previous.prepare('SELECT * FROM run_change_invocations').all()
    previous.close()
    const migrated = openBuddyDatabase({ databasePath })
    databases.push(migrated)
    const repository = createMutationRepository(migrated)
    const coordinator = new MutationCoordinator({ repository })
    try {
      expect(repository.listUnreleased().map(lease => lease.invocationId)).toEqual(['shell', 'unrecorded'])
      const signal = new AbortController().signal
      const lease = await coordinator.acquire({ runId: 'new', invocationId: 'new', lifetime: 'runtime' as const, claims: [{ kind: 'file', canonicalPath: '/fixture/file' }], signal })
      lease.release()
      const next = await coordinator.acquire({ runId: 'new', invocationId: 'next', lifetime: 'runtime' as const, claims: [{ kind: 'host' }], signal })
      next.release()
      expect(repository.listUnreleased().map(lease => lease.invocationId)).toEqual(['shell', 'unrecorded'])
      await expect(coordinator.acquire({ runId: 'new', invocationId: 'shell', lifetime: 'external', claims: [{ kind: 'host' }], signal })).rejects.toMatchObject({ code: 'MUTATION_INVOCATION_CONFLICT' })
      expect(migrated.prepare('SELECT * FROM run_change_invocations').all()).toEqual(captures)
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    }
    finally { coordinator.dispose() }
  })

  it('rejects databases created by a newer Buddy version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-schema-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const database = openMigrationFixtureDatabase(databasePath)
    database.exec(`PRAGMA user_version = ${BUDDY_SCHEMA_VERSION + 1}`)
    database.close()

    expect(() => openBuddyDatabase({ databasePath })).toThrow(/newer schema version/i)
  })

  it('rejects an incomplete database that already claims the current schema version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-schema-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const database = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 8)) {
      database.exec(migration.sql)
      database.exec(`PRAGMA user_version = ${migration.version}`)
    }
    database.exec(`PRAGMA user_version = ${BUDDY_SCHEMA_VERSION}`)
    database.close()

    expect(() => openBuddyDatabase({ databasePath })).toThrow(/incomplete schema version/i)
  })

  it('migrates v8 to v9 without interpreting legacy workspace Draft content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-schema-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 8)) {
      legacy.exec(migration.sql)
      legacy.exec(`PRAGMA user_version = ${migration.version}`)
    }
    seedRun(legacy)
    const legacyWorkspace = JSON.stringify({
      activeConversationId: 'conversation-1',
      drafts: [{
        attachments: [{ attachmentId: 'legacy-attachment' }],
        composerContent: {
          attrs: { panelResourceIds: [] },
          content: [{
            content: [{ attrs: { value: '/review' }, type: 'chatPromptToken' }],
            type: 'paragraph',
          }],
          type: 'doc',
        },
        content: '/review',
        draftId: 'legacy-draft',
        targetKey: 'conversation:conversation-1:branch-1',
      }],
      spaceId: 'space-1',
    })
    legacy.prepare(`
      INSERT INTO workspace_settings (key, value_json, updated_at)
      VALUES ('buddy.chat.workspace.v2', ?, '2026-09-06T00:00:00.000Z')
    `).run(legacyWorkspace)
    legacy.close()

    const database = openBuddyDatabase({ databasePath })
    databases.push(database)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({
      user_version: BUDDY_SCHEMA_VERSION,
    })
    expect(database.prepare(`
      SELECT value_json FROM workspace_settings WHERE key = 'buddy.chat.workspace.v2'
    `).get()).toEqual({ value_json: legacyWorkspace })
    expect(database.prepare(`SELECT id FROM messages WHERE id = 'message-1'`).get())
      .toEqual({ id: 'message-1' })
    expect(database.prepare('SELECT * FROM composer_drafts').all()).toEqual([])
    expect(database.prepare('SELECT * FROM composer_resources').all()).toEqual([])
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('migrates controlled profiles and preserves foreign keys in v6', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-schema-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 5)) {
      legacy.exec(migration.sql)
      legacy.exec(`PRAGMA user_version = ${migration.version}`)
    }
    seedRun(legacy, 'personal_and_project')
    legacy.exec(`
      INSERT INTO automations (
        id, name, prompt, space_id, model_mode, provider_id, model_id,
        reasoning, schedule_kind, schedule_json, timezone, active_from,
        active_until, status, blocked_reason, next_run_at, last_run_at,
        deleted_at, revision, created_at, updated_at, execution_profile
      ) VALUES (
        'automation-1', 'Daily review', 'Review', 'space-1', 'default',
        NULL, NULL, NULL, 'once',
        '{"kind":"once","runAt":"2026-09-04T00:00:00.000Z"}',
        'Asia/Shanghai', NULL, NULL, 'blocked', 'AUTOMATION_PROJECT_UNAVAILABLE',
        NULL, NULL, NULL, 1,
        '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z',
        'controlled'
      );

      INSERT INTO workspace_settings (key, value_json, updated_at)
      VALUES (
        'buddy.chat.workspace.v2',
        '{"activeConversationId":null,"drafts":[{"attachments":[],"composerContent":null,"content":"","draftId":"draft-1","executionProfile":"controlled","requestFingerprint":null,"requestId":null,"targetKey":"global"}],"spaceId":null}',
        '2026-09-03T00:00:00.000Z'
      );
    `)
    legacy.close()

    const database = openBuddyDatabase({ databasePath })
    databases.push(database)
    for (const table of ['conversations', 'runs', 'automations']) {
      expect(database.prepare(`SELECT execution_profile FROM ${table} LIMIT 1`).get())
        .toEqual({ execution_profile: 'workspace_write' })
      expect(() => database.prepare(`
        UPDATE ${table} SET execution_profile = 'controlled'
      `).run()).toThrow(/CHECK constraint/)
    }
    for (const table of ['conversations', 'runs']) {
      expect(database.prepare(`SELECT approval_policy FROM ${table} LIMIT 1`).get())
        .toEqual({ approval_policy: 'policy' })
      expect(() => database.prepare(`
        UPDATE ${table} SET approval_policy = 'unknown'
      `).run()).toThrow(/CHECK constraint/)
    }
    expect(database.prepare(`
      SELECT memory_scope FROM spaces WHERE id = 'space-1'
    `).get()).toEqual({ memory_scope: 'personal_and_space' })
    expect(database.prepare(`
      SELECT blocked_reason FROM automations WHERE id = 'automation-1'
    `).get()).toEqual({ blocked_reason: 'AUTOMATION_SPACE_UNAVAILABLE' })
    expect(() => database.prepare(`
      UPDATE spaces SET memory_scope = 'personal_and_project' WHERE id = 'space-1'
    `).run()).toThrow(/CHECK constraint/)
    const workspace = database.prepare(`
      SELECT value_json FROM workspace_settings WHERE key = 'buddy.chat.workspace.v2'
    `).get() as { value_json: string }
    expect(JSON.parse(workspace.value_json)).toMatchObject({
      drafts: [{
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
      }],
    })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('drops exploratory inferred artifacts when adopting explicit output semantics', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-schema-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 4)) {
      legacy.exec(migration.sql)
      legacy.exec(`PRAGMA user_version = ${migration.version}`)
    }
    seedRun(legacy, 'personal_and_project')
    legacy.prepare(`
      INSERT INTO artifacts (
        id, conversation_id, run_id, source_tool_call_id, source_artifact_id,
        stored_path, name, mime_type, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'artifact-legacy',
      'conversation-1',
      'run-1',
      'tool-legacy',
      null,
      '/workspace/legacy.html',
      'legacy.html',
      'text/html',
      17,
      '2026-08-14T00:00:01.000Z',
    )
    legacy.close()

    const database = openBuddyDatabase({ databasePath })
    databases.push(database)
    expect(database.prepare('SELECT * FROM artifacts').all()).toEqual([])
    expect(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_changes'
    `).get()).toBeUndefined()
  })

  it('rejects unversioned application tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-schema-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const database = openMigrationFixtureDatabase(databasePath)
    database.exec('CREATE TABLE spaces (id TEXT PRIMARY KEY)')
    database.close()

    expect(() => openBuddyDatabase({ databasePath })).toThrow(/unversioned schema/i)
  })

  it('enforces Space foreign keys', () => {
    const database = createDatabase()
    const statement = database.prepare(`
      INSERT INTO conversations (
        id, space_id, title, active_branch_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)

    expect(() => statement.run(
      'conversation-1',
      'missing-space',
      null,
      null,
      '2026-08-14T00:00:00.000Z',
      '2026-08-14T00:00:00.000Z',
    )).toThrow(/FOREIGN KEY/)
  })

  it('deduplicates usage by run, source entry, and purpose', () => {
    const database = createDatabase()
    seedRun(database)
    const insert = database.prepare(`
      INSERT INTO usage_records (
        id, run_id, source_entry_id, provider, model, purpose,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, input_cost, output_cost,
        cache_read_cost, cache_write_cost, total_cost, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const values = [
      'usage-1',
      'run-1',
      'pi-entry-1',
      'anthropic',
      'claude-sonnet-4-5',
      'turn',
      10,
      5,
      2,
      1,
      null,
      18,
      0.1,
      0.2,
      0.01,
      0.02,
      0.33,
      '2026-08-14T00:00:01.000Z',
    ] as const

    insert.run(...values)
    expect(() => insert.run('usage-2', ...values.slice(1))).toThrow(/UNIQUE/)
  })
})

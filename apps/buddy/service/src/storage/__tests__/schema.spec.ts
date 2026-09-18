import type { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

import { createComposerResourceRepository } from '../composerResourceRepository'
import { openBuddyDatabase } from '../database'
import { BUDDY_V15_CAPABILITY_OVERRIDES_SCHEMA_SQL, BUDDY_V15_CATALOG_MODEL_ID_SCHEMA_SQL, BUDDY_V15_CATALOG_SELECTION_SCHEMA_SQL, BUDDY_V15_MODEL_SERVICES_SCHEMA_SQL, BUDDY_V15_PROVIDER_INSTANCES_SCHEMA_SQL, BUDDY_V15_REQUEST_HEADERS_SCHEMA_SQL } from '../migrations/v15ModelServices'
import { BUDDY_SCHEMA_MIGRATIONS, BUDDY_SCHEMA_VERSION } from '../schema'
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
  it('upgrades v16 to skills storage without changing conversations or run history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-skills-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 16))
      previous.exec(migration.sql)
    previous.exec('PRAGMA user_version = 16')
    seedRun(previous)
    const runs = previous.prepare('SELECT * FROM runs').all()
    const conversations = previous.prepare('SELECT * FROM conversations').all()
    previous.close()
    const upgraded = openBuddyDatabase({ databasePath })
    databases.push(upgraded)
    expect(upgraded.prepare('SELECT * FROM runs').all()).toEqual(runs)
    expect(upgraded.prepare('SELECT * FROM conversations').all()).toEqual(conversations)
    expect(upgraded.prepare('SELECT * FROM skill_installations').all()).toEqual([])
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
    legacy.prepare('INSERT INTO provider_states VALUES (?, ?, ?, ?)').run('proxy', 1, now, now)
    legacy.prepare(`INSERT INTO provider_configs (id, display_name, api, base_url, models_json, credential_ref, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('proxy', 'Proxy', 'openai-completions', 'https://models.example.test/v1', '[]', 'proxy', 1, now, now)
    const states = legacy.prepare('SELECT * FROM provider_states ORDER BY provider_id').all()
    const configs = legacy.prepare('SELECT * FROM provider_configs').all()
    const runs = legacy.prepare('SELECT * FROM runs').all()
    legacy.close()

    const upgraded = openBuddyDatabase({ databasePath })
    expect(upgraded.prepare('SELECT * FROM provider_states ORDER BY provider_id').all()).toEqual(states.map(state => ({ ...state, request_headers_json: '[]' })))
    expect(upgraded.prepare('SELECT * FROM provider_configs').all()).toEqual(configs)
    expect(upgraded.prepare('SELECT * FROM runs').all()).toEqual(runs)
    expect(upgraded.prepare('SELECT id, builtin_provider_id, display_name FROM builtin_provider_configs').all()).toEqual([
      { id: 'anthropic', builtin_provider_id: 'anthropic', display_name: null },
    ])
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect((upgraded.prepare('PRAGMA table_info(provider_model_states)').all() as Array<{ name: string }>).map(column => column.name))
      .toEqual(expect.arrayContaining(['catalog_model_id', 'catalog_selection_json', 'capability_overrides_json']))
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
    expect(migrated.prepare('SELECT * FROM conversations').all()).toEqual(tasks)
    expect(migrated.prepare('SELECT * FROM runs').all()).toEqual(runs)
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
    expect(recovered.prepare('SELECT * FROM composer_drafts').get()).toEqual({ ...draft, scope_kind: 'task' })
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
    expect(migrated.prepare('SELECT * FROM composer_drafts').all()).toEqual(drafts)
    expect(migrated.prepare('SELECT * FROM composer_resources').all()).toEqual(resources.map(resource => ({ ...resource, name_source: 'file', source_path: null })))
    expect(migrated.prepare('SELECT * FROM messages').all()).toEqual(messages)
    migrated.exec(`
      INSERT INTO composer_drafts
      SELECT 'followup-1', 'message_followup', space_id, conversation_id, branch_id, 'answer-1', 0,
        content_json, model_selection_json, approval_policy, execution_profile, created_at, updated_at
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

  it('adds model catalog metadata without changing existing model state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-model-catalog-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 14)) {
      legacy.exec(migration.sql)
      legacy.exec(`PRAGMA user_version = ${migration.version}`)
    }
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
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z',
        '2026-09-12T00:00:00.000Z'
      );
    `)
    legacy.close()

    const migrated = openBuddyDatabase({ databasePath })
    databases.push(migrated)
    expect(migrated.prepare(`
      SELECT provider_id, model_id, display_name, context_window, max_tokens,
        override_context_window, override_max_tokens, source, enabled, available,
        thinking_level_map_json, sampling_params_json, compat_json,
        catalog_provider_id, source_fingerprint
      FROM provider_model_states
    `).get()).toEqual({
      available: 1,
      catalog_provider_id: null,
      compat_json: null,
      context_window: 128000,
      display_name: 'Model 1',
      enabled: 1,
      max_tokens: 16384,
      model_id: 'model-1',
      override_context_window: 96000,
      override_max_tokens: 12000,
      provider_id: 'proxy',
      sampling_params_json: null,
      source: 'synced',
      source_fingerprint: '',
      thinking_level_map_json: null,
    })
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({
      user_version: BUDDY_SCHEMA_VERSION,
    })
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
    const usage = createUsageRepository(database)
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
    expect(usage.listForRun('run-1')).toHaveLength(1)
    expect(usage.findBySource('run-1', 'pi-entry-1', 'turn')).toMatchObject({
      id: 'usage-1',
      runId: 'run-1',
      sourceEntryId: 'pi-entry-1',
    })
    expect(usage.summarize()).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      recordCount: 1,
      totalCost: 0.33,
      totalTokens: 18,
    })
  })
})

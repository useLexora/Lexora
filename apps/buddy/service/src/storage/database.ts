import type { DatabaseSync } from 'node:sqlite'
import type { BuddySchemaMigration } from './schema'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import { CONTENT_REFERENCE_OWNERSHIP_TRIGGER_NAMES } from './migrations/contentReferenceOwnershipSchema'
import { MANAGED_FILES_INDEX_NAMES, MANAGED_FILES_TRIGGER_NAMES } from './migrations/managedFilesSchema'
import { PRIVATE_NETWORK_TABLE_COLUMNS, PRIVATE_NETWORK_TRIGGER_NAMES } from './migrations/privateNetworkSchema'
import { PRODUCT_CONTENT_REFERENCES_TRIGGER_NAMES } from './migrations/productContentReferencesSchema'
import { SCOPED_QUERY_REVISION_SOURCES, SCOPED_QUERY_REVISION_TRIGGER_NAMES } from './migrations/productQueryRevisionsSchema'
import { REMOTE_FILES_INDEX_NAMES, REMOTE_FILES_TABLE_COLUMNS, REMOTE_FILES_TRIGGER_NAMES } from './migrations/remoteFilesSchema'
import { RESOURCE_EXPORT_INDEX_NAMES, RESOURCE_EXPORT_TABLE_COLUMNS, RESOURCE_EXPORT_TRIGGER_NAMES } from './migrations/resourceExportsSchema'
import { BUDDY_V15_CAPABILITY_OVERRIDES_SCHEMA_SQL, BUDDY_V15_CATALOG_MODEL_ID_SCHEMA_SQL, BUDDY_V15_CATALOG_SELECTION_SCHEMA_SQL, BUDDY_V15_PROVIDER_INSTANCES_SCHEMA_SQL, BUDDY_V15_REQUEST_HEADERS_SCHEMA_SQL } from './migrations/v15ModelServices'
import { BUDDY_RUN_EVENT_CHECKPOINT_TRIGGER_NAMES } from './migrations/v24RunEventCheckpoints'
import { BUDDY_PROVIDER_RESOLUTION_TRIGGER_NAMES } from './migrations/v39ProviderResolution'
import { BUDDY_EVENT_MAINTENANCE_TRIGGER_NAMES } from './migrations/v40EventMaintenance'
import { BUDDY_ARCHIVE_TRIGGER_NAMES, BUDDY_SCHEMA_LINEAGE } from './migrations/v42ConversationArchive'
import { BUDDY_PERSISTENCE_SCHEMA_LINEAGE } from './migrations/v43Persistence'

import {
  BUDDY_MIGRATION_SCHEMA_VERSION,
  BUDDY_SCHEMA_MIGRATIONS,
  BUDDY_SCHEMA_VERSION,
  BUDDY_STORAGE_WRITER_VERSION,
} from './schema'
import { requireSqliteAuthority } from './sqliteAuthority'
import { withTransaction } from './transaction'

export const BUDDY_DATABASE_FILE_NAME = 'buddy.sqlite3'

export interface OpenBuddyDatabaseOptions {
  databasePath: string
}

const BUDDY_CURRENT_SCHEMA_COLUMNS = {
  user_questions: ['id', 'run_id', 'tool_call_id', 'request_json'],
  automations: ['actor_id'],
  automation_occurrences: ['actor_snapshot_json'],
  runs: ['scheduling_lane', 'buddy_id', 'actor_snapshot_json', 'model_override_json', 'root_run_id', 'parent_run_id', 'execution_kind', 'thread_id', 'generation'],
  execution_work_attempts: ['run_id', 'work_id', 'previous_run_id', 'context_mode', 'context_source_ids_json', 'brief_json', 'submission_json', 'review_json'],
  execution_state: ['run_id', 'phase', 'phase_version', 'request_key', 'request_hash', 'admitted_root_generation', 'admitted_parent_generation', 'result_mailbox_id', 'cancel_requested_at', 'cleanup_state', 'file_access_ceiling'],
  run_change_invocations: ['sequence', 'id', 'run_id', 'segment_id', 'tool_call_id', 'tool_name', 'status'],
  run_file_change_captures: ['invocation_id'],
  run_mutation_leases: ['lifetime', 'invocation_id', 'run_id', 'segment_id', 'claims_json', 'status', 'reason', 'created_at', 'updated_at'],
  run_mutation_processes: ['invocation_id', 'process_id', 'settlement', 'updated_at'],
  run_mutation_evidence: ['sequence', 'invocation_id', 'kind', 'outcome', 'reason', 'actor', 'process_id', 'related_run_id', 'created_at'],
  run_mutation_executions: ['execution_id', 'invocation_id', 'dispatch_id', 'launch_state', 'created_at', 'updated_at'],
  conversation_public_heads: ['conversation_id', 'sequence'],
  conversation_publications: ['source_id', 'conversation_id', 'branch_id', 'sequence', 'kind', 'message_id', 'run_id', 'source_sequence', 'author_actor_id'],
  run_public_snapshots: ['run_id', 'public_sequence'],
  run_session_reference_scopes: ['run_id', 'public_sequence', 'graph_json'],
  session_reference_exclusions: ['conversation_id', 'branch_id', 'session_id', 'created_at'],
  actor_public_cursors: ['thread_id', 'branch_id', 'public_sequence', 'context_entry_id'],
  execution_threads: ['id', 'conversation_id', 'actor_id', 'kind'],
  execution_thread_bindings: ['thread_id', 'session_file', 'root_entry_id'],
  execution_mailbox_sources: ['id', 'source_run_id', 'source_sequence', 'target_run_id', 'target_generation', 'payload_json', 'payload_hash'],
  execution_mailbox_receipts: ['mailbox_id', 'target_run_id', 'target_sequence', 'source_run_id', 'payload_hash', 'kind', 'context_entry_id'],
  buddies: ['enabled', 'settings_json', 'id', 'kind', 'name', 'avatar', 'custom_avatars_json', 'description', 'deleted_at', 'revision', 'created_at', 'updated_at'],
  buddy_catalog: ['id', 'default_buddy_id', 'revision'],
  conversation_members: ['conversation_id', 'actor_id', 'model_selection_json', 'model_selection_source', 'joined_at', 'removed_at'],
  mcp_servers: ['tool_namespace', 'tool_exposure'],
  extension_capabilities: ['id', 'extension_id', 'kind', 'contribution_id', 'revision', 'definition_json', 'state', 'user_enabled', 'credential_target'],
  run_event_checkpoints: ['run_id', 'last_sequence', 'projection_version', 'file_fingerprint'],
  run_event_maintenance: ['run_id', 'recovery_pending', 'compaction_pending', 'projection_version', 'compaction_version', 'revision'],
  provider_resolution_checkpoints: ['provider_id', 'input_fingerprint'],
  extension_invocations: ['id', 'extension_id', 'action_id', 'conversation_id', 'trigger', 'status', 'branch_id', 'source_message_id', 'extension_name', 'action_title', 'result_message'],
  usage_records: ['run_id', 'invocation_id', 'detached'],
  conversations: ['buddy_id', 'title_source', 'title_revision', 'metadata_revision', 'archived_at'],
  conversation_archive_policy: ['id', 'days'],
  conversation_deletion_jobs: ['conversation_id', 'status', 'origin', 'error_code', 'manifest_json', 'created_at', 'updated_at'],
  connector_tool_catalogs: ['connector_id', 'tools_json', 'updated_at'],
  provider_states: ['provider_id', 'request_headers_json'],
  builtin_provider_configs: ['id', 'builtin_provider_id', 'display_name'],
  chat_queue: ['id', 'conversation_id', 'branch_id', 'prepared_json', 'state'],
  command_requests: ['draft_id', 'draft_revision', 'committed_draft_revision'],
  composer_drafts: [
    'participants_json',
    'id',
    'scope_kind',
    'source_message_id',
    'revision',
    'content_json',
    'model_selection_json',
    'approval_policy',
    'execution_profile',
  ],
  composer_resources: [
    'id',
    'draft_id',
    'state',
    'attachment_id',
    'content_hash',
    'source_json',
    'error_code',
  ],
  conversation_pi_trees: ['conversation_id', 'session_file', 'root_entry_id'],
  provider_model_states: [
    'model_type',
    'type_override',
    'thinking_level_map_json',
    'sampling_params_json',
    'compat_json',
    'catalog_provider_id',
    'catalog_model_id',
    'catalog_selection_json',
    'capability_overrides_json',
    'service_metadata_json',
    'source_fingerprint',
    'resolution_json',
  ],
  run_tree_sources: ['run_id', 'source_run_id', 'position'],
  spaces: ['icon', 'icon_color'],
  skill_installations: ['id', 'name', 'scope_key', 'space_id', 'managed_by', 'path', 'enabled', 'origin_json', 'revision'],
  skill_space_exclusions: ['skill_id', 'space_id'],
  skill_file_cleanup: ['path', 'space_id', 'installation_id'],
  task_marks: ['id', 'name', 'description', 'color'],
  task_attention: ['conversation_id', 'mark_id', 'seen_run_id', 'forced_unread', 'read_revision'],
  turn_requests: ['draft_id', 'draft_revision', 'committed_draft_revision'],
} as const

export function resolveBuddyDatabasePath(buddyHome: string): string {
  return join(buddyHome, BUDDY_DATABASE_FILE_NAME)
}

export function openBuddyDatabase(options: OpenBuddyDatabaseOptions): DatabaseSync {
  return openDatabase(options, BUDDY_SCHEMA_VERSION, 'NORMAL')
}

export function openBuddyMigrationCandidate(options: OpenBuddyDatabaseOptions): DatabaseSync {
  return openDatabase(options, BUDDY_MIGRATION_SCHEMA_VERSION, 'FULL')
}

export function openBuddySqliteDatabase(options: OpenBuddyDatabaseOptions): DatabaseSync {
  return openDatabase(options, BUDDY_MIGRATION_SCHEMA_VERSION, 'FULL', true)
}

function validateDatabaseOptions(options: OpenBuddyDatabaseOptions): string {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Buddy database options must be an object')
  const { databasePath } = options
  if (typeof databasePath !== 'string' || (databasePath !== ':memory:' && !isAbsolute(databasePath)))
    throw new TypeError('Buddy database requires an explicit absolute path or :memory:')
  return databasePath
}

function openDatabase(options: OpenBuddyDatabaseOptions, targetVersion: number, synchronous: 'NORMAL' | 'FULL', sqliteAuthority = false): DatabaseSync {
  const databasePath = validateDatabaseOptions(options)
  if (databasePath !== ':memory:' && existsSync(databasePath)) {
    const existing = new NodeDatabaseSync(databasePath, { readOnly: true })
    try {
      validateDatabaseVersion(existing, targetVersion, sqliteAuthority)
    }
    catch (error) {
      if (!(error instanceof Error) || !('errcode' in error) || error.errcode !== 776)
        throw error
      validateRecoverableDatabase(databasePath, targetVersion, sqliteAuthority)
    }
    finally { existing.close() }
  }
  if (databasePath !== ':memory:')
    mkdirSync(dirname(databasePath), { mode: 0o700, recursive: true })

  const database = new NodeDatabaseSync(databasePath)
  try {
    const currentVersion = validateDatabaseVersion(database, targetVersion, sqliteAuthority)
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = ${synchronous};
      PRAGMA busy_timeout = 5000;
    `)
    if (synchronous === 'FULL')
      database.exec('PRAGMA wal_autocheckpoint = 1000')
    if (sqliteAuthority && currentVersion === 0) {
      database.exec('PRAGMA foreign_keys = OFF')
      try {
        withTransaction(database, () => {
          migrateBuddyDatabase(database, currentVersion, targetVersion)
          database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\' WHERE id = 1')
          requireSqliteAuthority(database)
        })
      }
      finally { database.exec('PRAGMA foreign_keys = ON') }
    }
    else {
      migrateBuddyDatabase(database, currentVersion, targetVersion)
    }
    return database
  }
  catch (error) {
    if (database.isOpen)
      database.close()
    throw error
  }
}

function validateRecoverableDatabase(databasePath: string, targetVersion: number, sqliteAuthority: boolean): void {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-sqlite-preflight-'))
  try {
    const copy = join(directory, BUDDY_DATABASE_FILE_NAME)
    copyFileSync(databasePath, copy)
    copyFileSync(`${databasePath}-journal`, `${copy}-journal`)
    if (existsSync(`${databasePath}-wal`))
      copyFileSync(`${databasePath}-wal`, `${copy}-wal`)
    const recovered = new NodeDatabaseSync(copy)
    try {
      validateDatabaseVersion(recovered, targetVersion, sqliteAuthority)
    }
    finally { recovered.close() }
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

function validateDatabaseVersion(database: DatabaseSync, targetVersion: number, sqliteAuthority: boolean): number {
  const currentVersion = readSchemaVersion(database)
  if (currentVersion >= 42 && currentVersion <= BUDDY_MIGRATION_SCHEMA_VERSION)
    assertSchemaLineage(database, currentVersion === 42 ? BUDDY_SCHEMA_LINEAGE : BUDDY_PERSISTENCE_SCHEMA_LINEAGE)
  if (currentVersion > targetVersion)
    throw new BuddyDatabaseVersionError('newer schema version')
  if (currentVersion === 0 && hasApplicationTables(database))
    throw new BuddyDatabaseVersionError('unversioned schema')
  if (currentVersion >= 42)
    assertCurrentSchema(database)
  if (currentVersion >= 43)
    assertMigrationSchema(database)
  if (sqliteAuthority && currentVersion !== 0) {
    if (currentVersion < 43)
      throw new BuddyDatabaseVersionError('explicit persistence migration required')
    requireSqliteAuthority(database)
  }
  return currentVersion
}

function migrateBuddyDatabase(database: DatabaseSync, currentVersion: number, targetVersion: number): void {
  if (currentVersion === 15)
    completeModelServicesMigration(database)
  for (const migration of BUDDY_SCHEMA_MIGRATIONS) {
    if (migration.version <= currentVersion || migration.version > targetVersion)
      continue
    applyMigration(database, migration)
  }
  assertSchemaLineage(database, targetVersion === 42 ? BUDDY_SCHEMA_LINEAGE : BUDDY_PERSISTENCE_SCHEMA_LINEAGE)
  assertCurrentSchema(database)
  if (targetVersion >= BUDDY_MIGRATION_SCHEMA_VERSION) {
    assertMigrationSchema(database)
    assertForeignKeysIntact(database)
  }
}

function assertMigrationSchema(database: DatabaseSync): void {
  const tables: Record<string, readonly string[]> = {
    storage_profile: ['id', 'data_generation', 'local_actor_id', 'min_writer_version', 'authority', 'migration_state'],
    storage_actors: ['id', 'kind', 'state', 'created_at'],
    command_receipts: ['data_generation', 'actor_id', 'command_id', 'method', 'fingerprint_version', 'fingerprint', 'source_instance_id', 'decision', 'target_json', 'result_json', 'error_code', 'decided_at'],
    runs: ['next_event_sequence'],
    run_events: ['format_version'],
    product_content_references: ['id', 'owner_actor_id', 'data_generation', 'quote_json', 'created_at'],
    product_content_reference_owners: ['reference_id', 'owner_kind', 'owner_id'],
    approval_reviews: ['approval_id', 'review_json'],
    approval_decisions: ['approval_id', 'resolution', 'actor_id', 'cancellation_reason', 'decided_at'],
    conversations: ['metadata_revision'],
    task_attention: ['assignment_revision'],
    task_marks: ['revision'],
    composer_drafts: ['owner_actor_id'],
    composer_draft_slots: ['owner_actor_id', 'scope_key', 'draft_id', 'slot_revision'],
    chat_queue: ['revision'],
    chat_queue_deliveries: ['queue_id', 'run_id', 'stage', 'committed_at', 'observed_at'],
    service_admission_gates: ['source_instance_id', 'stopped_at', 'command_id'],
    persistence_migrations: ['id', 'source_fingerprint', 'source_schema', 'state', 'created_at'],
    persistence_migration_entries: ['migration_id', 'kind', 'source_id', 'source_fingerprint', 'evidence_json'],
    legacy_request_aliases: ['namespace', 'request_id', 'target_json', 'source_fingerprint'],
    managed_files: ['id', 'path', 'temporary_path', 'size_bytes', 'sha256', 'state', 'durability'],
    file_preparations: ['id', 'data_generation', 'actor_id', 'state'],
    file_references: ['file_id', 'kind', 'owner_id', 'binding_id'],
    ...PRIVATE_NETWORK_TABLE_COLUMNS,
    ...REMOTE_FILES_TABLE_COLUMNS,
    ...RESOURCE_EXPORT_TABLE_COLUMNS,
    product_query_revisions: ['table_name', 'scope', 'revision'],
  }
  const protections = [
    'command_receipts_no_replace',
    'command_receipts_no_update',
    'command_receipts_no_delete',
    'runs_event_sequence_monotonic',
    ...MANAGED_FILES_TRIGGER_NAMES,
    ...PRODUCT_CONTENT_REFERENCES_TRIGGER_NAMES,
    'task_attention_assignment_revision',
    'task_attention_assignment_insert',
    'task_marks_revision',
    'approval_reviews_immutable',
    'approval_decisions_immutable',
    'chat_queue_revision',
    'runs_new_event_sequence',
    'composer_drafts_default_owner',
    'composer_drafts_owner_immutable',
    'composer_drafts_release_slot',
    'composer_draft_slots_owner_insert',
    'composer_draft_slots_owner_update',
    'composer_draft_slots_revision',
    ...CONTENT_REFERENCE_OWNERSHIP_TRIGGER_NAMES,
    ...PRIVATE_NETWORK_TRIGGER_NAMES,
    ...REMOTE_FILES_TRIGGER_NAMES,
    ...RESOURCE_EXPORT_TRIGGER_NAMES,
    ...SCOPED_QUERY_REVISION_TRIGGER_NAMES,
  ]
  const indexes = ['storage_actors_desktop', 'composer_drafts_owner', ...MANAGED_FILES_INDEX_NAMES, ...REMOTE_FILES_INDEX_NAMES, ...RESOURCE_EXPORT_INDEX_NAMES]
  for (const [table, required] of Object.entries(tables)) {
    const columns = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name))
    if (required.some(column => !columns.has(column)))
      throw new BuddyDatabaseVersionError('incomplete schema version')
  }
  const findRevision = database.prepare('SELECT 1 FROM product_query_revisions WHERE table_name = ? AND scope = \'\'')
  if (SCOPED_QUERY_REVISION_SOURCES.some(table => !findRevision.get(table)))
    throw new BuddyDatabaseVersionError('incomplete query revisions')
  const profile = database.prepare('SELECT min_writer_version, local_actor_id FROM storage_profile WHERE id = 1').get() as { min_writer_version: number, local_actor_id: string } | undefined
  if (!profile || !database.prepare('SELECT 1 FROM storage_actors WHERE id = ? AND kind = \'desktop\'').get(profile.local_actor_id))
    throw new BuddyDatabaseVersionError('incomplete storage identity')
  if (profile.min_writer_version > BUDDY_STORAGE_WRITER_VERSION)
    throw new BuddyDatabaseVersionError('newer storage writer version')
  const findTrigger = database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'trigger\' AND name = ?')
  const findIndex = database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND name = ?')
  if (indexes.some(name => !findIndex.get(name)) || protections.some(name => !findTrigger.get(name)))
    throw new BuddyDatabaseVersionError('incomplete storage constraints')
}

function completeModelServicesMigration(database: DatabaseSync): void {
  const hasHeaders = (database.prepare('PRAGMA table_info(provider_states)').all() as Array<{ name: string }>).some(column => column.name === 'request_headers_json')
  const hasInstances = Boolean(database.prepare(
    'SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'builtin_provider_configs\'',
  ).get())
  const columns = new Set((database.prepare('PRAGMA table_info(provider_model_states)').all() as Array<{ name: string }>).map(column => column.name))
  const additions = [
    ['catalog_model_id', BUDDY_V15_CATALOG_MODEL_ID_SCHEMA_SQL],
    ['catalog_selection_json', BUDDY_V15_CATALOG_SELECTION_SCHEMA_SQL],
    ['capability_overrides_json', BUDDY_V15_CAPABILITY_OVERRIDES_SCHEMA_SQL],
  ] as const
  const missing = additions.filter(([column]) => !columns.has(column))
  if (hasInstances && hasHeaders && !missing.length)
    return
  withTransaction(database, () => {
    if (!hasInstances)
      database.exec(BUDDY_V15_PROVIDER_INSTANCES_SCHEMA_SQL)
    if (!hasHeaders)
      database.exec(BUDDY_V15_REQUEST_HEADERS_SCHEMA_SQL)
    for (const [, sql] of missing)
      database.exec(sql)
  })
}

function assertSchemaLineage(database: DatabaseSync, expectedLineage: string): void {
  const columns = database.prepare('PRAGMA table_info(buddy_schema_lineage)').all() as Array<{ name: string }>
  if (!['id', 'lineage'].every(name => columns.some(column => column.name === name)))
    throw new BuddyDatabaseVersionError('incompatible schema lineage')
  const rows = database.prepare('SELECT id, lineage FROM buddy_schema_lineage').all()
  if (rows.length !== 1 || rows[0]!.id !== 1 || rows[0]!.lineage !== expectedLineage)
    throw new BuddyDatabaseVersionError('incompatible schema lineage')
}

function assertCurrentSchema(database: DatabaseSync): void {
  for (const [table, requiredColumns] of Object.entries(BUDDY_CURRENT_SCHEMA_COLUMNS)) {
    const columns = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
    }>).map(column => column.name))
    if (requiredColumns.some(column => !columns.has(column)))
      throw new BuddyDatabaseVersionError('incomplete schema version')
  }
  const triggers = new Set((database.prepare('SELECT name FROM sqlite_master WHERE type = \'trigger\'').all() as Array<{ name: string }>).map(row => row.name))
  if ([...BUDDY_RUN_EVENT_CHECKPOINT_TRIGGER_NAMES, ...BUDDY_PROVIDER_RESOLUTION_TRIGGER_NAMES, ...BUDDY_EVENT_MAINTENANCE_TRIGGER_NAMES, ...BUDDY_ARCHIVE_TRIGGER_NAMES].some(name => !triggers.has(name)))
    throw new BuddyDatabaseVersionError('incomplete checkpoint invalidation schema')
}

function applyMigration(database: DatabaseSync, migration: BuddySchemaMigration): void {
  const suspendForeignKeys = migration.foreignKeys === 'off'
  if (suspendForeignKeys)
    database.exec('PRAGMA foreign_keys = OFF')
  try {
    withTransaction(database, () => {
      database.exec(migration.sql)
      if (migration.version === 43) {
        assertSchemaLineage(database, BUDDY_PERSISTENCE_SCHEMA_LINEAGE)
        assertCurrentSchema(database)
        assertMigrationSchema(database)
        assertForeignKeysIntact(database)
      }
      if (suspendForeignKeys)
        assertForeignKeysIntact(database)
      database.exec(`PRAGMA user_version = ${migration.version}`)
    })
  }
  finally {
    if (suspendForeignKeys)
      database.exec('PRAGMA foreign_keys = ON')
  }
}

function assertForeignKeysIntact(database: DatabaseSync): void {
  const violations = database.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0)
    throw new BuddyDatabaseVersionError('inconsistent schema after migration')
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

function hasApplicationTables(database: DatabaseSync): boolean {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get() as { count: number }
  return row.count > 0
}

export class BuddyDatabaseVersionError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`Lexora Buddy database uses an ${reason}`)
    this.name = 'BuddyDatabaseVersionError'
    this.reason = reason
  }
}

export { withTransaction } from './transaction'

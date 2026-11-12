import type { DatabaseSync } from 'node:sqlite'
import type { BuddySchemaMigration } from './schema'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import { isAsyncFunction } from 'node:util/types'
import { BUDDY_V15_CAPABILITY_OVERRIDES_SCHEMA_SQL, BUDDY_V15_CATALOG_MODEL_ID_SCHEMA_SQL, BUDDY_V15_CATALOG_SELECTION_SCHEMA_SQL, BUDDY_V15_PROVIDER_INSTANCES_SCHEMA_SQL, BUDDY_V15_REQUEST_HEADERS_SCHEMA_SQL } from './migrations/v15ModelServices'
import { BUDDY_RUN_EVENT_CHECKPOINT_TRIGGER_NAMES } from './migrations/v24RunEventCheckpoints'
import { BUDDY_PROVIDER_RESOLUTION_TRIGGER_NAMES } from './migrations/v39ProviderResolution'
import { BUDDY_EVENT_MAINTENANCE_TRIGGER_NAMES } from './migrations/v40EventMaintenance'
import { BUDDY_ARCHIVE_TRIGGER_NAMES, BUDDY_SCHEMA_LINEAGE } from './migrations/v42ConversationArchive'

import {
  BUDDY_SCHEMA_MIGRATIONS,
  BUDDY_SCHEMA_VERSION,
} from './schema'

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
  conversations: ['buddy_id', 'title_source', 'title_revision', 'archived_at', 'metadata_revision'],
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
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Buddy database options must be an object')
  const { databasePath } = options
  if (typeof databasePath !== 'string' || (databasePath !== ':memory:' && !isAbsolute(databasePath)))
    throw new TypeError('Buddy database requires an explicit absolute path or :memory:')
  if (databasePath !== ':memory:' && existsSync(databasePath)) {
    const existing = new NodeDatabaseSync(databasePath, { readOnly: true })
    try {
      validateDatabaseVersion(existing)
    }
    finally { existing.close() }
  }
  if (databasePath !== ':memory:')
    mkdirSync(dirname(databasePath), { mode: 0o700, recursive: true })

  const database = new NodeDatabaseSync(databasePath)
  try {
    const currentVersion = validateDatabaseVersion(database)
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `)
    migrateBuddyDatabase(database, currentVersion)
    return database
  }
  catch (error) {
    if (database.isOpen)
      database.close()
    throw error
  }
}

function validateDatabaseVersion(database: DatabaseSync): number {
  const currentVersion = readSchemaVersion(database)
  if (currentVersion > BUDDY_SCHEMA_VERSION)
    throw new BuddyDatabaseVersionError('newer schema version')
  if (currentVersion === 0 && hasApplicationTables(database))
    throw new BuddyDatabaseVersionError('unversioned schema')
  if (currentVersion === 42)
    assertCurrentSchema(database)
  return currentVersion
}

function migrateBuddyDatabase(database: DatabaseSync, currentVersion: number): void {
  if (currentVersion === 15)
    completeModelServicesMigration(database)
  for (const migration of BUDDY_SCHEMA_MIGRATIONS) {
    if (migration.version <= currentVersion)
      continue
    applyMigration(database, migration)
  }
  assertCurrentSchema(database)
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

function assertCurrentSchema(database: DatabaseSync): void {
  const lineageColumns = database.prepare('PRAGMA table_info(buddy_schema_lineage)').all()
  if (!['id', 'lineage'].every(name => lineageColumns.some(column => column.name === name)))
    throw new BuddyDatabaseVersionError('incompatible schema lineage')
  const lineage = database.prepare('SELECT id, lineage FROM buddy_schema_lineage').all()
  if (lineage.length !== 1 || lineage[0]!.id !== 1 || lineage[0]!.lineage !== BUDDY_SCHEMA_LINEAGE)
    throw new BuddyDatabaseVersionError('incompatible schema lineage')
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

interface TransactionContext {
  failure: { error: unknown } | null
  asynchronousResult: boolean
}

const transactions = new WeakMap<DatabaseSync, TransactionContext>()
const blockedConnections = new WeakMap<DatabaseSync, Error>()

export class BuddyTransactionUncertainError extends Error {
  readonly code = 'STORAGE_TRANSACTION_UNCERTAIN'

  constructor(cause: unknown) {
    super('Storage transaction outcome requires verification on a new connection', { cause })
    this.name = 'BuddyTransactionUncertainError'
  }
}

export function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  const blocked = blockedConnections.get(database)
  if (blocked)
    throw blocked
  const active = transactions.get(database)
  if (active)
    return participateInTransaction(database, active, operation)
  if (database.isTransaction)
    throw new Error('Storage transaction must be owned by withTransaction')

  const context: TransactionContext = { failure: null, asynchronousResult: false }
  let phase: 'begin' | 'operation' | 'commit' = 'begin'
  try {
    database.exec('BEGIN IMMEDIATE')
    transactions.set(database, context)
    phase = 'operation'
    const result = participateInTransaction(database, context, operation)
    if (context.failure)
      throw context.failure.error
    phase = 'commit'
    database.exec('COMMIT')
    if (database.isTransaction)
      throw new Error('Storage transaction remains active after commit')
    return result
  }
  catch (error) {
    const blocked = blockedConnections.get(database)
    if (blocked)
      throw blocked
    const original = context.failure ? context.failure.error : error
    try {
      if (database.isTransaction) {
        database.exec('ROLLBACK')
        if (database.isTransaction)
          throw new Error('Storage transaction remains active after rollback')
      }
      else if (phase !== 'begin') {
        throw original
      }
    }
    catch (cleanupError) {
      throw blockConnection(database, new BuddyTransactionUncertainError(new AggregateError([original, cleanupError], 'Storage transaction could not be rolled back reliably')))
    }
    if (context.asynchronousResult)
      blockConnection(database, new TypeError('Storage transactions cannot return a promise'))
    throw original
  }
  finally {
    transactions.delete(database)
  }
}

function participateInTransaction<T>(database: DatabaseSync, context: TransactionContext, operation: () => T): T {
  if (context.failure)
    throw context.failure.error
  try {
    if (isAsyncFunction(operation))
      throw new TypeError('Storage transactions require synchronous operations')
    const result = operation()
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
      context.asynchronousResult = true
      void Promise.resolve(result).catch(() => {})
      throw new TypeError('Storage transactions cannot return a promise')
    }
    if (!database.isTransaction)
      throw new Error('Storage transaction ended outside withTransaction')
    return result
  }
  catch (error) {
    context.failure ??= { error }
    if (!database.isOpen || !database.isTransaction)
      throw blockConnection(database, new BuddyTransactionUncertainError(error))
    throw error
  }
}

function blockConnection(database: DatabaseSync, error: Error): Error {
  blockedConnections.set(database, error)
  try {
    if (database.isOpen)
      database.close()
  }
  catch {}
  return error
}

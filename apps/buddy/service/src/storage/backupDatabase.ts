import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { BackupScope } from '../../../shared/storage/backupScope'
import { storageError } from '../../../platform/storage/storageFiles'
import { backupCapabilityOwners, backupMergeColumns, backupTables, backupTableScopes, databaseRowScope, persistenceIdentityTables } from './backupDatabasePolicy'
import { reconcileRestoredTaskState } from './restoreTaskState'

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
function columns(database: DatabaseSync, table: string) {
  return database.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string, pk: number }[]
}
export function selectBackupDatabase(database: DatabaseSync, scopes: readonly BackupScope[], paths: readonly string[] = []): void {
  assertIsolatedPersistenceConstruction(database)
  const tables = database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\'').all().map(row => String(row.name))
  database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
  try {
    for (const table of tables) {
      database.exec(`CREATE TEMP TABLE ${quote(`keep_${table}`)} (id INTEGER PRIMARY KEY)`)
      if (table === 'workspace_settings') {
        const insert = database.prepare(`INSERT INTO temp.${quote(`keep_${table}`)} VALUES (?)`)
        for (const row of database.prepare(`SELECT rowid AS __id, * FROM ${quote(table)}`).iterate()) {
          const scope = databaseRowScope(table, row)
          if (scope && scopes.includes(scope))
            insert.run(row.__id!)
        }
      }
      else if (persistenceIdentityTables.has(table) || scopes.includes(backupTableScopes.get(table)!)) {
        database.exec(`INSERT INTO temp.${quote(`keep_${table}`)} SELECT rowid FROM ${quote(table)}`)
      }
    }
    if (scopes.includes('workspaces')) {
      for (const path of paths) {
        const match = /^buddy\/(conversations|spaces)\/([^/]+)\/workspace(?:\/|$)/.exec(path)
        if (match)
          database.prepare(`INSERT OR IGNORE INTO temp.${quote(`keep_${match[1]}`)} SELECT rowid FROM ${quote(match[1]!)} WHERE id = ?`).run(match[2]!)
      }
    }
    let added: number
    do {
      added = 0
      added += Number(database.prepare('INSERT OR IGNORE INTO temp.keep_conversation_branches SELECT branch.rowid FROM conversation_branches branch JOIN conversations owner ON owner.active_branch_id = branch.id JOIN temp.keep_conversations kept ON kept.id = owner.rowid').run().changes)
      added += Number(database.prepare('INSERT OR IGNORE INTO temp.keep_conversation_members SELECT member.rowid FROM conversation_members member JOIN conversations owner ON owner.id = member.conversation_id JOIN temp.keep_conversations kept ON kept.id = owner.rowid').run().changes)
      for (const [table, field] of [['conversations', 'buddy_id'], ['runs', 'buddy_id'], ['automations', 'actor_id']]) {
        added += Number(database.prepare(`INSERT OR IGNORE INTO temp.keep_buddies SELECT parent.rowid FROM buddies parent JOIN ${quote(table!)} child ON child.${quote(field!)} = parent.id JOIN temp.${quote(`keep_${table}`)} kept ON kept.id = child.rowid`).run().changes)
      }
      added += Number(database.prepare(`INSERT OR IGNORE INTO temp.keep_buddies SELECT parent.rowid FROM buddies parent JOIN buddies child JOIN temp.keep_buddies kept ON kept.id = child.rowid JOIN json_each(child.settings_json, '$.npcIds') npc ON npc.value = parent.id`).run().changes)
      for (const [kind, table] of backupCapabilityOwners) {
        added += Number(database.prepare(`INSERT OR IGNORE INTO temp.keep_extension_capabilities SELECT source.rowid FROM extension_capabilities source JOIN ${quote(table)} owner ON owner.id = source.id JOIN temp.${quote(`keep_${table}`)} kept ON kept.id = owner.rowid WHERE source.kind = ?`).run(kind).changes)
      }
      for (const table of tables) {
        const relations = database.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all() as { id: number, seq: number, table: string, from: string, to: string | null }[]
        for (const id of new Set(relations.map(item => item.id))) {
          const relation = relations.filter(item => item.id === id).sort((a, b) => a.seq - b.seq)
          const parent = relation[0]!.table
          if (!tables.includes(parent))
            throw storageError('SNAPSHOT_DATABASE_INVALID')
          const primary = columns(database, parent).filter(column => column.pk).sort((a, b) => a.pk - b.pk)
          const match = relation.map((item, index) => `child.${quote(item.from)} = parent.${quote(item.to ?? primary[index]!.name)}`).join(' AND ')
          added += Number(database.prepare(`INSERT OR IGNORE INTO temp.${quote(`keep_${parent}`)} SELECT parent.rowid FROM ${quote(parent)} parent JOIN ${quote(table)} child ON ${match} JOIN temp.${quote(`keep_${table}`)} kept ON kept.id = child.rowid`).run().changes)
        }
      }
    } while (added)
    for (const table of tables) {
      database.exec(`DELETE FROM ${quote(table)} WHERE rowid NOT IN (SELECT id FROM temp.${quote(`keep_${table}`)}); DROP TABLE temp.${quote(`keep_${table}`)}`)
    }
    if (!scopes.includes('tasks'))
      database.exec('UPDATE conversation_branches SET forked_from_message_id = NULL')
    if (database.prepare('PRAGMA foreign_key_check').all().length)
      throw storageError('SNAPSHOT_DATABASE_INVALID')
    database.exec('COMMIT')
  }
  catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  finally { database.exec('PRAGMA foreign_keys = ON') }
}

function restoredCapabilityIds(target: DatabaseSync, source: DatabaseSync, scopes: readonly BackupScope[]): Set<SQLInputValue> {
  const restored = new Set<SQLInputValue>()
  const sourceIdentity = source.prepare('SELECT * FROM extension_capabilities WHERE id = ? AND kind = ?')
  const targetIdentity = target.prepare('SELECT * FROM extension_capabilities WHERE id = ? AND kind = ?')
  const targetContribution = target.prepare('SELECT id FROM extension_capabilities WHERE extension_id = ? AND kind = ? AND contribution_id = ?')
  const targetKind = target.prepare('SELECT kind FROM extension_capabilities WHERE id = ?')
  for (const [kind, table] of backupCapabilityOwners) {
    const findOwner = target.prepare(`SELECT 1 FROM ${quote(table)} WHERE id = ?`)
    for (const owner of source.prepare(`SELECT id FROM ${quote(table)}`).iterate()) {
      const existing = findOwner.get(owner.id!)
      if (existing && !scopes.includes(backupTableScopes.get(table)!))
        continue
      const incoming = sourceIdentity.get(owner.id!, kind)
      const current = targetIdentity.get(owner.id!, kind)
      if ((existing && !!incoming !== !!current) || (current && (!incoming || current.extension_id !== incoming.extension_id || current.contribution_id !== incoming.contribution_id)))
        throw storageError('SNAPSHOT_DEPENDENCY_CONFLICT')
      if (!incoming)
        continue
      const contribution = targetContribution.get(incoming.extension_id!, kind, incoming.contribution_id!)
      const identity = targetKind.get(owner.id!)
      if ((contribution && contribution.id !== owner.id) || (identity && identity.kind !== kind))
        throw storageError('SNAPSHOT_DEPENDENCY_CONFLICT')
      restored.add(owner.id!)
    }
  }
  return restored
}

export function mergeBackupDatabase(target: DatabaseSync, source: DatabaseSync, scopes: readonly BackupScope[]): { added: number, updated: number, dependencies: number } {
  const counts = { added: 0, updated: 0, dependencies: 0 }
  const restoredProviders = new Set<string>()
  assertIsolatedPersistenceConstruction(target)
  target.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
  try {
    const capabilities = restoredCapabilityIds(target, source, scopes)
    const persistence = Boolean(target.prepare('SELECT 1 FROM sqlite_master WHERE name = \'storage_profile\'').get())
    const newerRuns = new Set<string>()
    if (persistence) {
      mergePersistenceIdentity(target, source)
      for (const run of source.prepare('SELECT id, next_event_sequence FROM runs').iterate()) {
        const current = target.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get(run.id!)
        if (current && Number(current.next_event_sequence) > Number(run.next_event_sequence))
          newerRuns.add(String(run.id))
      }
    }
    const triggers = target.prepare('SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND sql LIKE \'%AFTER %\'').all()
    for (const trigger of triggers)
      target.exec(`DROP TRIGGER ${quote(String(trigger.name))}`)
    const targetTables = new Set(target.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all().map(row => String(row.name)))
    const sourceTables = new Set(source.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all().map(row => String(row.name)))
    for (const table of backupTables) {
      if (persistence && ['persistence_migrations', 'persistence_migration_entries'].includes(table))
        continue
      if (!targetTables.has(table) || !sourceTables.has(table))
        continue
      const merge = backupMergeColumns(table, columns(target, table))
      if (!merge)
        continue
      const { keys, names, order } = merge
      if (!keys.length)
        throw storageError('SNAPSHOT_DATABASE_INVALID')
      const where = keys.map(key => `${quote(key)} IS ?`).join(' AND ')
      const find = target.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${where}`)
      const insert = target.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
      const update = target.prepare(`UPDATE ${quote(table)} SET ${names.map(name => `${quote(name)} = ?`).join(',')} WHERE ${where}`)
      for (const row of source.prepare(`SELECT * FROM ${quote(table)}${order.length ? ` ORDER BY ${order.map(quote).join(',')}` : ''}`).iterate()) {
        if (table === 'extension_capabilities' && !capabilities.has(row.id!))
          continue
        const scope = databaseRowScope(table, row)
        if (!scope)
          continue
        const selected = scopes.includes(scope)
        const key = keys.map(name => row[name] as SQLInputValue)
        const existing = find.get(...key)
        if (existing && persistence && ((table === 'runs' && newerRuns.has(String(row.id))) || (typeof row.run_id === 'string' && newerRuns.has(row.run_id) && ['messages', 'approvals', 'usage_records', 'execution_state'].includes(table))))
          continue
        if (existing && persistence && ['run_events', 'approval_reviews', 'product_content_references', 'approval_decisions', 'legacy_request_aliases', 'execution_mailbox_sources', 'execution_mailbox_receipts'].includes(table)) {
          const current = target.prepare(`SELECT * FROM ${quote(table)} WHERE ${where}`).get(...key)!
          if (names.some(name => current[name] !== row[name]))
            throw storageError('SNAPSHOT_DEPENDENCY_CONFLICT')
          continue
        }
        if (existing && persistence && table === 'managed_files') {
          const current = target.prepare(`SELECT * FROM managed_files WHERE ${where}`).get(...key)!
          if (['id', 'path', 'size_bytes', 'sha256'].some(name => current[name] !== row[name]))
            throw storageError('SNAPSHOT_DEPENDENCY_CONFLICT')
        }
        if (existing && !selected && table !== 'extension_capabilities')
          continue
        if (scope === 'providers') {
          const providerId = row.provider_id ?? (table === 'provider_configs' || table === 'builtin_provider_configs' ? row.id : undefined)
          if (typeof providerId === 'string')
            restoredProviders.add(providerId)
        }
        const values = names.map(name => row[name] as SQLInputValue)
        if (existing) {
          update.run(...values, ...key)
          counts.updated++
        }
        else {
          insert.run(...values)
          if (selected)
            counts.added++
          else
            counts.dependencies++
        }
      }
    }
    for (const trigger of triggers)
      target.exec(String(trigger.sql))
    const invalidateProvider = target.prepare('DELETE FROM provider_resolution_checkpoints WHERE provider_id = ?')
    for (const providerId of restoredProviders)
      invalidateProvider.run(providerId)
    reconcileRestoredTaskState(target, source)
    if (persistence) {
      target.exec(`UPDATE runs SET next_event_sequence = MAX(COALESCE(next_event_sequence, 1), COALESCE((SELECT MAX(sequence) + 1 FROM run_events WHERE run_id = runs.id), 1))`)
    }
    if (target.prepare('PRAGMA foreign_key_check').all().length)
      throw storageError('SNAPSHOT_DEPENDENCY_CONFLICT')
    target.exec('COMMIT')
    return counts
  }
  catch (error) {
    target.exec('ROLLBACK')
    throw error
  }
  finally { target.exec('PRAGMA foreign_keys = ON') }
}

function assertIsolatedPersistenceConstruction(database: DatabaseSync): void {
  if (database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'trigger\' AND name = \'command_receipts_no_delete\'').get())
    throw storageError('SNAPSHOT_ISOLATED_CONSTRUCTION_REQUIRED')
}

function mergePersistenceIdentity(target: DatabaseSync, source: DatabaseSync): void {
  for (const actor of source.prepare('SELECT * FROM storage_actors').iterate()) {
    if (!target.prepare('SELECT 1 FROM storage_actors WHERE id = ?').get(actor.id!)) {
      target.prepare('INSERT INTO storage_actors (id, kind, state, created_at) VALUES (?, \'device\', \'revoked\', ?)').run(actor.id!, actor.created_at!)
    }
  }
  const names = columns(target, 'command_receipts').map(column => column.name)
  const insert = target.prepare(`INSERT INTO command_receipts (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
  for (const row of source.prepare('SELECT * FROM command_receipts').iterate()) {
    const existing = target.prepare('SELECT * FROM command_receipts WHERE data_generation = ? AND actor_id = ? AND command_id = ?').get(row.data_generation!, row.actor_id!, row.command_id!)
    if (existing) {
      if (names.some(name => existing[name] !== row[name]))
        throw storageError('SNAPSHOT_DEPENDENCY_CONFLICT')
    }
    else {
      insert.run(...names.map(name => row[name] as SQLInputValue))
    }
  }
}

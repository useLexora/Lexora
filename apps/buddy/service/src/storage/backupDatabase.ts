import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { BackupScope } from '../../../shared/storage/backupScope'
import { storageError } from '../../../platform/storage/storageFiles'
import { backupMergeColumns, backupTables, backupTableScopes, databaseRowScope } from './backupDatabasePolicy'
import { reconcileRestoredTaskState } from './restoreTaskState'

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
function columns(database: DatabaseSync, table: string) {
  return database.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string, pk: number }[]
}
export function selectBackupDatabase(database: DatabaseSync, scopes: readonly BackupScope[], paths: readonly string[] = []): void {
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
      else if (scopes.includes(backupTableScopes.get(table)!)) {
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

export function mergeBackupDatabase(target: DatabaseSync, source: DatabaseSync, scopes: readonly BackupScope[]): { added: number, updated: number, dependencies: number } {
  const counts = { added: 0, updated: 0, dependencies: 0 }
  target.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
  try {
    const triggers = target.prepare('SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND sql LIKE \'%AFTER %\'').all()
    for (const trigger of triggers)
      target.exec(`DROP TRIGGER ${quote(String(trigger.name))}`)
    for (const table of backupTables) {
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
        const scope = databaseRowScope(table, row)
        if (!scope)
          continue
        const selected = scopes.includes(scope)
        const key = keys.map(name => row[name] as SQLInputValue)
        const existing = find.get(...key)
        if (existing && !selected)
          continue
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
    reconcileRestoredTaskState(target, source)
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

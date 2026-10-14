import type { DatabaseSync } from 'node:sqlite'
import { createReadStream } from 'node:fs'
import { lstat, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join, posix, relative, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import { containsStoragePath, storageError } from '../../../platform/storage/storageFiles'
import { walkStorage } from '../../../platform/storage/storageTree'

const pathColumns: Record<string, string[]> = {
  attachments: ['stored_path', 'source_path'],
  composer_resources: ['source_path'],
  artifacts: ['current_path', 'directory_root'],
  run_file_change_captures: ['canonical_path', 'before_snapshot_path', 'after_snapshot_path'],
  runs: ['pi_session_file'],
  conversation_pi_trees: ['session_file'],
  execution_thread_bindings: ['session_file'],
  conversation_directory_grants: ['root', 'canonical_root'],
  space_directory_bindings: ['root', 'canonical_root'],
  skill_installations: ['path'],
  skill_file_cleanup: ['path'],
  mcp_servers: ['cwd'],
}
const jsonKeys = new Set(['path', 'root', 'cwd', 'workingDirectory', 'scratchDirectory', 'scratchRoot', 'directoryRoot', 'canonicalRoot', 'canonicalPath', 'currentPath', 'storedPath', 'sourcePath', 'sessionFile', 'piSessionFile', 'snapshotPath', 'beforeSnapshotPath', 'afterSnapshotPath', 'workspaceRoot', 'entryPath', 'rootPath', 'backupPath'])
export function relocateStructuredPaths(value: unknown, source: string, target: string, key = ''): unknown {
  if (typeof value === 'string' && jsonKeys.has(key))
    return relocatePath(value, source, target)
  if (Array.isArray(value)) {
    const mapped = value.map(item => relocateStructuredPaths(item, source, target, key))
    return mapped.every((item, index) => item === value[index]) ? value : mapped
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    const mapped = entries.map(([name, item]) => [name, relocateStructuredPaths(item, source, target, name)] as const)
    return mapped.every(([, item], index) => item === entries[index]![1]) ? value : Object.fromEntries(mapped)
  }
  return value
}
function relocatePath(value: string, source: string, target: string): string {
  const flavor = win32.isAbsolute(source) && !posix.isAbsolute(source) ? win32 : posix
  const suffix = flavor.relative(source, value)
  return flavor.isAbsolute(value) && !flavor.isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${flavor.sep}`) ? join(target, ...suffix.split(flavor.sep)) : value
}
export function relocateDatabaseReferences(database: DatabaseSync, source: string, target: string): void {
  const tables = database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\'').all() as {
    name: string
  }[]
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const { name: table } of tables) {
      if (!/^\w+$/.test(table))
        throw storageError('STORAGE_UNKNOWN_SCHEMA')
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string
      }[]
      const selected = columns.filter(({ name }) => pathColumns[table]?.includes(name) || name.endsWith('_json')).map(({ name }) => name)
      if (!selected.length)
        continue
      for (const row of database.prepare(`SELECT rowid AS __storage_rowid, ${selected.map(name => `"${name}"`).join(',')} FROM "${table}"`).iterate()) {
        const changes: Array<[
          string,
          string,
        ]> = []
        for (const name of selected) {
          const original = row[name]
          if (typeof original !== 'string')
            continue
          const parsed = name.endsWith('_json') ? JSON.parse(original) : null
          const relocated = name.endsWith('_json') ? relocateStructuredPaths(parsed, source, target) : null
          const next = name.endsWith('_json')
            ? parsed === relocated ? original : JSON.stringify(relocated)
            : relocatePath(original, source, target)
          if (next !== original)
            changes.push([name, next])
        }
        if (changes.length)
          database.prepare(`UPDATE "${table}" SET ${changes.map(([name]) => `"${name}" = ?`).join(',')} WHERE rowid = ?`).run(...changes.map(([, value]) => value), row.__storage_rowid!)
      }
    }
    database.exec('DELETE FROM run_event_checkpoints')
    if (database.prepare('PRAGMA foreign_key_check').all().length)
      throw storageError('STORAGE_DATABASE_INVALID')
    database.exec('COMMIT')
  }
  catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
export async function relocateProfileJournals(candidate: string, source: string, target: string, signal: AbortSignal): Promise<void> {
  for await (const entry of walkStorage(candidate, path => path.startsWith('exports/') || path.startsWith('recovery/') || path.startsWith('buddy/backups/'))) {
    signal.throwIfAborted()
    const isJournal = /^buddy\/conversations\/[^/]+\/(?:events|session)\/.+\.jsonl$/.test(entry.path)
    const isWorkbench = /^buddy\/workbench(?:\.previous)?\.json$/.test(entry.path)
    if (entry.directory || entry.link || (!isJournal && !isWorkbench))
      continue
    const file = join(candidate, entry.path)
    if (isJournal) {
      const temporary = `${file}.storage-tmp`
      const output = await open(temporary, 'w', 0o600)
      const input = createReadStream(file, { encoding: 'utf8', signal })
      const lines = createInterface({ input, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          signal.throwIfAborted()
          const original = line ? JSON.parse(line) : null
          const relocated = relocateStructuredPaths(original, source, target)
          const next = relocated === original ? line : JSON.stringify(relocated)
          await output.writeFile(`${next}\n`)
        }
        await output.sync()
      }
      finally {
        lines.close()
        input.destroy()
        await output.close()
      }
      await rename(temporary, file)
    }
    else {
      const text = await readFile(file, 'utf8')
      const next = JSON.stringify(relocateStructuredPaths(JSON.parse(text), source, target))
      if (next !== text)
        await writeFile(file, next, { flush: true })
    }
  }
}
export async function verifyProfileReferences(database: DatabaseSync, candidate: string, target: string): Promise<void> {
  const required = { attachments: ['stored_path'], execution_thread_bindings: ['session_file'], conversation_pi_trees: ['session_file'], skill_installations: ['path'] }
  for (const [table, columns] of Object.entries(required)) {
    for (const column of columns) {
      for (const row of database.prepare(`SELECT "${column}" AS path FROM "${table}"${table === 'skill_installations' ? ' WHERE enabled = 1' : ''}`).iterate()) {
        const path = row.path
        if (typeof path !== 'string')
          continue
        if (!containsStoragePath(target, path)) {
          if (table !== 'skill_installations')
            throw storageError('STORAGE_REFERENCE_OUTSIDE')
          continue
        }
        await lstat(join(candidate, relative(target, path))).catch(() => {
          throw storageError('STORAGE_REFERENCE_MISSING')
        })
      }
    }
  }
}

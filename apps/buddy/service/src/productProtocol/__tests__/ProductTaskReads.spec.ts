import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { ProductQueries } from '../ProductQueries'

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('product task reads', () => {
  it('keeps batched summaries pinned to one SQLite snapshot across pages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-task-read-'))
    directories.push(directory)
    const database = openBuddyMigrationCandidate({ databasePath: join(directory, 'buddy.sqlite3') })
    databases.push(database)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
    for (let index = 0; index < 101; index++)
      seedSqliteRun(database, `run-${index}`, { conversationId: `task-${index}` })
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const snapshot = queries.openSnapshot('taskIndex')
    try {
      const first = snapshot.read(null)
      expect(first.items).toHaveLength(100)
      expect(first.nextCursor).not.toBeNull()
      database.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('Changed after snapshot', 'task-100')
      database.prepare('UPDATE runs SET status = ?, completed_at = ? WHERE id = ?').run('completed', '2026-11-01T00:00:00.000Z', 'run-100')
      const last = snapshot.read(first.nextCursor)
      expect(last).toMatchObject({ complete: true, nextCursor: null, items: [{ id: 'task-100', title: null, activity: 'running', unread: false, lastRunStatus: 'queued', previewText: 'Fixture input' }] })
      expect(queries.task('task-100', true)).toMatchObject({ title: 'Changed after snapshot', activity: 'idle', unread: true, lastRunStatus: 'completed' })
    }
    finally {
      snapshot.close()
    }
    expect(database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
  })
})

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
  it('exposes pending approval facts on the turn snapshot but reserves the review document for an explicit read', () => {
    const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
    databases.push(database)
    seedSqliteRun(database, 'approval-run')
    database.prepare(`INSERT INTO approvals (id, run_id, tool_call_id, kind, status, summary, payload_json, created_at)
      VALUES ('approval', 'approval-run', 'call', 'read', 'pending', 'Read fixture', '{}', '2026-11-01T00:00:00Z')`).run()
    const review = { reviewVersion: '1'.repeat(64), contentVersion: 1, operationDigest: '2'.repeat(64), body: { file: 'only-on-review' }, complete: true, expiresAt: '2099-11-01T00:00:00Z', lifetimeId: 'fixture', allowedDecisions: ['approved', 'denied'], persistentEffect: false }
    database.prepare('INSERT INTO approval_reviews (approval_id, review_json) VALUES (?, ?)').run('approval', JSON.stringify(review))
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const snapshot = queries.snapshot('conversationTurns:task-1:branch-task-1')
    expect(snapshot.complete).toBe(true)
    expect(snapshot.items).toContainEqual(expect.objectContaining({ entity: 'approval', value: expect.objectContaining({ id: 'approval', status: 'pending', review: null }) }))
    expect(JSON.stringify(snapshot.items)).not.toContain('only-on-review')
    expect(queries.read('approvals.get', { approvalId: 'approval' })).toMatchObject({ review: { reviewVersion: review.reviewVersion, document: { text: expect.stringContaining('only-on-review') } } })
  })

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

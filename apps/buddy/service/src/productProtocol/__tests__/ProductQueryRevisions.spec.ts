import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { SqliteRunEventWriter } from '../../events/SqliteRunEventWriter'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { ProductQueries } from '../ProductQueries'

interface Page { items: Record<string, unknown>[], nextCursor: string | null }
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture() {
  const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  databases.push(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  seedSqliteRun(database, 'main-run', { conversationId: 'main' })
  seedSqliteRun(database, 'other-run', { conversationId: 'other' })
  const conversations = createConversationRepository(database)
  const queries = new ProductQueries(database, 'desktop-local', 'instance')
  const writer = new SqliteRunEventWriter(database, (error) => {
    throw error
  })
  const append = (runId: string) => writer.append({ runId, type: 'message.delta', payload: { messageId: `${runId}-reply`, delta: 'stream' } })
  const message = (id: string, branchId = 'branch-main', runId: string | null = null) => conversations.createMessage({ id, conversationId: 'main', branchId, runId, role: 'assistant', content: { text: id }, createdAt: `2026-10-01T00:00:${id.slice(-2)}.000Z` })
  for (const id of ['message-00', 'message-01', 'message-02']) message(id)
  const history = (branchId = 'branch-main', cursor: string | null = null) => queries.read('conversations.listMessages', { conversationId: 'main', branchId, cursor, limit: 1 }) as Page
  return { database, conversations, queries, writer, append, message, history }
}

describe('product query revision scopes', () => {
  it('keeps history, task summaries and branch counts pageable while any run streams', () => {
    const f = fixture()
    f.conversations.createBranch({ id: 'sibling', conversationId: 'main', parentBranchId: 'branch-main', forkedFromMessageId: 'message-01', activate: false, createdAt: '2026-10-01T00:00:03.000Z' })
    const tasks = (cursor: string | null = null) => f.queries.read('conversations.list', { cursor, limit: 1 }) as Page
    const branches = (cursor: string | null = null) => f.queries.read('conversations.listBranches', { conversationId: 'main', cursor, limit: 1 }) as Page
    const taskPage = tasks()
    const branchPage = branches()
    const historyPage = f.history()
    for (const runId of ['other-run', 'main-run']) {
      f.append(runId)
      expect(tasks(taskPage.nextCursor).items).toMatchObject([{ id: 'other' }])
      expect(branches(branchPage.nextCursor).items).toMatchObject([{ id: 'sibling' }])
      expect(f.history('branch-main', historyPage.nextCursor).items).toMatchObject([{ id: 'message-01' }])
    }
    f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = \'main-run\'').run()
    expect(() => tasks(taskPage.nextCursor)).toThrow('CURSOR_EXPIRED')
    expect(() => branches(branchPage.nextCursor)).toThrow('CURSOR_EXPIRED')
    expect(f.history('branch-main', historyPage.nextCursor).items).toMatchObject([{ id: 'message-01' }])
  })

  it('tracks only the inherited prefix when the parent branch keeps changing', () => {
    const f = fixture()
    f.conversations.createBranch({ id: 'child', conversationId: 'main', parentBranchId: 'branch-main', forkedFromMessageId: 'message-01', activate: false, createdAt: '2026-10-01T00:00:03.000Z' })
    f.message('child-04', 'child')
    f.message('child-05', 'child')
    const page = f.history('child')
    f.message('message-06')
    f.database.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify({ text: 'outside inherited history' }), 'message-02')
    expect(f.history('child', page.nextCursor).items).toMatchObject([{ id: 'child-04' }])
    f.database.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify({ text: 'changed inherited history' }), 'message-00')
    expect(() => f.history('child', page.nextCursor)).toThrow('CURSOR_EXPIRED')
    const refreshed = f.history('child')
    f.database.prepare('DELETE FROM messages WHERE id = ?').run('message-00')
    expect(() => f.history('child', refreshed.nextCursor)).toThrow('CURSOR_EXPIRED')
  })

  it('invalidates inherited resource snapshots when their file becomes unavailable', () => {
    const f = fixture()
    const now = '2026-10-01T00:00:00.000Z'
    f.database.prepare(`INSERT INTO managed_files (id, path, size_bytes, sha256, state, durability, created_at, updated_at)
      VALUES ('file', '/fixture/resource', 1, ?, 'ready', 'legacy-verified', ?, ?)`).run('a'.repeat(64), now, now)
    f.database.prepare(`INSERT INTO attachments (id, message_id, stored_path, name, mime_type, size_bytes, created_at)
      VALUES ('attachment', 'message-02', '/fixture/resource', 'example.txt', 'text/plain', 1, ?)`).run(now)
    const content = { userContent: { ...createBuddyUserContent('inherited resource'), panelResourceIds: ['resource'] }, resourceSnapshots: [{ resourceId: 'resource', attachmentId: 'attachment' }] }
    f.database.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify(content), 'message-00')
    f.conversations.createBranch({ id: 'child', conversationId: 'main', parentBranchId: 'branch-main', forkedFromMessageId: 'message-01', activate: false, createdAt: now })
    f.message('child-05', 'child')
    f.conversations.createMessage({ id: 'opaque', conversationId: 'other', branchId: 'branch-other', runId: null, role: 'assistant', content: { resourceSnapshots: ['opaque historical value'] }, createdAt: now })
    const page = f.history('child')
    const resource = () => (f.queries.read('conversations.listMessages', { conversationId: 'main', branchId: 'child', limit: 100 }) as Page).items.find(message => message.id === 'message-00')?.resources
    expect(resource()).toMatchObject([{ resourceId: 'attachment:attachment', availability: 'ready' }])
    f.database.prepare('UPDATE managed_files SET state = \'unavailable\' WHERE id = \'file\'').run()
    expect(() => f.history('child', page.nextCursor)).toThrow('CURSOR_EXPIRED')
    expect(resource()).toMatchObject([{ resourceId: 'attachment:attachment', availability: 'unavailable' }])
  })
})

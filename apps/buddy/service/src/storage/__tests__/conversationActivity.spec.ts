import type { DatabaseSync } from 'node:sqlite'
import type { ChatQueueChange } from '../../chat/ChatQueueService'
import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Emitter } from '../../../../shared/events/Emitter'
import { createProductSynchronization } from '../../productProtocol/createProductSynchronization'
import { ProductQueries } from '../../productProtocol/ProductQueries'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase, openBuddyMigrationCandidate } from '../database'
import { createRunRepository } from '../runRepository'

const databases: DatabaseSync[] = []
const directories: string[] = []
const time = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString()
afterEach(() => {
  databases.splice(0).forEach(database => database.close())
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function fixture(sqlite: boolean, databasePath = ':memory:') {
  const database = (sqlite ? openBuddyMigrationCandidate : openBuddyDatabase)({ databasePath })
  databases.push(database)
  if (sqlite)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  for (const id of ['old', 'new'])
    conversations.create({ id, branchId: `branch-${id}`, title: `task ${id}`, spaceId: null, createdAt: time(id === 'old' ? 0 : 10), approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  function run(id: string, executionKind: 'root' | 'actor_child' | 'npc_child' | 'maintenance' = 'root') {
    return runs.create({ id, conversationId: 'old', branchId: 'branch-old', triggeringMessageId: 'input', startedAt: time(1), status: 'running', purpose: executionKind === 'maintenance' ? 'conversation.compaction' : 'chat', executionKind, rootRunId: executionKind === 'root' ? id : 'root', parentRunId: executionKind === 'root' ? null : 'root', provider: 'fixture', model: 'fixture', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  }
  run('root')
  function message(id: string, minute: number, content: unknown = { text: id }, role: 'user' | 'assistant' = 'user', runId: string | null = null) {
    conversations.createMessage({ id, conversationId: 'old', branchId: 'branch-old', runId, role, content, createdAt: time(minute) })
  }
  let sequence = 0
  function mailbox(id: string, minute: number, payload: Record<string, unknown>, source = 'root', target = source) {
    database.prepare(`INSERT INTO execution_mailbox_sources (id, source_run_id, source_sequence, target_run_id, target_generation, payload_json, payload_hash, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)`).run(id, source, ++sequence, target, JSON.stringify(payload), id, time(minute))
    return sequence
  }
  const activity = () => conversations.getHistoryEntries(['old'])[0]!.conversation.lastActivityAt
  const queries = sqlite ? new ProductQueries(database, 'desktop-local', 'instance') : null
  return { database, conversations, runs, run, message, mailbox, activity, queries }
}

it('publishes persisted queue, human supplement and root completion activity to subscribed clients', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-activity-'))
  directories.push(directory)
  const f = fixture(true, join(directory, 'buddy.sqlite3'))
  const errors: unknown[] = []
  const events = new Emitter<BuddyRunEvent>(error => errors.push(error))
  const queue = new Emitter<ChatQueueChange>(error => errors.push(error))
  const silent = { onDidCommit: () => ({ dispose() {} }) }
  const sync = createProductSynchronization({ database: f.database, queries: f.queries!, drafts: silent, metadata: silent, lifecycle: silent, events: { onDidCommit: events.event }, queue: { onDidChange: queue.event } })
  const frames: { params: { changes: { value: { id: string, lastActivityAt: string } }[] } }[] = []
  sync.publisher.connect('client', {
    send: (frame) => {
      frames.push(JSON.parse(frame))
      return true
    },
    close() {},
  })
  const subscription = sync.publisher.subscribe('client', { subscriptionId: 'tasks', topic: 'taskIndex' })
  subscription.activate()
  try {
    const sequence = f.mailbox('human', 12, { kind: 'supplement', origin: 'user' })
    events.fire({ runId: 'root', sequence, type: 'execution.mailbox.sent', payload: {}, createdAt: time(12) })
    expect(frames.at(-1)?.params.changes).toMatchObject([{ value: { id: 'old', lastActivityAt: time(12) } }])
    f.database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at)
      VALUES ('queue', 'old', 'branch-old', 'request', 'fingerprint', '{}', 'waiting', ?)`).run(time(20))
    queue.fire({ kind: 'enqueued', scope: { conversationId: 'old', branchId: 'branch-old' } })
    expect(frames.at(-1)?.params.changes).toMatchObject([{ value: { id: 'old', lastActivityAt: time(20) } }])
    f.runs.reconcileTerminal('root', 'completed', time(30), null)
    events.fire({ runId: 'root', sequence: 2, type: 'run.completed', payload: {}, createdAt: time(30) })
    expect(frames.at(-1)?.params.changes).toMatchObject([{ value: { id: 'old', lastActivityAt: time(30) } }])
    expect(errors).toEqual([])
  }
  finally {
    sync.dispose()
    events.dispose()
    queue.dispose()
  }
})

describe.each([false, true])('conversation activity (SQLite authority: %s)', (sqlite) => {
  it.each(['completed', 'cancelled'] as const)('orders and displays %s by the root terminal fact without rewriting metadata', (status) => {
    const f = fixture(sqlite)
    f.message('input', 1)
    f.database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(time(50), 'new')
    f.runs.reconcileTerminal('root', status, time(20), status === 'completed' ? null : 'RUN_CANCELLED')
    expect(f.activity()).toBe(time(20))
    expect(f.conversations.listRecent().map(task => task.id)).toEqual(['old', 'new'])
    const first = f.conversations.listHistory({ kind: 'search', query: 'task', limit: 1 })
    expect(first.items[0]?.conversation).toMatchObject({ id: 'old', lastActivityAt: time(20), updatedAt: time(0) })
    const second = f.conversations.listHistory({ kind: 'search', query: 'task', limit: 1, cursor: first.nextCursor! })
    expect(second.items.map(item => item.conversation.id)).toEqual(['new'])
    expect(second.nextCursor).toBeNull()
    if (f.queries)
      expect(f.queries.task('old', true)).toMatchObject({ lastActivityAt: time(20), updatedAt: time(0) })
  })

  it('uses input acceptance, not metadata edits, replies, queued dispatch or compaction', () => {
    const f = fixture(sqlite)
    f.message('input', 2)
    f.database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at)
      VALUES ('queue', 'old', 'branch-old', 'request', 'fingerprint', ?, 'waiting', ?)`).run(JSON.stringify({ userMessageId: 'queued-input' }), time(12))
    expect(f.activity()).toBe(time(12))
    f.message('queued-input', 30)
    f.database.prepare('UPDATE chat_queue SET state = \'sent\', run_id = \'root\' WHERE id = \'queue\'').run()
    f.message('reply', 40, { text: 'reply' }, 'assistant', 'root')
    f.database.prepare('UPDATE conversations SET updated_at = ?, title = \'Renamed\' WHERE id = \'old\'').run(time(50))
    for (const kind of ['actor_child', 'npc_child', 'maintenance'] as const) {
      f.run(kind, kind)
      f.runs.reconcileTerminal(kind, 'completed', time(55), null)
    }
    expect(f.activity()).toBe(time(12))
    f.message('supplement', 45)
    f.runs.reconcileTerminal('root', 'completed', time(35), null)
    expect(f.activity()).toBe(time(45))
  })

  it('keeps durable human supplements across generation changes but excludes internal delivery', () => {
    const f = fixture(sqlite)
    f.run('child', 'npc_child')
    f.mailbox('internal', 20, { kind: 'supplement', text: 'progress' }, 'child', 'root')
    expect(f.activity()).toBe(time(0))
    f.mailbox('human', 12, { kind: 'supplement', origin: 'user' }, 'child')
    expect(f.activity()).toBe(time(12))
    f.database.prepare('UPDATE runs SET generation = generation + 1 WHERE id = \'child\'').run()
    f.message('forwarded', 3)
    f.mailbox('forwarded', 30, { kind: 'supplement', origin: 'user' }, 'child')
    expect(f.activity()).toBe(time(12))
    f.mailbox('question', 40, { kind: 'question', audience: 'user', questionId: 'legacy' }, 'child', 'root')
    f.mailbox('answer', 15, { kind: 'answer', questionId: 'legacy' }, 'child')
    expect(f.activity()).toBe(time(15))
  })

  it.runIf(sqlite)('keeps task pagination stable for internal mailbox traffic and invalidates it for human input', () => {
    const f = fixture(sqlite)
    const page = (cursor: string | null = null) => f.queries!.read('conversations.list', { cursor, limit: 1 }) as { items: unknown[], nextCursor: string | null }
    const first = page()
    f.mailbox('internal-progress', 30, { kind: 'supplement', purpose: 'progress' })
    expect(() => page(first.nextCursor)).not.toThrow()
    f.mailbox('user-input', 12, { kind: 'supplement', origin: 'user' })
    expect(() => page(first.nextCursor)).toThrow('CURSOR_EXPIRED')
    const refreshed = page()
    expect(f.queries!.task('old', true)).toMatchObject({ lastActivityAt: time(12) })
    f.database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at)
      VALUES ('queue', 'old', 'branch-old', 'request', 'fingerprint', '{}', 'waiting', ?)`).run(time(20))
    expect(() => page(refreshed.nextCursor)).toThrow('CURSOR_EXPIRED')
  })

  it('uses the submitted answer time rather than retry delivery or automatic continuation', () => {
    const f = fixture(sqlite)
    f.database.prepare('INSERT INTO user_questions (id, run_id, tool_call_id, request_json) VALUES (?, ?, ?, ?)')
      .run('question', 'root', 'ask', JSON.stringify({ status: 'answered', resolvedAt: time(15) }))
    f.mailbox('answer-delivery', 20, { kind: 'supplement', origin: 'user', purpose: 'question_answer' })
    f.message('continued', 25, { userContent: { text: 'answer' }, questionReply: { requestId: 'question' } })
    expect(f.activity()).toBe(time(15))
  })
})

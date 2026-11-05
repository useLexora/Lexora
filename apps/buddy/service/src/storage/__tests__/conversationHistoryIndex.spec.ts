import type { DatabaseSync } from 'node:sqlite'
import type { ConversationHistoryQuery } from '../../../../shared/conversation/conversationHistoryApi'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import { conversationHistoryPageSchema } from '../../../../shared/conversation/conversationHistoryApi'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createRunRepository } from '../runRepository'
import { createSpaceRepository } from '../spaceRepository'
import { createTaskMarkRepository } from '../taskMarkRepository'

const databases: DatabaseSync[] = []
const now = '2026-10-01T00:00:00.000Z'
const old = '2026-01-01T00:00:00.000Z'
const taskId = (index: number) => `history-${String(index).padStart(5, '0')}`

afterEach(() => databases.splice(0).forEach(database => database.close()))

function fixture(count = 20) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const marks = createTaskMarkRepository(database)
  createSpaceRepository(database).create({ id: 'archive', name: 'Archive 100%_项目', createdAt: old, primaryDirectory: null, additionalDirectories: [], memoryScope: 'personal_and_space' })
  for (let index = 0; index < count; index++) {
    const id = taskId(index)
    conversations.create({ id, branchId: `branch-${id}`, createdAt: index < 10 ? old : now, title: index === 0 ? 'Legacy 100%_任务' : `Task ${index}`, spaceId: index < 10 ? 'archive' : null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  }
  function run(index: number, suffix: string, status: 'completed' | 'failed' | 'running' | 'cancelled' = 'completed', purpose: 'chat' | 'conversation.compaction' = 'chat') {
    const conversationId = taskId(index)
    return runs.create({ id: `${conversationId}-${suffix}`, conversationId, branchId: `branch-${conversationId}`, triggeringMessageId: `input-${index}`, startedAt: old, completedAt: status === 'running' ? null : old, status, purpose, provider: 'fixture', model: 'fixture', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  }
  return { database, conversations, runs, marks, run }
}

function ids(page: ReturnType<ReturnType<typeof createConversationRepository>['listHistory']>) {
  return page.items.map(item => item.conversation.id)
}

describe('bounded conversation history index', () => {
  it('queries 10,000 tasks with complete pagination and metadata-only search', () => {
    const f = fixture(10_000)
    const mark = f.marks.create({ name: 'Review', description: '', color: '#3979d6' })
    f.marks.assign(taskId(0), mark.id)
    f.run(1, 'result')
    f.run(2, 'active', 'running')
    f.marks.setRead({ ...f.marks.getState(taskId(3)), read: false })
    f.run(4, 'approval', 'running')
    f.database.prepare(`INSERT INTO approvals (id, run_id, tool_call_id, kind, status, summary, payload_json, created_at) VALUES ('approval', ?, 'tool', 'shell', 'pending', 'Fixture', '{}', ?)`).run(`${taskId(4)}-approval`, old)
    f.run(5, 'read-result')
    f.marks.setRead({ ...f.marks.getState(taskId(5)), read: true })
    f.run(6, 'cancelled', 'cancelled')
    f.run(7, 'compaction', 'completed', 'conversation.compaction')
    f.conversations.markDeleted(taskId(8), now)
    f.marks.assign(taskId(9), mark.id)
    f.conversations.markDeleted(taskId(9), now)
    f.marks.assign(taskId(9999), mark.id)
    f.conversations.setModelSelection({ id: taskId(0), modelSelection: { modelId: 'chosen-model', providerId: 'chosen-provider', reasoning: 'high', serviceTier: null }, updatedAt: old })
    f.conversations.createMessage({ id: 'private-transcript', conversationId: taskId(0), branchId: `branch-${taskId(0)}`, runId: null, role: 'user', content: { text: 'Transcript-only-secret' }, createdAt: old })

    const attention = f.conversations.listHistory({ kind: 'attention', limit: 100 })
    expect(ids(attention)).toEqual([9999, 4, 3, 2, 1, 0].map(taskId))
    expect(attention.nextCursor).toBeNull()
    expect(conversationHistoryPageSchema.safeParse(attention).success).toBe(true)
    for (const item of attention.items)
      expect(item.markState).toEqual(f.marks.getState(item.conversation.id))
    expect(attention.items.find(item => item.conversation.id === taskId(4))?.conversation.activity).toBe('awaiting_approval')
    expect(attention.items.find(item => item.conversation.id === taskId(0))?.conversation.modelSelection?.modelId).toBe('chosen-model')
    expect(ids(f.conversations.listHistory({ kind: 'attention', spaceId: 'archive' }))).toEqual([4, 3, 2, 1, 0].map(taskId))
    expect(ids(f.conversations.listHistory({ kind: 'attention', spaceId: null }))).toEqual([taskId(9999)])
    const attentionFirst = f.conversations.listHistory({ kind: 'attention', limit: 2 })
    const attentionSecond = f.conversations.listHistory({ kind: 'attention', limit: 2, cursor: attentionFirst.nextCursor! })
    expect([...ids(attentionFirst), ...ids(attentionSecond)]).toEqual([9999, 4, 3, 2].map(taskId))

    const scope = { kind: 'ordinary', spaceId: null, excludeIds: [taskId(9998)] } as const
    const first = f.conversations.listHistory(scope)
    expect(ids(first)).toEqual(Array.from({ length: 10 }, (_, index) => taskId(9997 - index)))
    const all: string[] = []
    let page = f.conversations.listHistory({ ...scope, limit: 100 })
    do {
      all.push(...ids(page))
      if (!page.nextCursor)
        break
      page = f.conversations.listHistory({ ...scope, limit: 100, cursor: page.nextCursor })
    } while (true)
    expect(all).toEqual(Array.from({ length: 9988 }, (_, index) => taskId(9997 - index)))
    expect(new Set(all).size).toBe(all.length)
    expect(ids(f.conversations.listHistory({ kind: 'ordinary', spaceId: 'archive' }))).toEqual([7, 6, 5].map(taskId))

    const search = f.conversations.listHistory({ kind: 'search', query: 'legacy 100%_' })
    expect(ids(search)).toEqual([taskId(0)])
    const spaceSearch = f.conversations.listHistory({ kind: 'search', query: 'Archive 100%_', limit: 3 })
    expect(ids(spaceSearch)).toEqual([7, 6, 5].map(taskId))
    expect(ids(f.conversations.listHistory({ kind: 'search', query: 'Archive 100%_', limit: 3, cursor: spaceSearch.nextCursor! }))).toEqual([4, 3, 2].map(taskId))
    expect(ids(f.conversations.listHistory({ kind: 'search', query: 'Transcript-only-secret' }))).toEqual([])

    const batch = [taskId(0), taskId(0), taskId(8), 'missing', ...Array.from({ length: 496 }, (_, index) => taskId(1000 + index))]
    const lookup = f.conversations.getHistoryEntries(batch)
    expect(lookup.map(item => item.conversation.id)).toEqual([taskId(0), ...batch.slice(4)])
    expect(lookup[0]?.markState).toEqual(f.marks.getState(taskId(0)))
    expect(f.conversations.getHistoryEntries([])).toEqual([])
  })

  it('validates query identity and cursor format without coupling to unrelated writes', () => {
    const f = fixture()
    const query = { kind: 'ordinary', spaceId: null, excludeIds: [taskId(19), taskId(18)], limit: 2 } as const
    const first = f.conversations.listHistory(query)
    const cursor = first.nextCursor!
    const invalidQueries: unknown[] = [
      { kind: 'ordinary' },
      { kind: 'other' },
      { kind: 'search', query: '  ' },
      { kind: 'search', query: 'Task', spaceId: null },
      { kind: 'attention', query: '' },
      { kind: 'attention', excludeIds: [] },
      { kind: 'attention', limit: 0 },
      { kind: 'attention', limit: 101 },
      { kind: 'attention', limit: 1.5 },
      { kind: 'attention', unknown: true },
      { ...query, excludeIds: Array.from({ length: 501 }, (_, index) => `id-${index}`) },
      { ...query, cursor: '###' },
      { ...query, cursor: `${cursor}=` },
      { ...query, cursor, spaceId: 'archive' },
      { ...query, cursor, excludeIds: [] },
      { kind: 'attention', cursor },
      { ...query, cursor: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, 'base64url').toString()), version: 2 })).toString('base64url') },
    ]
    for (const input of invalidQueries)
      expect(() => f.conversations.listHistory(input as ConversationHistoryQuery)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(() => f.conversations.getHistoryEntries(Array.from({ length: 501 }, (_, index) => `id-${index}`))).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    const search = f.conversations.listHistory({ kind: 'search', query: 'Task', limit: 2 })
    expect(() => f.conversations.listHistory({ kind: 'search', query: 'Legacy', cursor: search.nextCursor! })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(ids(f.conversations.listHistory({ ...query, excludeIds: [taskId(18), taskId(19), taskId(18)], cursor }))).toEqual([taskId(15), taskId(14)])

    f.conversations.markDeleted(taskId(16), now)
    f.conversations.create({ id: 'new-task', branchId: 'new-branch', createdAt: '2026-11-01T00:00:00.000Z', title: 'New', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    const mark = f.marks.create({ name: 'Later mark', description: '', color: '#3979d6' })
    f.marks.assign(taskId(15), mark.id)
    expect(ids(f.conversations.listHistory({ ...query, cursor }))).toEqual([taskId(14), taskId(13)])
    expect(ids(f.conversations.listHistory(query))).toEqual(['new-task', taskId(17)])
    expect(f.conversations.getHistoryEntries([taskId(16)])).toEqual([])
  })

  it('uses the latest root result and read revision rather than child, cancelled or compaction results', () => {
    const f = fixture()
    f.run(0, 'first')
    f.marks.setRead({ ...f.marks.getState(taskId(0)), read: true })
    f.run(0, 'compaction', 'completed', 'conversation.compaction')
    f.run(0, 'cancelled', 'cancelled')
    f.run(0, 'child')
    f.database.prepare('UPDATE runs SET execution_kind = \'npc_child\' WHERE id = ?').run(`${taskId(0)}-child`)
    expect(ids(f.conversations.listHistory({ kind: 'attention' }))).toEqual([])
    f.run(0, 'later', 'failed')
    const attention = f.conversations.listHistory({ kind: 'attention' })
    expect(ids(attention)).toEqual([taskId(0)])
    expect(attention.items[0]?.markState).toEqual(f.marks.getState(taskId(0)))
    expect(attention.items[0]?.markState).toMatchObject({ resultRunId: `${taskId(0)}-later`, unread: true, readRevision: 1 })
    f.marks.setRead({ ...f.marks.getState(taskId(0)), read: true })
    expect(ids(f.conversations.listHistory({ kind: 'attention' }))).toEqual([])
    expect(f.conversations.getHistoryEntries([taskId(0)])[0]?.markState.readRevision).toBe(2)
  })
})

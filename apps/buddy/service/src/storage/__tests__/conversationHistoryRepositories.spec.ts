import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { RunEventProjector } from '../../events/RunEventProjector'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createRunRepository } from '../runRepository'
import { createExecutionStorageFixture } from './executionFixture'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('conversation history repositories', () => {
  it('reads actor message phases through their public source without rewriting historical messages', () => {
    const f = createExecutionStorageFixture()
    databases.push(f.database)
    f.conversations.createMessage({ id: 'goal', conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: 'Work together' }, createdAt: '2026-10-12T00:00:00.000Z' })
    f.executions.admitChild(f.child('actor', f.actor.id))
    f.executions.admitChild(f.child('private'))
    const projector = new RunEventProjector(f.database)
    for (const runId of ['actor', 'private']) {
      projector.project([
        { runId, sequence: 1, type: 'message.completed', createdAt: '2026-10-12T00:00:01.000Z', payload: { messageId: `${runId}-comment`, role: 'assistant', phase: 'commentary', content: { text: 'Checking' }, stopReason: 'completed' } },
        { runId, sequence: 2, type: 'message.completed', createdAt: '2026-10-12T00:00:02.000Z', payload: { messageId: `${runId}-tool`, role: 'assistant', content: { text: 'Reading' }, stopReason: 'tool_use' } },
        { runId, sequence: 3, type: 'message.completed', createdAt: '2026-10-12T00:00:03.000Z', payload: { messageId: `${runId}-final`, role: 'assistant', phase: 'final_answer', content: { text: 'Ready' }, stopReason: 'completed' } },
      ])
    }
    const stored = f.database.prepare('SELECT * FROM messages ORDER BY id').all()
    expect(stored.every(row => !JSON.parse(String(row.content_json)).phase)).toBe(true)
    const page = f.conversations.listTimelinePage('conversation', 'branch', { limit: 100 })
    expect(page.items.map(item => item.id)).toEqual(['goal', 'actor-comment', 'actor-tool', 'actor-final'])
    expect(page.items.flatMap(item => item.kind === 'message' && item.role === 'assistant' ? [item.content] : [])).toEqual([
      { text: 'Checking', phase: 'commentary' },
      { text: 'Reading', phase: 'commentary' },
      { text: 'Ready', phase: 'final_answer' },
    ])
    expect(f.database.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(stored)
    f.database.prepare('UPDATE conversation_publications SET source_sequence = 3 WHERE message_id = ?').run('actor-comment')
    const mismatched = f.conversations.listTimelinePage('conversation', 'branch', { limit: 100 }).items.find(item => item.id === 'actor-comment')
    expect(mismatched?.kind === 'message' ? mismatched.content : null).toEqual({ text: 'Checking' })
  })

  it.each(['message.completed', 'message.interrupted'])('reads public message start times for roots and actors through their matching %s source', (type) => {
    const f = createExecutionStorageFixture()
    databases.push(f.database)
    f.conversations.createMessage({ id: 'goal', conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: 'Work together' }, createdAt: '2026-10-12T00:00:00.000Z' })
    f.executions.admitChild(f.child('actor', f.actor.id))
    f.executions.admitChild(f.child('private'))
    const projector = new RunEventProjector(f.database)
    projector.project([{ runId: 'private', sequence: 1, type: 'message.started', createdAt: '2026-10-12T00:00:01.000Z', payload: { messageId: 'actor-reply', role: 'assistant' } }])
    const payload = (messageId: string, text: string) => type === 'message.completed'
      ? { messageId, role: 'assistant', content: { text }, stopReason: 'completed' }
      : { messageId, role: 'assistant', content: { text, state: 'interrupted', truncated: false }, reason: 'runtime_restarted' }
    for (const runId of ['root', 'actor']) {
      projector.project([
        { runId, sequence: 1, type: 'message.started', createdAt: '2026-10-12T00:00:01.000Z', payload: { messageId: `${runId}-other`, role: 'assistant' } },
        { runId, sequence: 2, type: 'message.started', createdAt: '2026-10-12T00:00:02.000Z', payload: { messageId: `${runId}-reply`, role: 'assistant' } },
        { runId, sequence: 3, type: 'message.started', createdAt: '2026-10-12T00:00:03.000Z', payload: { messageId: `${runId}-reply`, role: 'assistant' } },
        { runId, sequence: 4, type, createdAt: '2026-10-12T00:00:20.000Z', payload: payload(`${runId}-reply`, 'Visible before the follow-up') },
        { runId, sequence: 5, type, createdAt: '2026-10-12T00:00:21.000Z', payload: payload(`${runId}-legacy`, 'No recorded start') },
        { runId, sequence: 6, type: 'message.started', createdAt: '2026-10-12T00:00:22.000Z', payload: { messageId: `${runId}-legacy`, role: 'assistant' } },
      ])
    }
    const stored = f.database.prepare('SELECT * FROM messages ORDER BY id').all()
    const page = f.conversations.listTimelinePage('conversation', 'branch', { limit: 100 })
    for (const runId of ['root', 'actor']) {
      expect(page.items.find(item => item.id === `${runId}-reply`)).toMatchObject({ startedAt: '2026-10-12T00:00:02.000Z', createdAt: '2026-10-12T00:00:20.000Z' })
      expect(page.items.find(item => item.id === `${runId}-legacy`)).toMatchObject({ createdAt: '2026-10-12T00:00:21.000Z' })
      expect(page.items.find(item => item.id === `${runId}-legacy`)).not.toHaveProperty('startedAt')
    }
    f.database.prepare('UPDATE conversation_publications SET source_sequence = 5 WHERE message_id = ?').run('actor-reply')
    expect(f.conversations.listTimelinePage('conversation', 'branch', { limit: 100 }).items.find(item => item.id === 'actor-reply')).not.toHaveProperty('startedAt')
    expect(f.database.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(stored)
  })

  it('projects only accepted steering ownership from the matching public conversation and branch', () => {
    const f = createExecutionStorageFixture()
    databases.push(f.database)
    for (const [id, seconds] of [['goal', '00'], ['accepted', '01'], ['waiting', '02'], ['foreign', '03']] as const)
      f.conversations.createMessage({ id, conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: id }, createdAt: `2026-10-12T00:00:${seconds}.000Z` })
    f.conversations.createBranch({ id: 'other-branch', conversationId: 'conversation', parentBranchId: 'branch', forkedFromMessageId: 'goal', createdAt: '2026-10-12T00:00:04.000Z', activate: false })
    const insert = f.database.prepare('INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [id, branch, state] of [['accepted', 'branch', 'sent'], ['waiting', 'branch', 'waiting'], ['foreign', 'other-branch', 'sent']])
      insert.run(`queue-${id}`, 'conversation', branch, `request-${id}`, 'fixture', JSON.stringify({ userMessageId: id }), state, 'root', '2026-10-12T00:00:05.000Z')
    const stored = f.database.prepare('SELECT * FROM messages ORDER BY id').all()
    const items = f.conversations.listTimelinePage('conversation', 'branch', { limit: 100 }).items
    expect(items.find(item => item.id === 'accepted')).toMatchObject({ inputRunId: 'root', runId: null })
    expect(items.find(item => item.id === 'waiting')).not.toHaveProperty('inputRunId')
    expect(items.find(item => item.id === 'foreign')).not.toHaveProperty('inputRunId')
    expect(f.database.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(stored)
  })

  it.each([1, 100])('expands accepted-input-only pages back to their root trigger (limit %s)', (limit) => {
    const f = createExecutionStorageFixture()
    databases.push(f.database)
    const time = (seconds: number) => new Date(Date.UTC(2026, 9, 12, 0, 0, seconds)).toISOString()
    f.conversations.createMessage({ id: 'goal', conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: 'Work together' }, createdAt: time(0) })
    const insert = f.database.prepare('INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let index = 1; index <= limit; index++) {
      const id = `steering-${index}`
      f.conversations.createMessage({ id, conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: id }, createdAt: time(index) })
      insert.run(`queue-${id}`, 'conversation', 'branch', `request-${id}`, 'fixture', JSON.stringify({ userMessageId: id }), 'sent', 'root', time(index))
    }
    const page = f.conversations.listTimelinePage('conversation', 'branch', { limit })
    expect(page.items.map(item => item.id)).toEqual(['goal', ...Array.from({ length: limit }, (_, index) => `steering-${index + 1}`)])
    expect(page.nextBefore).toBeNull()
    expect(f.runs.listForTimeline('conversation', 'branch', page.items.filter(item => item.kind === 'message' && item.role === 'user').map(item => item.id), []).map(run => run.id)).toEqual(['root'])
  })

  it('rolls back conversation creation when its root branch cannot be inserted', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    conversations.create({
      branchId: 'branch-shared',
      createdAt: '2026-08-24T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-existing',
      spaceId: null,
      title: null,
    })

    expect(() => conversations.create({
      branchId: 'branch-shared',
      createdAt: '2026-08-24T00:01:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-rolled-back',
      spaceId: null,
      title: null,
    })).toThrow()
    expect(conversations.findById('conversation-rolled-back')).toBeNull()
  })

  it('projects pending approval ahead of running and returns terminal runs to idle', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)
    conversations.create({
      branchId: 'branch-activity',
      createdAt: '2026-08-20T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-activity',
      spaceId: null,
      title: 'Activity',
    })

    expect(conversations.listRecent()).toMatchObject([
      { activity: 'idle', id: 'conversation-activity' },
    ])

    runs.create({
      branchId: 'branch-activity',
      conversationId: 'conversation-activity',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'run-activity',
      model: 'model-1',
      piSessionFile: null,
      provider: 'provider-1',
      purpose: 'conversation.compaction',
      startedAt: '2026-08-20T00:01:00.000Z',
      status: 'running',
      triggeringMessageId: 'message-activity',
    })
    expect(conversations.listRecent()[0]?.activity).toBe('running')

    database.prepare(`
      INSERT INTO approvals (
        id, run_id, tool_call_id, kind, status, summary,
        payload_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
    `).run(
      'approval-activity',
      'run-activity',
      'tool-activity',
      'shell',
      'Run a command',
      '{}',
      '2026-08-20T00:02:00.000Z',
    )
    expect(conversations.listRecent()[0]?.activity).toBe('awaiting_approval')

    database.prepare(`
      UPDATE approvals SET status = 'approved', resolved_at = ? WHERE id = ?
    `).run('2026-08-20T00:03:00.000Z', 'approval-activity')
    expect(conversations.listRecent()[0]?.activity).toBe('running')

    runs.reconcileTerminal(
      'run-activity',
      'failed',
      '2026-08-20T00:04:00.000Z',
      'MODEL_REQUEST_FAILED',
    )
    expect(conversations.listRecent()[0]?.activity).toBe('idle')
  })

  it('paginates the visible branch lineage without duplicating the page boundary', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    conversations.create({
      branchId: 'branch-root',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: null,
    })
    for (const index of [1, 2, 3, 4, 5]) {
      conversations.createMessage({
        branchId: 'branch-root',
        content: { text: `root-${index}` },
        conversationId: 'conversation-1',
        createdAt: `2026-08-14T00:00:0${index}.000Z`,
        id: `root-${index}`,
        role: index % 2 === 0 ? 'assistant' : 'user',
        runId: null,
      })
    }
    conversations.createBranch({
      activate: true,
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:06.000Z',
      forkedFromMessageId: 'root-4',
      id: 'branch-child',
      parentBranchId: 'branch-root',
    })
    for (const index of [1, 2]) {
      conversations.createMessage({
        branchId: 'branch-child',
        content: { text: `child-${index}` },
        conversationId: 'conversation-1',
        createdAt: `2026-08-14T00:00:0${index + 6}.000Z`,
        id: `child-${index}`,
        role: index % 2 === 0 ? 'assistant' : 'user',
        runId: null,
      })
    }

    const newest = conversations.listMessagePage('conversation-1', 'branch-child', {
      limit: 2,
    })
    expect(newest.items.map(message => message.id)).toEqual(['child-1', 'child-2'])
    expect(newest.nextBeforeMessageId).toBe('child-1')

    expect(Array.from({ length: 7 }, (_, offset) => conversations.findMessageIdAtOffset('conversation-1', 'branch-child', offset)))
      .toEqual(['child-2', 'child-1', 'root-4', 'root-3', 'root-2', 'root-1', null])
    expect(conversations.findMessageIdAtOffset('conversation-1', 'branch-child', Number.MAX_SAFE_INTEGER)).toBeNull()
    expect(() => conversations.findMessageIdAtOffset('conversation-1', 'branch-child', -1)).toThrow(/offset/i)

    const middle = conversations.listMessagePage('conversation-1', 'branch-child', {
      beforeMessageId: newest.nextBeforeMessageId,
      limit: 3,
    })
    expect(middle.items.map(message => message.id)).toEqual(['root-2', 'root-3', 'root-4'])
    expect(middle.nextBeforeMessageId).toBe('root-2')

    const oldest = conversations.listMessagePage('conversation-1', 'branch-child', {
      beforeMessageId: middle.nextBeforeMessageId,
      limit: 3,
    })
    expect(oldest.items.map(message => message.id)).toEqual(['root-1'])
    expect(oldest.nextBeforeMessageId).toBeNull()
    expect(() => conversations.listMessagePage('conversation-1', 'branch-child', {
      beforeMessageId: 'root-5',
      limit: 2,
    })).toThrow(/cursor/i)
  })

  it('locates offsets within public messages on the selected branch lineage', () => {
    const f = createExecutionStorageFixture()
    databases.push(f.database)
    f.executions.admitChild(f.child('npc-child'))
    f.executions.admitChild(f.child('actor-child', f.actor.id))
    const insert = f.database.prepare('INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const [id, runId, role, second] of [
      ['public-old', 'root', 'assistant', '05'],
      ['private-npc', 'npc-child', 'assistant', '07'],
      ['public-shared', 'root', 'user', '10'],
      ['private-actor', 'actor-child', 'user', '11'],
      ['public-actor', 'actor-child', 'assistant', '12'],
    ]) {
      insert.run(id, 'conversation', 'branch', runId, role, JSON.stringify({ text: id }), `2026-10-12T00:00:${second}.000Z`)
    }
    expect(Array.from({ length: 4 }, (_, offset) => f.conversations.findMessageIdAtOffset('conversation', 'branch', offset)))
      .toEqual(['public-actor', 'public-shared', 'public-old', null])
    f.conversations.createBranch({ id: 'fork', conversationId: 'conversation', parentBranchId: 'branch', forkedFromMessageId: 'public-shared', createdAt: '2026-10-12T00:00:20.000Z', activate: true })
    f.conversations.createMessage({ id: 'fork-message', conversationId: 'conversation', branchId: 'fork', runId: null, role: 'user', content: { text: 'fork' }, createdAt: '2026-10-12T00:00:21.000Z' })
    expect(Array.from({ length: 4 }, (_, offset) => f.conversations.findMessageIdAtOffset('conversation', 'fork', offset)))
      .toEqual(['fork-message', 'public-shared', 'public-old', null])
  })

  it('paginates messages and manual compactions through the visible branch lineage', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)
    conversations.create({
      branchId: 'branch-root',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: null,
    })
    for (const index of [1, 2, 3]) {
      conversations.createMessage({
        branchId: 'branch-root',
        content: { text: `root-${index}` },
        conversationId: 'conversation-1',
        createdAt: `2026-08-14T00:00:0${index * 2}.000Z`,
        id: `root-${index}`,
        role: index % 2 === 0 ? 'assistant' : 'user',
        runId: null,
      })
    }
    runs.create({
      branchId: 'branch-root',
      completedAt: '2026-08-14T00:00:03.500Z',
      conversationId: 'conversation-1',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'compact-visible',
      model: 'model-1',
      piSessionFile: '/tmp/session.jsonl',
      provider: 'provider-1',
      purpose: 'conversation.compaction',
      startedAt: '2026-08-14T00:00:02.000Z',
      status: 'completed',
      triggeringMessageId: 'root-1',
    })
    database.prepare(`
      INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at)
      VALUES (?, 1, 'context.compaction.completed', ?, ?)
    `).run(
      'compact-visible',
      JSON.stringify({ estimatedTokensAfter: 700, tokensBefore: 1400 }),
      '2026-08-14T00:00:03.500Z',
    )
    runs.create({
      branchId: 'branch-root',
      completedAt: '2026-08-14T00:00:07.500Z',
      conversationId: 'conversation-1',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'compact-hidden',
      model: 'model-1',
      piSessionFile: '/tmp/session.jsonl',
      provider: 'provider-1',
      purpose: 'conversation.compaction',
      startedAt: '2026-08-14T00:00:07.000Z',
      status: 'completed',
      triggeringMessageId: 'root-2',
    })
    conversations.createBranch({
      activate: true,
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:08.000Z',
      forkedFromMessageId: 'root-2',
      id: 'branch-child',
      parentBranchId: 'branch-root',
    })
    runs.create({
      branchId: 'branch-child',
      completedAt: '2026-08-14T00:00:09.500Z',
      conversationId: 'conversation-1',
      errorCode: 'AUTHENTICATION_REQUIRED',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'compact-child',
      model: 'model-1',
      piSessionFile: '/tmp/session.jsonl',
      provider: 'provider-1',
      purpose: 'conversation.compaction',
      startedAt: '2026-08-14T00:00:09.000Z',
      status: 'failed',
      triggeringMessageId: 'root-2',
    })
    conversations.createMessage({
      branchId: 'branch-child',
      content: { text: 'child' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:10.000Z',
      id: 'child-1',
      role: 'user',
      runId: null,
    })

    const newest = conversations.listTimelinePage('conversation-1', 'branch-child', {
      limit: 3,
    })
    expect(newest.items.map(item => `${item.kind}:${item.id}`)).toEqual([
      'message:root-2',
      'compaction:compact-child',
      'message:child-1',
    ])
    expect(newest.nextBefore).toMatchObject({
      branchId: 'branch-root',
      id: 'root-2',
      kind: 'message',
      occurredAt: '2026-08-14T00:00:04.000Z',
    })

    const oldest = conversations.listTimelinePage('conversation-1', 'branch-child', {
      before: newest.nextBefore,
      limit: 3,
    })
    expect(oldest.items.map(item => `${item.kind}:${item.id}`)).toEqual([
      'message:root-1',
      'compaction:compact-visible',
    ])
    expect(oldest.items[1]).toMatchObject({
      estimatedTokensAfter: 700,
      kind: 'compaction',
      tokensBefore: 1400,
    })
    expect(oldest.nextBefore).toBeNull()
    expect(oldest.items.some(item => item.id === 'compact-hidden')).toBe(false)
  })

  it('extends a timeline page across branch lineage through the triggering user message', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)
    conversations.create({
      branchId: 'branch-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: null,
    })
    conversations.createMessage({
      branchId: 'branch-1',
      content: { text: 'older' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:01.000Z',
      id: 'message-older',
      role: 'user',
      runId: null,
    })
    conversations.createMessage({
      branchId: 'branch-1',
      content: { text: 'trigger' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:02.000Z',
      id: 'message-trigger',
      role: 'user',
      runId: null,
    })
    conversations.createBranch({
      activate: true,
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:02.500Z',
      forkedFromMessageId: 'message-trigger',
      id: 'branch-child',
      parentBranchId: 'branch-1',
    })
    runs.create({
      branchId: 'branch-child',
      conversationId: 'conversation-1',
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      id: 'run-1',
      model: 'model-1',
      piSessionFile: '/tmp/session.jsonl',
      provider: 'provider-1',
      purpose: 'chat',
      startedAt: '2026-08-14T00:00:03.000Z',
      status: 'running',
      triggeringMessageId: 'message-trigger',
    })
    const insertMessage = database.prepare(`
      INSERT INTO messages (
        id, conversation_id, branch_id, run_id, role, content_json, created_at
      ) VALUES (?, 'conversation-1', 'branch-child', 'run-1', 'assistant', ?, ?)
    `)
    const base = Date.parse('2026-08-14T00:00:04.000Z')
    for (let index = 0; index < 220; index += 1) {
      insertMessage.run(
        `reply-${index.toString().padStart(3, '0')}`,
        JSON.stringify({ text: `${index}` }),
        new Date(base + index).toISOString(),
      )
    }

    const newest = conversations.listTimelinePage('conversation-1', 'branch-child', {
      limit: 100,
    })

    expect(newest.items).toHaveLength(221)
    expect(newest.items[0]).toMatchObject({
      id: 'message-trigger',
      kind: 'message',
      role: 'user',
    })
    expect(newest.nextBefore).toMatchObject({
      id: 'message-trigger',
      kind: 'message',
    })
    expect(conversations.listTimelinePage('conversation-1', 'branch-child', {
      before: newest.nextBefore,
      limit: 100,
    }).items.map(item => item.id)).toEqual(['message-older'])
  })

  it('rejects a timeline turn that exceeds the bounded page expansion', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)
    conversations.create({
      branchId: 'branch-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: null,
    })
    conversations.createMessage({
      branchId: 'branch-1',
      content: { text: 'trigger' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:01.000Z',
      id: 'message-trigger',
      role: 'user',
      runId: null,
    })
    runs.create({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      id: 'run-1',
      model: 'model-1',
      piSessionFile: '/tmp/session.jsonl',
      provider: 'provider-1',
      purpose: 'chat',
      startedAt: '2026-08-14T00:00:02.000Z',
      status: 'running',
      triggeringMessageId: 'message-trigger',
    })
    const insertMessage = database.prepare(`
      INSERT INTO messages (
        id, conversation_id, branch_id, run_id, role, content_json, created_at
      ) VALUES (?, 'conversation-1', 'branch-1', 'run-1', 'assistant', ?, ?)
    `)
    const base = Date.parse('2026-08-14T00:00:03.000Z')
    for (let index = 0; index < 1_000; index += 1) {
      insertMessage.run(
        `reply-${index.toString().padStart(4, '0')}`,
        JSON.stringify({ text: `${index}` }),
        new Date(base + index).toISOString(),
      )
    }

    expect(() => conversations.listTimelinePage('conversation-1', 'branch-1', {
      limit: 100,
    })).toThrow('turn exceeds timeline page limit')
  })

  it('bounds tool-heavy history pages without dropping stored messages', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    conversations.create({
      branchId: 'branch-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: null,
    })
    const insert = database.prepare(`
      INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at)
      VALUES (?, 'conversation-1', 'branch-1', NULL, ?, ?, ?)
    `)
    const time = (index: number) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + index).toISOString()
    for (let index = 0; index < 150; index++) {
      insert.run(`message-${index}`, index % 2 ? 'assistant' : 'user', JSON.stringify({ text: `${index}` }), time(index * 20))
      for (let tool = 1; tool <= 10; tool++)
        insert.run(`tool-${index}-${tool}`, 'tool', JSON.stringify({ text: 'stored tool result' }), time(index * 20 + tool))
    }

    let page = conversations.listTimelinePage('conversation-1', 'branch-1', { limit: 100 })
    const ids = page.items.map(item => item.id)
    expect(page.items).toHaveLength(100)
    for (let index = 0; page.nextBefore && index < 20; index++) {
      page = conversations.listTimelinePage('conversation-1', 'branch-1', { before: page.nextBefore, limit: 100 })
      expect(page.items.length).toBeLessThanOrEqual(100)
      ids.unshift(...page.items.map(item => item.id))
    }
    expect(page.nextBefore).toBeNull()
    const stored = conversations.listMessages('conversation-1', 'branch-1', 1650)
    expect(ids).toEqual(stored.map(message => message.id))
    expect(new Set(ids).size).toBe(1650)
    expect(stored.filter(message => message.role === 'tool')).toHaveLength(1500)
  })

  it('activates an owned branch and rejects foreign branches', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    conversations.create({
      branchId: 'branch-root',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: null,
    })
    conversations.createBranch({
      activate: true,
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:01.000Z',
      forkedFromMessageId: null,
      id: 'branch-second',
      parentBranchId: null,
    })
    conversations.create({
      branchId: 'branch-foreign',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-2',
      spaceId: null,
      title: null,
    })

    expect(conversations.activateBranch({
      branchId: 'branch-root',
      conversationId: 'conversation-1',
      updatedAt: '2026-08-15T00:00:00.000Z',
    })).toMatchObject({
      activeBranchId: 'branch-root',
      id: 'conversation-1',
      updatedAt: '2026-08-15T00:00:00.000Z',
    })
    expect(() => conversations.activateBranch({
      branchId: 'branch-foreign',
      conversationId: 'conversation-1',
      updatedAt: '2026-08-15T00:00:01.000Z',
    })).toThrow(/branch is not activatable/i)
  })

  it('does not switch branches while a conversation run is incomplete', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)
    conversations.create({
      branchId: 'branch-root',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: null,
    })
    conversations.createBranch({
      activate: false,
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:01.000Z',
      forkedFromMessageId: null,
      id: 'branch-second',
      parentBranchId: null,
    })
    conversations.createMessage({
      branchId: 'branch-root',
      content: { text: 'hello' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:02.000Z',
      id: 'message-1',
      role: 'user',
      runId: null,
    })
    runs.create({
      branchId: 'branch-root',
      conversationId: 'conversation-1',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'run-1',
      model: 'model-1',
      piSessionFile: null,
      provider: 'provider-1',
      purpose: 'chat',
      startedAt: '2026-08-14T00:00:03.000Z',
      status: 'running',
      triggeringMessageId: 'message-1',
    })

    expect(() => conversations.activateBranch({
      branchId: 'branch-second',
      conversationId: 'conversation-1',
      updatedAt: '2026-08-15T00:00:00.000Z',
    })).toThrow(/branch is not activatable/i)
    expect(conversations.findById('conversation-1')?.activeBranchId).toBe('branch-root')
  })
})

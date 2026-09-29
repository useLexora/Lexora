import { expect, it } from 'vitest'
import { createConversationHistoryStore } from '../conversationHistoryRepository'
import { createConversationRepository } from '../conversationRepository'
import { createConversationTimelineRepository } from '../conversationTimelineRepository'
import { openBuddyDatabase } from '../database'
import { createExtensionInvocationRepository } from '../extensionInvocationRepository'

it('persists independent action results, pages late actions without expanding old turns and isolates branches', () => {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  try {
    createConversationRepository(database).create({ id: 'task', branchId: 'root', title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: '2026-09-28T00:00:00.000Z' })
    const history = createConversationHistoryStore(database)
    history.repository.createMessage({ id: 'question', conversationId: 'task', branchId: 'root', runId: null, role: 'user', content: 'Fixture', createdAt: '2026-09-28T00:01:00.000Z' })
    const actions = createExtensionInvocationRepository(database)
    const timeline = createConversationTimelineRepository(database, history.lineage)
    const start = (id: string, trigger: 'user' | 'task:input:committed' = 'user', branchId = 'root') => actions.start({ id, extensionId: 'tests.action', extensionName: 'Naming', actionId: 'tests.action.generate', title: 'Generate title', conversationId: 'task', branchId, sourceMessageId: 'question', trigger, startedAt: '2026-09-29T00:00:00.000Z' })
    start('complete')
    actions.finish('complete', 'completed', 'Title updated')
    start('skipped', 'task:input:committed')
    expect(timeline.listTimelinePage('task', 'root', { limit: 100 }).items.find(item => item.id === 'skipped')).toMatchObject({ status: 'running' })
    actions.finish('skipped', 'skipped')
    start('manual-skip')
    actions.finish('manual-skip', 'skipped', 'Kept title')
    start('interrupted')
    actions.recover()
    history.repository.createBranch({ id: 'child', conversationId: 'task', parentBranchId: 'root', forkedFromMessageId: 'question', createdAt: '2026-09-28T00:02:00.000Z', activate: false })
    start('child-action', 'user', 'child')
    actions.finish('child-action', 'failed')
    expect(timeline.listTimelinePage('task', 'child', { limit: 100 }).items.map(item => item.id)).toEqual(['question', 'child-action'])
    const items = timeline.listTimelinePage('task', 'root', { limit: 100 }).items
    expect(items.map(item => item.id)).toEqual(['question', 'complete', 'interrupted', 'manual-skip', 'skipped'])
    expect(items.find(item => item.id === 'skipped')).toMatchObject({ status: 'skipped', trigger: 'task:input:committed' })
    expect(items.find(item => item.id === 'complete')).toMatchObject({ kind: 'extension-action', extensionName: 'Naming', title: 'Generate title', status: 'completed', message: 'Title updated', sourceMessageId: 'question' })
    expect(items.find(item => item.id === 'interrupted')).toMatchObject({ status: 'interrupted' })
    const latest = timeline.listTimelinePage('task', 'root', { limit: 1 })
    expect(latest.items.map(item => item.id)).toEqual(['skipped'])
    expect(timeline.listTimelinePage('task', 'root', { limit: 1, before: latest.nextBefore }).items.map(item => item.id)).toEqual(['manual-skip'])
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }
  finally { database.close() }
})

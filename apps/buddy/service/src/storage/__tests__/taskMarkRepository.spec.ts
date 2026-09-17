import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SYSTEM_UNREAD_MARK_ID } from '../../../../shared/conversation/taskMarkApi'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createRunRepository } from '../runRepository'
import { BUDDY_SCHEMA_MIGRATIONS } from '../schema'
import { createTaskMarkRepository } from '../taskMarkRepository'
import { MIGRATION_TEST_TIMEOUT, openMigrationFixtureDatabase } from './migrationFixture'

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  databases.splice(0).forEach(database => database.close())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})
const now = '2026-09-12T00:00:00.000Z'
const mark = { name: '需要验证', description: '结果需人工检查', color: '#d49326' }

function seed(database: DatabaseSync) {
  const conversations = createConversationRepository(database)
  for (const id of ['a', 'b']) {
    conversations.create({ id, branchId: `branch-${id}`, title: id, createdAt: now, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    conversations.createMessage({ id: `question-${id}`, branchId: `branch-${id}`, conversationId: id, runId: null, role: 'user', content: { text: '测试内容' }, createdAt: now })
  }
  const runs = createRunRepository(database)
  function run(id: string, status: 'running' | 'completed' | 'failed' | 'cancelled' = 'completed', purpose: 'chat' | 'conversation.compaction' = 'chat', conversationId = 'a') {
    return runs.create({ id, branchId: `branch-${conversationId}`, conversationId, triggeringMessageId: `question-${conversationId}`, provider: 'fixture', model: 'fixture', piSessionFile: null, purpose, status, startedAt: now, completedAt: status === 'running' ? null : now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  }
  return { conversations, runs, run }
}

function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  return { database, ...seed(database), marks: createTaskMarkRepository(database) }
}

describe('task marks and reading state', () => {
  it('allows duplicate names, replaces a single assignment and clears both marks without affecting other tasks or their order', () => {
    const f = fixture()
    const before = f.conversations.listRecent()
    const first = f.marks.create(mark)
    const second = f.marks.create(mark)
    expect(first.id).not.toBe(second.id)
    expect(f.marks.list().map(item => item.name)).toEqual([mark.name, mark.name])
    f.marks.assign('a', first.id)
    f.run('result-a')
    expect(f.marks.getState('a')).toMatchObject({ markId: first.id, unread: true, resultRunId: 'result-a' })
    f.marks.assign('a', second.id)
    expect(f.marks.list().find(item => item.id === first.id)?.taskCount).toBe(0)
    expect(f.marks.list().find(item => item.id === second.id)?.taskCount).toBe(1)
    f.marks.assign('b', second.id)
    f.run('result-b', 'completed', 'chat', 'b')
    const other = f.marks.getState('b')
    expect(f.marks.clear(f.marks.getState('a'))).toMatchObject({ markId: null, unread: false, resultRunId: 'result-a' })
    expect(f.marks.getState('b')).toEqual(other)
    expect(f.marks.list().find(item => item.id === second.id)?.taskCount).toBe(1)
    expect(f.marks.list()).toHaveLength(2)
    expect(f.conversations.listRecent()).toEqual(before)
    f.run('next-result')
    expect(f.marks.getState('a')).toMatchObject({ markId: null, unread: true, resultRunId: 'next-result' })
  })

  it.each(['automatic', 'manual'] as const)('clears %s unread without a custom mark', (kind) => {
    const f = fixture()
    if (kind === 'automatic')
      f.run('result')
    else f.marks.setRead({ ...f.marks.getState('a'), read: false })
    const before = f.marks.getState('a')
    expect(before).toMatchObject({ markId: null, unread: true })
    const cleared = f.marks.clear(before)
    expect(cleared).toMatchObject({ markId: null, unread: false, readRevision: before.readRevision + 1 })
    expect(f.marks.clear(before)).toEqual(cleared)
  })

  it('does not clear later results or later manual unread with a stale clear request', () => {
    const f = fixture()
    const custom = f.marks.create(mark)
    f.marks.assign('a', custom.id)
    f.run('first')
    const first = f.marks.getState('a')
    f.run('second')
    expect(f.marks.clear(first)).toMatchObject({ markId: null, unread: true, resultRunId: 'second' })
    f.marks.assign('a', custom.id)
    const second = f.marks.getState('a')
    const manual = f.marks.setRead({ ...second, read: false })
    expect(f.marks.clear(second)).toMatchObject({ markId: null, unread: true, readRevision: manual.readRevision })
  })

  it('rolls back both changes on clear failure and allows a safe retry', () => {
    const f = fixture()
    const custom = f.marks.create(mark)
    f.marks.assign('a', custom.id)
    f.run('result')
    const before = f.marks.getState('a')
    f.database.exec(`
      CREATE TRIGGER reject_clear BEFORE UPDATE OF seen_run_id ON task_attention
      BEGIN SELECT RAISE(ABORT, 'clear failed'); END
    `)
    expect(() => f.marks.clear(before)).toThrow('clear failed')
    expect(f.marks.getState('a')).toEqual(before)
    expect(f.marks.list()[0]?.taskCount).toBe(1)
    f.database.exec('DROP TRIGGER reject_clear')
    expect(f.marks.clear(before)).toMatchObject({ markId: null, unread: false })
    expect(f.marks.list()[0]?.taskCount).toBe(0)
  })

  it('retains a custom mark after reading, and protects newer results and manual unread from stale read requests', () => {
    const f = fixture()
    const custom = f.marks.create(mark)
    f.marks.assign('a', custom.id)
    f.run('first')
    const first = f.marks.getState('a')
    f.marks.setRead({ ...first, read: true })
    expect(f.marks.getState('a')).toMatchObject({ markId: custom.id, unread: false })
    f.run('second')
    f.marks.setRead({ ...first, read: true })
    expect(f.marks.getState('a')).toMatchObject({ resultRunId: 'second', unread: true })
    const second = f.marks.getState('a')
    f.marks.setRead({ ...second, read: true })
    f.marks.setRead({ ...second, read: false })
    f.marks.setRead({ ...second, read: true })
    expect(f.marks.getState('a')).toMatchObject({ markId: custom.id, unread: true })
  })

  it('observes terminal results, not queued work, compaction or cancellation', () => {
    const f = fixture()
    f.run('active', 'running')
    expect(f.marks.getState('a').unread).toBe(false)
    f.runs.reconcileTerminal('active', 'completed', now, null)
    expect(f.marks.getState('a')).toMatchObject({ resultRunId: 'active', unread: true })
    f.marks.setRead({ ...f.marks.getState('a'), read: true })
    f.run('compaction', 'completed', 'conversation.compaction')
    f.run('cancelled', 'cancelled')
    expect(f.marks.getState('a').unread).toBe(false)
    f.run('failure', 'failed')
    expect(f.marks.getState('a')).toMatchObject({ resultRunId: 'failure', unread: true })
  })

  it('updates shared definitions by ID and deletes only associations, excluding deleted tasks', () => {
    const f = fixture()
    const first = f.marks.create(mark)
    f.marks.assign('a', first.id)
    f.marks.assign('b', first.id)
    f.run('result')
    const beforeMessages = f.database.prepare('SELECT * FROM messages').all()
    const beforeTasks = f.database.prepare('SELECT * FROM conversations').all()
    expect(f.marks.update(first.id, { ...mark, name: '稍后看', color: '#3979d6' })).toMatchObject({ name: '稍后看', taskCount: 2 })
    f.marks.delete(first.id)
    expect(f.marks.getState('a')).toMatchObject({ markId: null, unread: true })
    expect(f.marks.getState('b')).toMatchObject({ markId: null, unread: false })
    expect(f.database.prepare('SELECT * FROM messages').all()).toEqual(beforeMessages)
    expect(f.database.prepare('SELECT * FROM conversations').all()).toEqual(beforeTasks)
    expect(f.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const next = f.marks.create(mark)
    f.marks.assign('a', next.id)
    f.conversations.markDeleted('a', now)
    expect(f.marks.list()[0]?.taskCount).toBe(0)
    expect(f.marks.states(['a', 'b']).map(item => item.conversationId)).toEqual(['b'])
    expect(() => f.marks.assign('a', null)).toThrow()
    expect(() => f.marks.clear({ conversationId: 'a', resultRunId: 'result', readRevision: 0 })).toThrow()
    expect(() => f.marks.setRead({ conversationId: 'a', resultRunId: 'result', readRevision: 0, read: true })).toThrow()
  })

  it('protects the system identity even when a custom mark has the same name', () => {
    const f = fixture()
    const custom = f.marks.create({ ...mark, name: '未读' })
    expect(custom.id).not.toBe(SYSTEM_UNREAD_MARK_ID)
    for (const action of [() => f.marks.update(SYSTEM_UNREAD_MARK_ID, mark), () => f.marks.delete(SYSTEM_UNREAD_MARK_ID), () => f.marks.assign('a', SYSTEM_UNREAD_MARK_ID)])
      expect(action).toThrow()
    expect(f.marks.list()).toHaveLength(1)
  })

  it('migrates existing results as read, preserves history and persists new unread and assignments across restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-task-marks-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(item => item.version <= 11)) {
      legacy.exec(migration.sql)
      legacy.exec(`PRAGMA user_version = ${migration.version}`)
    }
    seed(legacy).run('historical')
    const history = legacy.prepare('SELECT * FROM conversations').all()
    legacy.close()
    const migrated = openBuddyDatabase({ databasePath })
    const marks = createTaskMarkRepository(migrated)
    expect(marks.getState('a')).toMatchObject({ resultRunId: 'historical', unread: false })
    expect(migrated.prepare('SELECT * FROM conversations').all()).toEqual(history)
    const custom = marks.create(mark)
    marks.assign('a', custom.id)
    marks.setRead({ ...marks.getState('a'), read: false })
    migrated.close()
    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(createTaskMarkRepository(reopened).getState('a')).toMatchObject({ markId: custom.id, unread: true })
    expect(reopened.prepare('SELECT * FROM conversations').all()).toEqual(history)
  }, MIGRATION_TEST_TIMEOUT)
})

import type { DatabaseSync } from 'node:sqlite'
import type { RunSqlReconciliation } from '../../runs/RunLifecycleService'
import type { TaskAttentionChange } from '../TaskAttentionProjection'
import type { TaskMarkCommit } from '../TaskMarkService'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunEventLog } from '../../events/createRunEventLog'
import { RunEventProjectionError } from '../../events/RunEventFailure'
import { RunLifecycleService } from '../../runs/RunLifecycleService'
import { createConversationDeletionRepository } from '../../storage/conversationDeletionRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { createTaskMarkRepository } from '../../storage/taskMarkRepository'
import { ConversationLifecycleService } from '../ConversationLifecycleService'
import { TaskAttentionProjection } from '../TaskAttentionProjection'
import { TaskMarkService } from '../TaskMarkService'

const databases: DatabaseSync[] = []
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of cleanup.splice(0))
    await stop()
  for (const database of databases.splice(0))
    database.close()
})

describe('task mark commits and effective attention', () => {
  it('reacts to actual SQL fallback without presenting a failed durable projection as a terminal commit', async () => {
    const f = await fixture()
    const events: RunSqlReconciliation[] = []
    const changes: TaskAttentionChange[] = []
    f.lifecycle.onDidReconcile(event => events.push(event))
    f.attention.onDidChange(event => changes.push(event))
    f.start('sql-only')
    vi.spyOn(f.eventLog, 'append').mockRejectedValueOnce(new Error('Nonfatal fixture append refusal'))
    await f.lifecycle.finalize({ runId: 'sql-only', status: 'completed', errorCode: null, completedAt: '2026-09-28T00:01:00.000Z' })
    expect(events).toMatchObject([{ runId: 'sql-only', status: 'failed', errorCode: 'EVENT_LOG_FAILED' }])
    expect(changes.at(-1)?.conversationIds).toEqual(['a'])
    expect(f.attention.states(['a'])[0]).toMatchObject({ resultRunId: 'sql-only', unread: true })
    expect(f.eventLog.listForRuns(['sql-only'])).toEqual([])
    f.start('fatal')
    vi.spyOn(f.eventLog, 'append').mockRejectedValueOnce(new RunEventProjectionError('fatal', []))
    await expect(f.lifecycle.finalize({ runId: 'fatal', status: 'completed', errorCode: null, completedAt: '2026-09-28T00:02:00.000Z' })).rejects.toBeInstanceOf(RunEventProjectionError)
    expect(f.runs.findById('fatal')?.status).toBe('running')
    expect(events).toHaveLength(1)
    expect(f.attention.states(['a'])[0]?.resultRunId).toBe('sql-only')
  })

  it('observes new durable results independently of readRevision and distinguishes stale clear from read', async () => {
    const f = await fixture()
    const commits: TaskMarkCommit[] = []
    const changes: TaskAttentionChange[] = []
    f.marks.onDidCommit(event => commits.push(event))
    f.attention.onDidChange(event => changes.push(event))
    const mark = f.marks.create({ name: 'Review', description: '', color: '#3979d6' })
    f.marks.assign('a', mark.id)
    await f.complete('result-1')
    const first = f.attention.states(['a'])[0]!
    const read = f.marks.setRead({ ...first, read: true })
    await f.complete('result-2')
    const second = f.attention.states(['a'])[0]!
    expect(second).toMatchObject({ resultRunId: 'result-2', readRevision: read.readRevision, unread: true })
    const cleared = f.marks.clear(read)
    expect(cleared).toMatchObject({ markId: null, unread: true, readRevision: read.readRevision, resultRunId: 'result-2' })
    expect(commits.at(-1)).toMatchObject({ kind: 'attention', assignmentChanged: true, readChanged: false })
    expect(f.attention.list()[0]?.taskCount).toBe(0)
    expect(changes.filter(event => event.conversationIds.includes('a')).length).toBeGreaterThanOrEqual(5)
    expect(Reflect.set(second, 'unread', false)).toBe(false)
    const count = commits.length
    f.marks.setRead({ ...read, read: true })
    expect(commits).toHaveLength(count)
  })

  it('captures all foreign-key assignment removals and excludes tombstoned tasks from counts', async () => {
    const f = await fixture()
    const commits: TaskMarkCommit[] = []
    f.marks.onDidCommit(event => commits.push(event))
    const input = { name: 'Review', description: '', color: '#3979d6' }
    const mark = f.marks.create(input)
    f.marks.assign('a', mark.id)
    f.marks.assign('b', mark.id)
    f.marks.update(mark.id, input)
    expect(commits.filter(event => event.kind === 'updated')).toEqual([])
    expect(f.attention.list()[0]?.taskCount).toBe(2)
    f.marks.delete(mark.id)
    expect(commits.at(-1)).toMatchObject({ kind: 'deleted', conversationIds: ['a', 'b'] })
    expect(f.attention.states(['a', 'b']).map(state => state.markId)).toEqual([null, null])
    const next = f.marks.create(input)
    f.marks.assign('a', next.id)
    await f.deletion.delete('a')
    expect(f.attention.list()[0]?.taskCount).toBe(0)
    expect(f.attention.states(['a', 'b']).map(state => state.conversationId)).toEqual(['b'])
  })

  it('retains a committed assignment when a consumer fails and rebuilds before serving degraded reads', async () => {
    const f = await fixture()
    const mark = f.marks.create({ name: 'Review', description: '', color: '#3979d6' })
    vi.spyOn(f.repository, 'states').mockImplementationOnce(() => {
      throw new Error('Projection read failed')
    })
    expect(f.marks.assign('a', mark.id)).toMatchObject({ markId: mark.id })
    expect(f.attention.state).toBe('degraded')
    expect(f.errors).toHaveBeenCalledTimes(1)
    expect(f.attention.list()[0]?.taskCount).toBe(1)
    expect(f.attention.state).toBe('ready')
    expect(f.attention.states(['a'])[0]?.markId).toBe(mark.id)
    const changes: TaskAttentionChange[] = []
    f.attention.onDidChange(event => changes.push(event))
    f.attention.dispose()
    f.marks.assign('a', null)
    expect(changes).toEqual([])
    expect(f.attention.state).toBe('stopped')
  })
})

async function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const root = await mkdtemp(join(tmpdir(), 'lexora-task-attention-'))
  const conversations = createConversationRepository(database)
  const now = '2026-09-28T00:00:00.000Z'
  for (const id of ['a', 'b']) {
    conversations.create({ id, branchId: `branch-${id}`, title: id, createdAt: now, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    conversations.createMessage({ id: `question-${id}`, branchId: `branch-${id}`, conversationId: id, runId: null, role: 'user', content: { text: 'Test' }, createdAt: now })
  }
  const runs = createRunRepository(database)
  const repository = createTaskMarkRepository(database)
  const marks = new TaskMarkService(repository)
  const eventLog = createRunEventLog({ conversationsDirectory: join(root, 'conversations'), database })
  const deletion = new ConversationLifecycleService({
    conversations,
    deletion: createConversationDeletionRepository(database),
    runner: { cancelAndWaitForConversation: async () => 0 },
    cancelQueuedRuns: async () => {},
    sessions: { invalidateConversation: async () => ({ pending: 0, degraded: 0 }) },
  })
  const errors = vi.fn()
  const attention = new TaskAttentionProjection({ marks, eventLog, runs, repository, onError: errors })
  const lifecycle = new RunLifecycleService({ eventLog, repository: runs })
  attention.start(deletion, lifecycle)
  cleanup.push(async () => {
    attention.dispose()
    marks.dispose()
    await deletion.dispose()
    await lifecycle.dispose()
    await eventLog.close()
    await rm(root, { recursive: true, force: true })
  })
  function start(id: string) {
    runs.create({ id, branchId: 'branch-a', conversationId: 'a', triggeringMessageId: 'question-a', provider: 'fixture', model: 'fixture', piSessionFile: null, purpose: 'chat', status: 'running', startedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  }
  async function complete(id: string) {
    start(id)
    await eventLog.append({ runId: id, type: 'run.completed', payload: {} })
  }
  return { marks, attention, complete, deletion, repository, errors, start, eventLog, lifecycle, runs }
}

import type { DatabaseSync } from 'node:sqlite'
import type { PrepareTurnRequestInput } from '../turnRequestRepository'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { productBranchSchema, productPageSchema } from '../../../../shared/productProtocol/queries'
import { ProductQueries } from '../../productProtocol/ProductQueries'
import { ChatControlCommandRepository } from '../ChatControlCommandRepository'
import { createChatQueueRepository } from '../chatQueueRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase, openBuddyMigrationCandidate } from '../database'
import { createExecutionRepository, executionFence } from '../executionRepository'
import { createRunRepository } from '../runRepository'
import { actorThreadId, createThreadBindingRepository } from '../threadBindingRepository'
import { createTurnRequestRepository, TurnRequestConflictError } from '../turnRequestRepository'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})
const now = '2026-11-09T00:00:00.000Z'
function input(id: string, branchId: string): PrepareTurnRequestInput {
  return { conversationId: 'conversation', branchId, spaceId: null, createdAt: now, draft: null, requestId: `request-${id}`, requestFingerprint: id, runId: id, userMessageId: `input-${id}`, title: null, userMessageContent: { userContent: createBuddyUserContent(id), resourceSnapshots: [] }, approvalPolicy: 'policy', executionProfile: 'workspace_write', attachmentBindings: [], provider: 'fixture', model: 'fixture', runInput: { attachmentIds: [], contextItems: [], prompt: id, reasoning: null, serviceTier: null } }
}
function fixture() {
  const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  cleanups.push(() => database.close())
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const conversations = createConversationRepository(database)
  conversations.create({ id: 'conversation', branchId: 'A', spaceId: null, title: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  conversations.createBranch({ id: 'B', conversationId: 'conversation', parentBranchId: null, forkedFromMessageId: null, createdAt: now, activate: false })
  return { database, conversations, turns: createTurnRequestRepository(database), runs: createRunRepository(database), queue: createChatQueueRepository(database), executions: createExecutionRepository(database) }
}
function rows(database: DatabaseSync) {
  return {
    runs: database.prepare('SELECT id, branch_id, thread_id, pi_session_file FROM runs ORDER BY id').all(),
    threads: database.prepare('SELECT * FROM execution_threads ORDER BY id').all(),
    bindings: database.prepare('SELECT * FROM execution_thread_bindings ORDER BY thread_id').all(),
  }
}

describe('independent conversation branches', () => {
  it('admits two root branches with distinct threads while preserving the same-branch lane fence', () => {
    const f = fixture()
    f.turns.prepare({ ...input('run-A', 'A'), expectedActorModelSelection: null })
    f.turns.prepare({ ...input('run-B', 'B'), expectedActorModelSelection: null })
    const a = f.runs.findById('run-A')!
    const b = f.runs.findById('run-B')!
    expect(a.threadId).not.toBe(b.threadId)
    expect(() => f.turns.prepare(input('duplicate-A', 'A'))).toThrow(TurnRequestConflictError)
    expect(() => f.turns.prepare(input('foreign', 'missing'))).toThrow(TurnRequestConflictError)
    f.conversations.activateBranch({ conversationId: 'conversation', branchId: 'B', updatedAt: now })
    for (const runId of ['run-A', 'run-B']) {
      const execution = f.executions.find(runId)!
      expect(() => f.executions.assertCurrent(executionFence(execution, execution))).not.toThrow()
    }
    f.runs.reconcileTerminal('run-A', 'cancelled', now, null)
    const live = f.executions.find('run-B')!
    expect(() => f.executions.assertCurrent(executionFence(live, live))).not.toThrow()
    expect(f.runs.findById('run-B')?.status).toBe('queued')
  })

  it('keeps queue lookup, cancellation and recovery on the explicit branch and reports public branch counts', () => {
    const f = fixture()
    f.turns.prepare(input('run-A', 'A'))
    f.turns.prepare(input('run-B', 'B'))
    f.queue.enqueue(input('queued-A', 'A'))
    f.queue.enqueue(input('queued-B', 'B'))
    const a = { conversationId: 'conversation', branchId: 'A' }
    const b = { conversationId: 'conversation', branchId: 'B' }
    expect(f.queue.activeRun(a, 'default')?.id).toBe('run-A')
    expect(f.queue.latestRun(b, 'default')?.id).toBe('run-B')
    expect(f.queue.continuationScopes()).toEqual([a, b])
    expect(f.queue.continuationScope(b)).toEqual(b)
    f.queue.pause(a.conversationId, a.branchId)
    expect(f.queue.list(a)[0]?.state).toBe('paused')
    expect(f.queue.list(b)[0]?.state).toBe('waiting')
    const queries = new ProductQueries(f.database, 'desktop-local', 'instance')
    const branches = productPageSchema(productBranchSchema).parse(queries.read('conversations.listBranches', { conversationId: 'conversation', limit: 100, cursor: null }))
    expect(branches.items.map(branch => ({ id: branch.id, runningCount: branch.runningCount, queuedCount: branch.queuedCount }))).toEqual([{ id: 'A', runningCount: 1, queuedCount: 1 }, { id: 'B', runningCount: 1, queuedCount: 1 }])
  })

  it('forks edit and regenerate from explicit immutable sources without moving the default or blocking another running branch', () => {
    const f = fixture()
    f.turns.prepare(input('source', 'A'))
    f.runs.reconcileTerminal('source', 'completed', now, null)
    f.turns.prepare(input('run-B', 'B'))
    const fork = f.turns.edit({ ...input('edit', 'edit-branch'), parentBranchId: 'A', sourceUserMessageId: 'input-source', forkedFromMessageId: null })
    expect(fork.branchId).toBe('edit-branch')
    expect(f.runs.findById('run-B')?.status).toBe('queued')
    const model = f.conversations.findById('conversation')!.modelSelection
    const retry = f.turns.regenerate({ conversationId: 'conversation', parentBranchId: 'A', branchId: 'retry-branch', sourceRunId: 'source', forkedFromMessageId: 'input-source', requestId: 'retry', requestFingerprint: 'retry', runId: 'retry', createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', provider: 'fixture', model: 'fixture', reasoning: null, serviceTier: null, expectedModelSelection: model })
    expect(retry.branchId).toBe('retry-branch')
    expect(f.conversations.findById('conversation')?.activeBranchId).toBe('A')
    expect(new Set(f.runs.listForConversation('conversation').map(run => run.threadId)).size).toBe(4)
    expect(() => f.turns.edit({ ...input('wrong-edit', 'wrong-branch'), parentBranchId: 'B', sourceUserMessageId: 'input-source', forkedFromMessageId: null })).toThrow(TurnRequestConflictError)
  })

  it('exposes public actor execution controls while hiding NPC ids, events and states', () => {
    const f = fixture()
    f.turns.prepare(input('root', 'A'))
    const root = f.runs.findById('root')!
    f.runs.create({ ...root, id: 'actor', rootRunId: root.id, parentRunId: root.id, executionKind: 'actor_child', threadId: createThreadBindingRepository(f.database).createIsolated('conversation', 'default', 'actor', now).id })
    f.runs.create({ ...root, id: 'npc', rootRunId: root.id, parentRunId: root.id, executionKind: 'npc_child', threadId: createThreadBindingRepository(f.database).createIsolated('conversation', 'default', 'npc', now).id })
    const queries = new ProductQueries(f.database, 'desktop-local', 'instance')
    expect(queries.read('runs.get', { runId: 'npc' })).toBeNull()
    expect(queries.read('runs.getExecutionState', { runId: 'npc' })).toBeNull()
    expect(queries.read('runs.listEvents', { runId: 'npc', limit: 100, cursor: null })).toEqual({ items: [], nextCursor: null })
    expect(queries.read('runs.get', { runId: 'actor' })).toMatchObject({ id: 'actor', executionKind: 'actor_child' })
    expect(queries.read('runs.list', { conversationId: 'conversation', branchId: 'A', limit: 100, cursor: null })).toMatchObject({ items: [{ id: 'root' }, { id: 'actor' }] })
    const branches = productPageSchema(productBranchSchema).parse(queries.read('conversations.listBranches', { conversationId: 'conversation', limit: 100, cursor: null }))
    expect(branches.items.find(branch => branch.id === 'A')?.runningCount).toBe(2)
    const control = new ChatControlCommandRepository(f.database, 'instance')
    expect(control.cancelRun({ runId: 'actor', expectedRunGeneration: 0 }).result.cancelRequested).toBe(true)
    expect(f.executions.find('actor')?.cancelRequestedAt).not.toBeNull()
    expect(f.executions.find('root')?.cancelRequestedAt).toBeNull()
    expect(f.executions.find('npc')?.cancelRequestedAt).toBeNull()
  })

  it('upgrades existing bindings without rewriting runs, threads or session bytes and writes new work to branch threads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-branch-upgrade-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'buddy.sqlite3')
    const sessionFile = join(directory, 'legacy.jsonl')
    writeFileSync(sessionFile, '{"legacy":"keep exactly"}\n')
    let database = openBuddyDatabase({ databasePath: path })
    const conversations = createConversationRepository(database)
    conversations.create({ id: 'conversation', branchId: 'A', spaceId: null, title: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
    const run = createRunRepository(database).create({ id: 'legacy', conversationId: 'conversation', branchId: 'A', triggeringMessageId: 'old-input', provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'completed', piSessionFile: sessionFile, startedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    createThreadBindingRepository(database).bind(run.threadId, sessionFile, 'legacy-root')
    const before = rows(database)
    const bytes = readFileSync(sessionFile)
    database.close()
    database = openBuddyMigrationCandidate({ databasePath: path })
    cleanups.push(() => database.close())
    expect(rows(database)).toEqual(before)
    createTurnRequestRepository(database).prepare(input('new-A', 'A'))
    expect(createRunRepository(database).findById('new-A')?.threadId).toBe(actorThreadId('conversation', 'default', 'A'))
    expect(createRunRepository(database).findById('new-A')?.piSessionFile).toBeNull()
    expect(createRunRepository(database).findById('legacy')?.threadId).toBe(run.threadId)
    expect(readFileSync(sessionFile)).toEqual(bytes)
  })
})

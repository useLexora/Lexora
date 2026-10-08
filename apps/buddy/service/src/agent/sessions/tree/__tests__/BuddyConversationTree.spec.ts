import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { RunRecord } from '../../../../storage/runRecord'
import type { BuddySessionRecoveryService } from '../../recovery/BuddySessionRecoveryService'
import type { BuddyTreeCommit, BuddyTreeFailure } from '../BuddyTreeEvents'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConversationRepository } from '../../../../storage/conversationRepository'
import { createConversationTreeRepository } from '../../../../storage/conversationTreeRepository'
import { openBuddyDatabase } from '../../../../storage/database'
import { createRunRepository } from '../../../../storage/runRepository'
import { createBuddyInputReferenceMessage } from '../../../context/BuddyInputReference'
import { createIsolatedBuddySession } from '../../__tests__/isolatedBuddySession'
import { createBuddySession } from '../../createBuddySession'
import { BuddyConversationTree } from '../BuddyConversationTree'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('native conversation tree', () => {
  it('counts separate tool invocations when a provider reuses a call ID across steps', async () => {
    const fixture = await createFixture()
    const run = fixture.run('reused-tools', 'b0', 'q1')
    for (let sequence = 1; sequence <= 2; sequence++)
      fixture.toolEvent(run.id, sequence, 'provider-call')
    expect(fixture.repository.listToolCounts('conversation').get(run.id)).toBe(2)
  })

  it('retains a durable file commit when binding fails and reconciles without recreating the file', async () => {
    const fixture = await createFixture()
    const commits: BuddyTreeCommit[] = []
    const failures: BuddyTreeFailure[] = []
    fixture.tree.onDidCommit(event => commits.push(event))
    fixture.tree.onDidFail(event => failures.push(event))
    vi.spyOn(fixture.repository, 'bind').mockImplementationOnce(() => {
      throw new Error('Fixture SQL binding failure')
    })
    const run = fixture.run('first', 'b0', 'q1')
    await expect(fixture.open(run)).rejects.toThrow('Fixture SQL binding failure')
    expect(commits.map(event => event.kind)).toEqual(['file.created'])
    expect(failures[0]).toMatchObject({ operationId: commits[0]!.operationId, stage: 'binding' })
    expect(fixture.repository.findBinding('conversation')).toBeUndefined()
    const file = join(fixture.root, 'conversations/conversation/session/tree.jsonl')
    const initial = await readFile(file, 'utf8')
    const opened = await fixture.open(run)
    expect(commits.map(event => event.kind)).toEqual(['file.created', 'binding.committed'])
    expect(commits[1]).toMatchObject({ reason: 'reconciled', treeId: commits[0]!.treeId })
    expect((await readFile(file, 'utf8')).startsWith(initial)).toBe(true)
    expect(Reflect.set(commits[0]!, 'treeId', 'changed')).toBe(false)
    await opened.session.shutdown('quit')
  })

  it('gives snapshots independent memory managers without new persistent commits', async () => {
    const fixture = await createFixture()
    const commits: BuddyTreeCommit[] = []
    fixture.tree.onDidCommit(event => commits.push(event))
    const first = fixture.run('first', 'b0', 'q1')
    const opened = await fixture.open(first)
    await opened.cursor.begin(opened.session.session, first.id)
    opened.cursor.manager.appendMessage(user('q1', 'original question'))
    opened.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'original answer' }]))
    opened.cursor.finish()
    opened.cursor.finish()
    const file = opened.session.piSessionFile
    const saved = await readFile(file, 'utf8')
    const count = commits.length
    expect(commits.filter(event => event.kind === 'checkpoint.committed').map(event => event.position)).toEqual(['before', 'after'])
    const snapshot = await fixture.tree.snapshot('conversation', 'b0', fixture.root)
    expect(snapshot?.getSessionFile()).toBeUndefined()
    snapshot!.appendMessage(user('private-preview', 'only in preview'))
    expect(await readFile(file, 'utf8')).toBe(saved)
    expect(JSON.stringify((await fixture.tree.snapshot('conversation', 'b0', fixture.root))!.getEntries())).not.toContain('only in preview')
    expect(commits).toHaveLength(count)
    await opened.session.shutdown('quit')
  })

  it('durably preserves the journal through checkpoints and reopening', async () => {
    const fixture = await createFixture()
    const first = fixture.run('first', 'b0', 'q1')
    const opened = await fixture.open(first)
    const file = opened.cursor.manager.getSessionFile()!
    const initial = await readFile(file, 'utf8')
    await opened.cursor.begin(opened.session.session, first.id)
    opened.cursor.manager.appendMessage(user('q1', 'durable question'))
    opened.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'durable answer' }]))
    opened.cursor.finish()
    fixture.complete(first, 'a1')
    fixture.runs.bindSession(first.id, file)
    await opened.session.shutdown('quit')

    const saved = await readFile(file, 'utf8')
    expect(saved.startsWith(initial)).toBe(true)
    const entries = saved.trim().split('\n').map(line => JSON.parse(line))
    expect(entries.filter(entry => entry.customType === 'lexora.conversation.checkpoint.v1').map(entry => entry.data.position))
      .toEqual(['before', 'after'])

    const next = fixture.run('next', 'b0', 'q2')
    const resumed = await fixture.open(next)
    await resumed.cursor.begin(resumed.session.session, next.id)
    expect(resumed.cursor.manager.getSessionFile()).toBe(file)
    expect(JSON.stringify(resumed.session.session.messages)).toContain('durable answer')
    resumed.cursor.finish()
    await resumed.session.shutdown('quit')
    expect((await readFile(file, 'utf8')).startsWith(saved)).toBe(true)
  })

  it('keeps tool context and compaction across continuation, regeneration, another branch and restart', async () => {
    const fixture = await createFixture()
    const first = fixture.run('r1', 'b0', 'q1')
    const opened = await fixture.open(first)
    await opened.cursor.begin(opened.session.session, first.id)
    expect(SessionManager.open(opened.cursor.manager.getSessionFile()!).getLeafEntry()?.type).toBe('custom')
    const userEntry = opened.cursor.manager.appendMessage(user('q1', 'original question'))
    opened.cursor.manager.appendMessage(assistant([{ type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'fixture.txt' } }], 'toolUse'))
    opened.cursor.manager.appendMessage({ role: 'toolResult', toolCallId: 'read-call', toolName: 'read', content: [{ type: 'text', text: 'NATIVE_TOOL_CONTEXT' }], isError: false, timestamp: Date.now() })
    opened.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'original answer' }]))
    opened.cursor.finish()
    fixture.complete(first, 'a1')
    opened.session.session.agent.state.messages = opened.cursor.manager.buildSessionContext().messages

    const compact = fixture.run('compact', 'b0', 'q1', 'conversation.compaction')
    await opened.cursor.begin(opened.session.session, compact.id)
    opened.cursor.manager.appendCompaction('NATIVE_COMPACTION', userEntry, 4000)
    opened.cursor.finish()
    fixture.complete(compact)
    opened.session.session.agent.state.messages = opened.cursor.manager.buildSessionContext().messages

    const later = fixture.run('r2', 'b0', 'q2')
    await opened.cursor.begin(opened.session.session, later.id)
    expect(JSON.stringify(opened.session.session.messages)).toContain('NATIVE_COMPACTION')
    expect(JSON.stringify(opened.session.session.messages)).toContain('NATIVE_TOOL_CONTEXT')
    opened.cursor.manager.appendMessage(user('q2', 'later question'))
    opened.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'later answer' }]))
    opened.cursor.finish()
    fixture.complete(later, 'a2')
    const file = opened.cursor.manager.getSessionFile()!
    fixture.runs.bindSession(first.id, file)
    fixture.runs.bindSession(later.id, file)
    fixture.runs.bindSession(compact.id, file)
    await opened.session.shutdown('quit')

    fixture.branch('b1', 'q1')
    const regenerated = fixture.run('r3', 'b1', 'q1')
    fixture.source(regenerated.id, first.id, 'before')
    const retry = await fixture.open(regenerated)
    await retry.cursor.begin(retry.session.session, regenerated.id)
    expect(retry.session.session.messages).toEqual([])
    retry.cursor.manager.appendMessage(user('q1', 'original question'))
    retry.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'alternative answer' }]))
    retry.cursor.finish()
    fixture.complete(regenerated, 'a3')
    fixture.runs.bindSession(regenerated.id, file)
    await retry.session.shutdown('quit')

    fixture.branch('b2', 'a1')
    const followup = fixture.run('r4', 'b2', 'q4')
    fixture.source(followup.id, first.id, 'after')
    const resumed = await fixture.open(followup)
    await resumed.cursor.begin(resumed.session.session, followup.id)
    const context = JSON.stringify(resumed.session.session.messages)
    expect(context).toContain('original answer')
    expect(context).toContain('NATIVE_TOOL_CONTEXT')
    expect(context).not.toContain('later question')
    expect(context).not.toContain('alternative answer')
    expect(context).not.toContain('NATIVE_COMPACTION')
    expect(resumed.cursor.manager.getSessionFile()).toBe(file)
    expect(resumed.cursor.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(3)
    await resumed.session.shutdown('quit')
  })

  it('recovers the native endpoint after an interrupted write and still retries before the original question', async () => {
    const fixture = await createFixture()
    const first = fixture.run('interrupted', 'b0', 'q1')
    const opened = await fixture.open(first)
    await opened.cursor.begin(opened.session.session, first.id)
    opened.cursor.manager.appendMessage(user('q1', 'interrupted question'))
    opened.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'durable partial answer' }], 'aborted'))
    fixture.runs.bindSession(first.id, opened.cursor.manager.getSessionFile()!)
    fixture.runs.reconcileTerminal(first.id, 'failed', '2026-09-09T00:00:04.000Z', 'RUNTIME_INTERRUPTED')
    await opened.session.shutdown('quit')
    const next = fixture.run('continuation', 'b0', 'q2')
    const resumed = await fixture.open(next)
    await resumed.cursor.begin(resumed.session.session, next.id)
    expect(JSON.stringify(resumed.session.session.messages)).toContain('durable partial answer')
    resumed.cursor.finish()
    fixture.complete(next)
    await resumed.session.shutdown('quit')
    fixture.branch('retry', 'q1')
    const retry = fixture.run('retry', 'retry', 'q1')
    fixture.source(retry.id, first.id, 'before')
    const regenerated = await fixture.open(retry)
    await regenerated.cursor.begin(regenerated.session.session, retry.id)
    expect(regenerated.session.session.messages).toEqual([])
    await regenerated.session.shutdown('quit')
  })

  it('imports native context edits and tool results without rewriting the source journal', async () => {
    const fixture = await createFixture()
    const commits: BuddyTreeCommit[] = []
    fixture.tree.onDidCommit(event => commits.push(event))
    const old = fixture.run('old', 'b0', 'q1')
    const legacy = await createIsolatedBuddySession(fixture.sessionOptions('b0'))
    const manager = legacy.session.sessionManager
    const userEntry = manager.appendMessage(user('q1', 'legacy question'))
    manager.appendMessage(assistant([{ type: 'toolCall', id: 'old-read', name: 'read', arguments: { path: 'fixture.txt' } }], 'toolUse'))
    const toolResult = manager.appendMessage({ role: 'toolResult', toolCallId: 'old-read', toolName: 'read', content: [{ type: 'text', text: 'ORIGINAL_TOOL_OUTPUT' }], isError: false, timestamp: Date.now() })
    manager.appendContextEdit(toolResult, { content: 'LEGACY_NATIVE_TOOL' })
    const failedAttempt = manager.appendMessage(assistant([{ type: 'text', text: 'OMITTED_ATTEMPT' }], 'error'))
    manager.appendContextEdit(failedAttempt, null)
    manager.appendMessage(assistant([{ type: 'text', text: 'legacy answer' }]))
    manager.appendCompaction('LEGACY_NATIVE_COMPACTION', userEntry, 4000)
    fixture.complete(old, 'old-answer')
    fixture.runs.bindSession(old.id, legacy.piSessionFile)
    await legacy.shutdown('quit')
    const original = await readFile(legacy.piSessionFile, 'utf8')
    fixture.branch('followup', 'old-answer')
    const next = fixture.run('next', 'followup', 'q2')
    fixture.source(next.id, old.id, 'after')
    const opened = await fixture.open(next)
    await opened.cursor.begin(opened.session.session, next.id)
    expect(JSON.stringify(opened.session.session.messages)).toContain('LEGACY_NATIVE_TOOL')
    expect(JSON.stringify(opened.session.session.messages)).toContain('LEGACY_NATIVE_COMPACTION')
    expect(JSON.stringify(opened.session.session.messages)).not.toContain('ORIGINAL_TOOL_OUTPUT')
    expect(JSON.stringify(opened.session.session.messages)).not.toContain('OMITTED_ATTEMPT')
    expect(opened.cursor.recoveredFromProductHistory).toBe(false)
    expect(await readFile(legacy.piSessionFile, 'utf8')).toBe(original)
    expect(opened.cursor.manager.getSessionFile()).not.toBe(legacy.piSessionFile)
    const importedFile = opened.cursor.manager.getSessionFile()!
    const importedBytes = await readFile(importedFile, 'utf8')
    expect(importedBytes).toContain('ORIGINAL_TOOL_OUTPUT')
    expect(importedBytes).toContain('OMITTED_ATTEMPT')
    const reloaded = SessionManager.open(importedFile)
    expect(reloaded.buildSessionContext().messages).toEqual(opened.session.session.messages)
    expect(commits.filter(event => event.kind === 'entries.imported')).toHaveLength(1)
    expect(commits.find(event => event.kind === 'checkpoint.committed' && event.runId === old.id))
      .toMatchObject({ recovery: { source: 'legacy' } })
    await opened.session.shutdown('quit')
    const reopened = await fixture.open(next)
    expect(commits.filter(event => event.kind === 'entries.imported')).toHaveLength(1)
    await reopened.session.shutdown('quit')
  })
  it('reports an unavailable journal directory before starting a session', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.root, 'conversations'), 'not a directory')
    await expect(fixture.open(fixture.run('first', 'b0', 'q1')))
      .rejects
      .toMatchObject({ code: 'SESSION_STORAGE_UNAVAILABLE' })
  })

  it('preserves an unreadable journal and rejects access instead of recovering from product history', async () => {
    const fixture = await createFixture()
    const first = fixture.run('first', 'b0', 'q1')
    const opened = await fixture.open(first)
    const file = opened.session.piSessionFile
    await opened.session.shutdown('quit')
    const original = await readFile(file)
    await chmod(file, 0o000)
    try {
      await expect(fixture.open(first)).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNAVAILABLE' })
    }
    finally {
      await chmod(file, 0o600)
    }
    expect(await readFile(file)).toEqual(original)
  })

  it('keeps a corrupt journal intact and recovers the exact prior turn into a new generation', async () => {
    const points: unknown[] = []
    const fixture = await createFixture(async (input) => {
      points.push(input.point)
      return { messages: [{ role: 'user', content: 'Recovered question', timestamp: Date.now() }, assistant([{ type: 'text', text: 'Recovered answer' }])], missingAttachmentIds: ['unavailable-image'], recoveredImageCount: 0 }
    })
    const first = fixture.run('first', 'b0', 'q1')
    const commits: BuddyTreeCommit[] = []
    fixture.tree.onDidCommit(event => commits.push(event))
    const opened = await fixture.open(first)
    const originalFile = opened.session.piSessionFile
    fixture.runs.bindSession(first.id, originalFile)
    fixture.complete(first, 'answer-1')
    await opened.session.shutdown('quit')
    await writeFile(originalFile, '{broken journal}\n')
    const next = fixture.run('next', 'b0', 'q2')
    const recovered = await fixture.open(next)
    try {
      expect(recovered.session.piSessionFile).not.toBe(originalFile)
      expect(await readFile(originalFile, 'utf8')).toBe('{broken journal}\n')
      expect(points).toEqual([{ kind: 'before_message', messageId: 'q2' }])
      expect(JSON.stringify(recovered.session.session.messages)).toContain('Recovered answer')
      expect(recovered.cursor.recoveredFromProductHistory).toBe(true)
      expect(recovered.cursor.recoveryDegradation?.missingAttachmentIds).toEqual(['unavailable-image'])
      expect(commits.filter(event => event.kind === 'binding.committed').map(event => event.reason)).toEqual(['created', 'replaced'])
      expect(commits.find(event => event.kind === 'checkpoint.committed' && event.runId === first.id))
        .toMatchObject({ recovery: { source: 'product_history', missingAttachmentCount: 1, recoveredImageCount: 0 } })
      expect(Reflect.set(recovered.cursor.recoveryDegradation!, 'recoveredImageCount', 9)).toBe(false)
    }
    finally {
      await recovered.session.shutdown('quit')
    }
  })

  it('reports a durable write failure while restoring product history', async () => {
    const fixture = await createFixture(async () => {
      const file = join(fixture.root, 'conversations/conversation/session/tree.jsonl')
      await rm(file)
      await mkdir(file)
      return { messages: [assistant([{ type: 'text', text: 'Recovered answer' }])], missingAttachmentIds: [], recoveredImageCount: 0 }
    })
    const first = fixture.run('first', 'b0', 'q1')
    const commits: BuddyTreeCommit[] = []
    const failures: BuddyTreeFailure[] = []
    fixture.tree.onDidCommit(event => commits.push(event))
    fixture.tree.onDidFail(event => failures.push(event))
    fixture.complete(first, 'answer-1')
    await expect(fixture.open(fixture.run('next', 'b0', 'q2')))
      .rejects
      .toMatchObject({ code: 'SESSION_STORAGE_UNAVAILABLE' })
    expect(commits.map(event => event.kind)).toEqual(['file.created', 'binding.committed'])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ stage: 'checkpoint' })
  })
})

async function createFixture(recovery?: BuddySessionRecoveryService['create']) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-native-tree-'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanups.push(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = modelRuntime.getModels()[0]!
  let time = 0
  const now = () => new Date(Date.UTC(2026, 8, 9, 0, 0, ++time)).toISOString()
  conversations.create({ id: 'conversation', branchId: 'b0', spaceId: null, title: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now() })
  const repository = createConversationTreeRepository(database)
  const tree = new BuddyConversationTree({
    conversations,
    runs,
    conversationsDirectory: join(root, 'conversations'),
    repository,
    recovery: {
      create: recovery ?? (async () => {
        throw new Error('Healthy native context must not be reconstructed')
      }),
    },
  })
  cleanups.push(() => tree.dispose())
  const sessionOptions = (branchId: string) => ({ agentDir: join(root, 'agent'), branchId, canonicalRoot: root, conversationId: 'conversation', conversationsDirectory: join(root, 'conversations'), cwd: root, approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const, inProcessExtensions: [], model, modelRuntime, resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'test' } })
  return {
    root,
    tree,
    repository,
    runs,
    sessionOptions,
    branch(id: string, messageId: string) {
      conversations.createBranch({ id, conversationId: 'conversation', parentBranchId: 'b0', forkedFromMessageId: messageId, createdAt: now(), activate: true })
    },
    run(id: string, branchId: string, questionId: string, purpose: RunRecord['purpose'] = 'chat') {
      if (!conversations.findMessageById(questionId)) {
        conversations.createMessage({ id: questionId, branchId, conversationId: 'conversation', content: { text: questionId }, role: 'user', runId: null, createdAt: now() })
      }
      return runs.create({ id, conversationId: 'conversation', branchId, triggeringMessageId: questionId, provider: model.provider, model: model.id, purpose, status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', startedAt: now() })
    },
    complete(run: RunRecord, answerId?: string) {
      runs.reconcileTerminal(run.id, 'completed', now(), null)
      if (answerId) {
        conversations.createMessage({ id: answerId, branchId: run.branchId, conversationId: run.conversationId, content: { text: answerId }, role: 'assistant', runId: run.id, createdAt: now() })
      }
    },
    toolEvent(runId: string, sequence: number, toolCallId: string) {
      database.prepare('INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(runId, sequence, 'tool.started', JSON.stringify({ toolCallId, toolName: 'read' }), now())
    },
    source(runId: string, sourceRunId: string, position: string) {
      database.prepare('INSERT INTO run_tree_sources (run_id, source_run_id, position) VALUES (?, ?, ?)').run(runId, sourceRunId, position)
    },
    async open(run: RunRecord) {
      const cursor = await tree.open(run, root, model)
      const session = await createBuddySession({ ...sessionOptions(run.branchId), sessionManager: cursor.manager })
      return { cursor, session }
    },
  }
}

function user(messageId: string, prompt: string) {
  return createBuddyInputReferenceMessage({ messageId, prompt, images: [], version: 1 }, Date.now())
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, api: 'openai-completions', model: 'test-model', provider: 'test-provider', stopReason, timestamp: Date.now(), usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}

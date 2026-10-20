import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import type { RunRecord } from '../../../../storage/runRecord'
import type { BuddyTreeCommit, BuddyTreeFailure } from '../BuddyTreeEvents'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXECUTION_MAILBOX_ENTRY_TYPE } from '../../../../../../shared/executions/executionApi'
import { ArtifactService } from '../../../../artifacts/ArtifactService'
import { AttachmentService } from '../../../../attachments/AttachmentService'
import { projectConversationTree } from '../../../../conversations/projectConversationTree'
import { searchConversationHistory } from '../../../../conversations/searchConversationHistory'
import { SessionReferenceService } from '../../../../conversations/SessionReferenceService'
import { RunEventProjector } from '../../../../events/RunEventProjector'
import { createArtifactRepository } from '../../../../storage/artifactRepository'
import { createAttachmentRepository } from '../../../../storage/attachmentRepository'
import { BuddyDataPaths } from '../../../../storage/BuddyDataPaths'
import { createBuddyRepository } from '../../../../storage/buddyRepository'
import { createConversationMemberRepository } from '../../../../storage/conversationMemberRepository'
import { createConversationRepository } from '../../../../storage/conversationRepository'
import { createConversationTreeRepository } from '../../../../storage/conversationTreeRepository'
import { openBuddyDatabase } from '../../../../storage/database'
import { createMailboxRepository, hashExecutionMailboxMessage } from '../../../../storage/mailboxRepository'
import { createRunInputRepository } from '../../../../storage/runInputRepository'
import { createRunRepository } from '../../../../storage/runRepository'
import { actorThreadId, createThreadBindingRepository } from '../../../../storage/threadBindingRepository'
import { createUsageRepository } from '../../../../storage/usageRepository'
import { createBuddyInputReferenceMessage } from '../../../context/BuddyInputReference'
import { renderMailboxMessage } from '../../../execution/executionMailboxEntries'
import { createIsolatedBuddySession } from '../../__tests__/isolatedBuddySession'
import { createBuddySession } from '../../createBuddySession'
import { BuddySessionRecoveryService } from '../../recovery/BuddySessionRecoveryService'
import { BuddyConversationTree } from '../BuddyConversationTree'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('native conversation tree', () => {
  it('skips quarantined native checkpoints and descendants without deleting private history', async () => {
    const quarantined = new Set<string>()
    const f = await createFixture(undefined, runId => !quarantined.has(runId))
    const first = f.run('damaged', 'b0', 'q1')
    const opened = await f.open(first)
    await opened.cursor.begin(opened.session.session, first.id)
    opened.cursor.manager.appendMessage(user('q1', 'PUBLIC_INPUT'))
    opened.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'UNVERIFIED_PRIVATE_NATIVE_CONTENT' }]))
    f.publish(first, 'public-answer', 'PRESERVED_PUBLIC_RECORD')
    opened.cursor.finish()
    f.complete(first)
    await opened.session.shutdown('quit')
    const descendant = f.run('descendant', 'b0', 'q2')
    const inherited = await f.open(descendant)
    await inherited.cursor.begin(inherited.session.session, descendant.id)
    inherited.cursor.finish()
    f.complete(descendant)
    await inherited.session.shutdown('quit')
    const originalBytes = await readFile(inherited.session.piSessionFile)
    quarantined.add(first.id)
    const preview = await f.tree.preview('conversation', 'b0', f.root, first.threadId)
    expect(JSON.stringify(preview.buildSessionContext().messages)).not.toContain('UNVERIFIED_PRIVATE_NATIVE_CONTENT')
    const next = f.run('next', 'b0', 'q3')
    f.source(next.id, first.id, 'after')
    const fresh = await f.open(next)
    await fresh.cursor.begin(fresh.session.session, next.id)
    expect(JSON.stringify(fresh.cursor.manager.buildSessionContext().messages)).not.toContain('UNVERIFIED_PRIVATE_NATIVE_CONTENT')
    expect(JSON.stringify(fresh.cursor.manager.buildSessionContext().messages)).toContain('PRESERVED_PUBLIC_RECORD')
    expect((await readFile(inherited.session.piSessionFile)).subarray(0, originalBytes.length)).toEqual(originalBytes)
    await fresh.session.shutdown('quit')
  })

  it('includes new publications in later previews without changing earlier snapshots', async () => {
    const f = await createFixture()
    const first = f.run('preview-first', 'b0', 'q1')
    f.publish(first, 'preview-first-answer', 'FIRST_PUBLIC_ANSWER')
    f.complete(first)
    const before = await f.tree.preview('conversation', 'b0', f.root, first.threadId)
    const beforeContent = JSON.stringify(before.buildSessionContext().messages)
    const second = f.run('preview-second', 'b0', 'q2')
    f.publish(second, 'preview-second-answer', 'SECOND_PUBLIC_ANSWER')
    f.complete(second)
    const after = await f.tree.preview('conversation', 'b0', f.root, second.threadId)
    expect(beforeContent).toContain('FIRST_PUBLIC_ANSWER')
    expect(beforeContent).not.toContain('SECOND_PUBLIC_ANSWER')
    expect(JSON.stringify(before.buildSessionContext().messages)).toBe(beforeContent)
    expect(JSON.stringify(after.buildSessionContext().messages)).toContain('FIRST_PUBLIC_ANSWER')
    expect(JSON.stringify(after.buildSessionContext().messages)).toContain('SECOND_PUBLIC_ANSWER')
  })

  it('does not copy a published actor result again after native wait already delivered it', async () => {
    const f = await createFixture()
    const parent = f.run('native-parent', 'b0', 'q1')
    const child = f.child(parent, 'native-actor-child', f.actor('Supporting actor'))
    f.publish(child, 'child-public-answer', 'PUBLIC_CHILD_ALREADY_DELIVERED')
    f.complete(child)
    const root = await f.open(parent)
    await root.cursor.begin(root.session.session, parent.id)
    root.cursor.manager.appendMessage(user('q1', 'First root input'))
    root.cursor.manager.appendMessage(assistant([{ type: 'toolCall', id: 'native-wait', name: 'lexora_agents', arguments: { operation: 'wait', runId: child.id } }], 'toolUse'))
    const value = { messageId: 'child-result', sourceRunId: child.id, sourceSequence: 2, targetRunId: parent.id, targetGeneration: parent.generation, kind: 'result' as const, text: 'PUBLIC_CHILD_ALREADY_DELIVERED' }
    const details = { updates: [{ ...value, payloadHash: hashExecutionMailboxMessage(value) }] }
    root.cursor.manager.appendMessage({ role: 'toolResult', toolCallId: 'native-wait', toolName: 'lexora_agents', content: [{ type: 'text', text: JSON.stringify(details) }], details, isError: false, timestamp: Date.now() })
    root.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'Root consumed child result' }]))
    f.publish(parent, 'parent-public-answer', 'Root consumed child result')
    root.cursor.finish()
    f.complete(parent)
    const next = f.run('next-after-native-result', 'b0', 'q2')
    await root.cursor.begin(root.session.session, next.id)
    await root.session.session.prompt('NEXT_ROOT_REQUEST')
    const request = JSON.parse(f.requests.at(-1)!) as Context
    expect(JSON.stringify(request.messages.map(message => message.content)).split('PUBLIC_CHILD_ALREADY_DELIVERED')).toHaveLength(2)
    expect(root.cursor.manager.getBranch().some(entry => entry.type === 'custom_message' && entry.customType === 'lexora.conversation.public.v1' && JSON.stringify(entry.details).includes('child-public-answer'))).toBe(false)
    await root.session.shutdown('quit')
  })

  it('keeps private question answers out of another actor request, public history, session materials and recovered context', async () => {
    let recovery: BuddySessionRecoveryService
    const f = await createFixture(input => recovery.create(input))
    const attachments = new AttachmentService({ paths: new BuddyDataPaths(f.root), repository: createAttachmentRepository(f.database) })
    recovery = new BuddySessionRecoveryService({
      attachments,
      conversations: f.conversations,
      models: { resolve: () => f.sessionOptions('b0').model },
      runInputs: createRunInputRepository(f.database),
      runs: f.runs,
      usage: createUsageRepository(f.database),
    })
    const materials = new SessionReferenceService({ conversations: f.conversations, publications: f.repository, attachments, artifacts: new ArtifactService({ repository: createArtifactRepository(f.database) }) })
    const privateAnswer = 'PRIVATE_QUESTION_ANSWER_SENTINEL'
    const actorB = f.actor('Actor B')
    const a = f.run('actor-a-run', 'b0', 'q1')
    f.database.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify({ text: 'PUBLIC_USER_INPUT', modelInputText: 'PRIVATE_ASSEMBLED_SKILL', cache: 'PRIVATE_CACHE' }), 'q1')
    const openedA = await f.open(a)
    await openedA.cursor.begin(openedA.session.session, a.id)
    const input = openedA.cursor.manager.appendMessage(user('q1', 'PUBLIC_USER_INPUT PRIVATE_ASSEMBLED_SKILL'))
    openedA.cursor.manager.appendMessage(assistant([{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'toolCall', id: 'private-read', name: 'read', arguments: { path: 'private-path' } }], 'toolUse'))
    openedA.cursor.manager.appendMessage({ role: 'toolResult', toolCallId: 'private-read', toolName: 'read', content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }], isError: false, timestamp: Date.now() })
    openedA.cursor.manager.appendCompaction('PRIVATE_A_COMPACTION', input, 1000)
    openedA.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'PUBLIC_A_ANSWER' }]))
    f.publish(a, 'a-answer', 'PUBLIC_A_ANSWER')
    createArtifactRepository(f.database).save({ id: 'public-artifact', conversationId: 'conversation', sourceArtifactId: null, currentPath: join(f.root, 'PRIVATE_ARTIFACT_PATH'), directoryGrantId: 'PRIVATE_GRANT', directoryRoot: f.root, relativePath: 'PRIVATE_ARTIFACT_PATH', kind: 'file', name: 'public-report.md', mimeType: 'text/plain', sizeBytes: 5, createdAt: a.startedAt, updatedAt: a.startedAt })
    new RunEventProjector(f.database).project([{ runId: a.id, sequence: 2, type: 'output.produced', createdAt: a.startedAt, payload: { artifactIds: ['public-artifact'], sourceToolCallId: 'PRIVATE_TOOL_CALL', sourceToolName: 'PRIVATE_TOOL_NAME' } }])
    openedA.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'PUBLIC_A_LATER_SEGMENT' }]))
    new RunEventProjector(f.database).project([{ runId: a.id, sequence: 3, type: 'message.completed', createdAt: a.startedAt, payload: { messageId: 'a-later-answer', role: 'assistant', stopReason: 'completed', content: { text: 'PUBLIC_A_LATER_SEGMENT' } } }])
    const question = { messageId: 'private-question', questionId: 'private-question', sourceRunId: a.id, sourceSequence: 4, targetRunId: a.id, targetGeneration: a.generation, kind: 'question' as const, audience: 'user' as const, text: 'PRIVATE_QUESTION_PROMPT' }
    const answer = { messageId: 'private-answer', questionId: question.questionId, sourceRunId: a.id, sourceSequence: 5, targetRunId: a.id, targetGeneration: a.generation, kind: 'answer' as const, text: privateAnswer }
    for (const value of [question, answer]) {
      const envelope = { ...value, payloadHash: hashExecutionMailboxMessage(value) }
      new RunEventProjector(f.database).project([{ runId: a.id, sequence: value.sourceSequence, type: 'execution.mailbox.sent', createdAt: a.startedAt, payload: envelope }])
      if (value.kind === 'answer')
        await openedA.session.session.sendCustomMessage({ customType: EXECUTION_MAILBOX_ENTRY_TYPE, content: renderMailboxMessage(envelope), details: envelope, display: false }, { triggerTurn: false })
    }
    expect(createMailboxRepository(f.database).findQuestion(question.questionId)?.answer?.text).toBe(privateAnswer)
    expect(JSON.stringify(openedA.cursor.manager.buildSessionContext().messages)).toContain(privateAnswer)
    openedA.cursor.finish()
    expect(await readFile(openedA.session.piSessionFile, 'utf8')).toContain(privateAnswer)
    f.complete(a)
    const npc = f.npc(a, 'private-npc')
    const npcEvent = f.publish(npc, 'npc-answer', 'PRIVATE_NPC_BODY')
    f.complete(npc)
    new RunEventProjector(f.database).rebuild(npc.id, [npcEvent])
    expect(f.database.prepare('SELECT payload_json FROM run_events WHERE run_id = ?').get(npc.id)?.payload_json).toContain('PRIVATE_NPC_BODY')
    expect(f.repository.listRunMessages('conversation', npc.id)).toEqual([])
    expect(JSON.stringify(f.conversations.listBranchMessages('conversation', 'b0'))).not.toContain('PRIVATE_NPC_BODY')
    const tree = projectConversationTree({ conversationId: 'conversation', activeBranchId: 'b0', branches: f.conversations.listBranches('conversation'), messages: f.repository.listMessages('conversation'), runs: f.repository.listRuns('conversation') })
    expect(tree.nodes.some(node => node.runId === npc.id)).toBe(false)
    expect(JSON.stringify(tree)).not.toContain(privateAnswer)
    expect(JSON.stringify(f.conversations.listBranchMessages('conversation', 'b0'))).not.toContain(privateAnswer)
    const beforeReplay = f.repository.listPublications('conversation', 'b0')
    const aEvent = f.events(a.id)
    new RunEventProjector(f.database).rebuild(a.id, aEvent)
    expect(f.repository.listPublications('conversation', 'b0')).toEqual(beforeReplay)
    expect(createMailboxRepository(f.database).findQuestion(question.questionId)?.answer?.text).toBe(privateAnswer)
    const materialTarget = materials.requireSession('conversation')
    const materialSearch = await searchConversationHistory(f.conversations, materialTarget, { query: privateAnswer })
    expect(materialSearch.matches).toEqual([])
    const publicMaterial = materials.readMessage(materialTarget, { kind: 'message', messageId: 'a-answer' }, {})
    expect(publicMaterial.text).toBe('PUBLIC_A_ANSWER')
    expect(JSON.stringify(publicMaterial)).not.toContain(privateAnswer)
    for (const messageId of [question.messageId, answer.messageId, 'npc-answer'])
      expect(() => materials.readMessage(materialTarget, { kind: 'message', messageId }, {})).toThrow('SESSION_REFERENCE_SOURCE_UNAVAILABLE')
    const b = f.run('actor-b-run', 'b0', 'q2', 'chat', actorB)
    const openedB = await f.open(b)
    await openedB.cursor.begin(openedB.session.session, b.id)
    await openedB.session.session.prompt('CURRENT_B_INPUT')
    const request = f.requests.at(-1)!
    expect(request).toContain('PUBLIC_USER_INPUT')
    expect(request).toContain('PUBLIC_A_ANSWER')
    expect(request).toContain('public-report.md')
    expect(request).toContain('public-artifact')
    expect(request).toContain(a.buddyId)
    expect(request).not.toContain('PRIVATE_')
    expect(openedB.session.session.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(f.repository.findPublicCursor(b.threadId, b.branchId)?.sequence).toBe(f.repository.getPublicSnapshot(b.id))
    const intermediate = await f.tree.snapshot('conversation', 'b0', f.root, a.id, 'after', a.threadId, 'a-answer')
    const intermediateContext = JSON.stringify(intermediate!.buildSessionContext().messages)
    expect(intermediateContext).toContain('PUBLIC_A_ANSWER')
    expect(intermediateContext).not.toContain('PUBLIC_A_LATER_SEGMENT')
    expect(intermediateContext).not.toContain('public-artifact')
    expect(intermediateContext).not.toContain('PRIVATE_')
    openedB.cursor.finish()
    f.publish(b, 'b-answer', 'PUBLIC_B_ANSWER')
    f.complete(b)
    const damagedFile = openedB.session.piSessionFile
    await Promise.all([openedA, openedB].map(entry => entry.session.shutdown('quit')))
    await writeFile(damagedFile, '{damaged actor journal}\n')
    const nextB = f.run('recovered-b-run', 'b0', 'q3', 'chat', actorB)
    const recoveredB = await f.open(nextB)
    expect(recoveredB.cursor.recoveredFromProductHistory).toBe(true)
    expect(recoveredB.session.piSessionFile).not.toBe(damagedFile)
    expect(await readFile(damagedFile, 'utf8')).toBe('{damaged actor journal}\n')
    expect(JSON.stringify(recoveredB.cursor.manager.buildSessionContext().messages)).toContain('PUBLIC_B_ANSWER')
    expect(JSON.stringify(recoveredB.cursor.manager.buildSessionContext().messages)).not.toContain('PRIVATE_')
    await recoveredB.cursor.begin(recoveredB.session.session, nextB.id)
    await recoveredB.session.session.prompt('AFTER_RECOVERY_REQUEST')
    const recoveredRequest = f.requests.at(-1)!
    expect(recoveredRequest).toContain('PUBLIC_A_ANSWER')
    expect(recoveredRequest).toContain('PUBLIC_B_ANSWER')
    expect(recoveredRequest).not.toContain('PRIVATE_')
    expect(createMailboxRepository(f.database).findQuestion(question.questionId)?.answer?.text).toBe(privateAnswer)
    await recoveredB.session.shutdown('quit')
  })

  it('keeps actor increments and compaction private across cursor repair and earlier branches', async () => {
    const f = await createFixture()
    const actorB = f.actor('Actor B')
    const a = f.run('a-first', 'b0', 'q1')
    const openedA = await f.open(a)
    await openedA.cursor.begin(openedA.session.session, a.id)
    openedA.cursor.manager.appendMessage(user('q1', 'q1'))
    openedA.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'PUBLIC_FIRST_A' }]))
    f.publish(a, 'a-first-answer', 'PUBLIC_FIRST_A')
    openedA.cursor.finish()
    f.complete(a)
    const b = f.run('b-first', 'b0', 'q2', 'chat', actorB)
    const openedB = await f.open(b)
    await openedB.cursor.begin(openedB.session.session, b.id)
    const bInput = openedB.cursor.manager.appendMessage(user('q2', 'B_OWN_INPUT'))
    openedB.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'PUBLIC_B_ANSWER' }]))
    f.publish(b, 'b-answer', 'PUBLIC_B_ANSWER')
    openedB.cursor.manager.appendCompaction('PRIVATE_B_COMPACTED_SUMMARY', bInput, 1000)
    openedB.cursor.finish()
    f.complete(b)
    f.database.prepare('DELETE FROM actor_public_cursors WHERE thread_id = ?').run(b.threadId)
    const interrupted = f.run('cursor-interrupted', 'b0', 'q-interrupted', 'chat', actorB)
    f.runs.bindSession(interrupted.id, openedB.cursor.manager.getSessionFile()!)
    vi.spyOn(f.repository, 'reconcilePublicCursor').mockImplementationOnce(() => {
      throw new Error('Cursor SQL unavailable after journal commit')
    })
    await expect(openedB.cursor.begin(openedB.session.session, interrupted.id)).rejects.toThrow('Cursor SQL unavailable')
    f.runs.reconcileTerminal(interrupted.id, 'failed', '2026-10-01T00:00:00.000Z', 'SESSION_STORAGE_UNAVAILABLE')
    const next = f.run('b-next', 'b0', 'q3', 'chat', actorB)
    await openedB.cursor.begin(openedB.session.session, next.id)
    await openedB.session.session.prompt('B_NEXT_REQUEST')
    expect(f.requests.at(-1)).toContain('PRIVATE_B_COMPACTED_SUMMARY')
    expect(f.repository.findPublicCursor(b.threadId, 'b0')).not.toBeNull()
    expect(openedB.cursor.manager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'lexora.conversation.public.v1' && (entry.details as { sourceId: string }).sourceId === 'message:a-first-answer')).toHaveLength(1)
    openedB.cursor.finish()
    f.complete(next)
    f.branch('fork', 'a-first-answer')
    const fork = f.run('b-fork', 'fork', 'q4', 'chat', actorB)
    await openedB.cursor.begin(openedB.session.session, fork.id)
    await openedB.session.session.prompt('B_FORK_REQUEST')
    const request = f.requests.at(-1)!
    expect(request).toContain('PUBLIC_FIRST_A')
    expect(request).not.toContain('PRIVATE_B_COMPACTED_SUMMARY')
    expect(request).not.toContain('PUBLIC_B_ANSWER')
    expect(request).not.toContain('B_OWN_INPUT')
    const preview = await f.tree.snapshot('conversation', 'b0', f.root, a.id, 'after', b.threadId)
    expect(JSON.stringify(preview!.buildSessionContext().messages)).toContain('PUBLIC_FIRST_A')
    expect(JSON.stringify(preview!.buildSessionContext().messages)).not.toContain('PRIVATE_B_COMPACTED_SUMMARY')
    await Promise.all([openedA, openedB].map(entry => entry.session.shutdown('quit')))
  })

  it('freezes parallel actor inputs at caller admission and gives NPCs no public history', async () => {
    const f = await createFixture()
    const parent = f.run('batch-parent', 'b0', 'q1')
    const a = f.child(parent, 'batch-a', f.actor('A'))
    f.publish(a, 'batch-a-answer', 'PUBLIC_SIBLING_ANSWER')
    f.complete(a)
    const b = f.child(parent, 'batch-b', f.actor('B'))
    expect(f.repository.getPublicSnapshot(b.id)).toBe(f.repository.getPublicSnapshot(a.id))
    const openedB = await f.open(b)
    await openedB.cursor.begin(openedB.session.session, b.id)
    await openedB.session.session.prompt('EXPLICIT_CHILD_TASK')
    expect(f.requests.at(-1)).toContain('q1')
    expect(f.requests.at(-1)).not.toContain('PUBLIC_SIBLING_ANSWER')
    const npc = f.npc(parent, 'fresh-npc')
    const openedNpc = await f.open(npc)
    await openedNpc.cursor.begin(openedNpc.session.session, npc.id)
    await openedNpc.session.session.prompt('ONLY_NPC_TASK')
    expect(f.requests.at(-1)).not.toContain('PUBLIC_SIBLING_ANSWER')
    expect(f.requests.at(-1)).not.toContain('q1')
    expect(f.repository.getPublicSnapshot(npc.id)).toBe(0)
    await Promise.all([openedB, openedNpc].map(entry => entry.session.shutdown('quit')))
  })

  it('keeps concurrent NPC calls in separate journals and preserves the final parent checkpoint', async () => {
    const fixture = await createFixture()
    const parent = fixture.run('parent', 'b0', 'q1')
    const root = await fixture.open(parent)
    await root.cursor.begin(root.session.session, parent.id)
    root.cursor.manager.appendMessage(user('q1', 'parent private input'))
    root.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'parent first loop' }]))
    const childA = fixture.npc(parent, 'child-a')
    const childB = fixture.npc(parent, 'child-b', childA.buddyId)
    const [a, b] = await Promise.all([fixture.open(childA), fixture.open(childB)])
    expect(new Set([root, a, b].map(entry => entry.cursor.manager.getSessionFile())).size).toBe(3)
    for (const child of [a, b]) {
      expect(JSON.stringify(child.cursor.manager.buildSessionContext().messages)).not.toContain('parent private')
      expect(child.cursor.manager.buildSessionContext().messages).toEqual([])
    }
    await a.cursor.begin(a.session.session, childA.id)
    a.cursor.manager.appendMessage(user('private-a', 'child A secret'))
    a.cursor.finish()
    fixture.complete(childA)
    await b.cursor.begin(b.session.session, childB.id)
    expect(JSON.stringify(b.cursor.manager.getEntries())).not.toContain('child A secret')
    b.cursor.finish()
    fixture.complete(childB)
    root.cursor.manager.appendMessage(assistant([{ type: 'text', text: 'parent final loop' }]))
    root.cursor.finish()
    fixture.complete(parent, 'answer')
    const later = fixture.run('later', 'b0', 'q2')
    const reopened = await fixture.open(later)
    const context = JSON.stringify(reopened.cursor.manager.buildSessionContext().messages)
    expect(context).toContain('parent first loop')
    expect(context).toContain('parent final loop')
    expect(context).not.toContain('child A secret')
    await Promise.all([root, a, b, reopened].map(entry => entry.session.shutdown('quit')))
  })

  it('rejects a different thread journal even when the conversation and working directory match', async () => {
    const fixture = await createFixture()
    const parent = fixture.run('parent', 'b0', 'q1')
    const root = await fixture.open(parent)
    const child = fixture.npc(parent, 'child')
    const foreign = join(dirname(root.cursor.manager.getSessionFile()!), 'foreign.jsonl')
    await writeFile(foreign, await readFile(root.cursor.manager.getSessionFile()!))
    fixture.threads.bind(child.threadId, foreign, root.cursor.rootId)
    await expect(fixture.open(child)).rejects.toMatchObject({ code: 'CONVERSATION_BINDING_MISMATCH' })
    await root.session.shutdown('quit')
  })

  it('retains a durable file commit when binding fails and reconciles without recreating the file', async () => {
    const fixture = await createFixture()
    const commits: BuddyTreeCommit[] = []
    const failures: BuddyTreeFailure[] = []
    fixture.tree.onDidCommit(event => commits.push(event))
    fixture.tree.onDidFail(event => failures.push(event))
    vi.spyOn(fixture.threads, 'bind').mockImplementationOnce(() => {
      throw new Error('Fixture SQL binding failure')
    })
    const run = fixture.run('first', 'b0', 'q1')
    await expect(fixture.open(run)).rejects.toThrow('Fixture SQL binding failure')
    expect(commits.map(event => event.kind)).toEqual(['file.created'])
    expect(failures[0]).toMatchObject({ operationId: commits[0]!.operationId, stage: 'binding' })
    expect(fixture.threads.findBinding(run.threadId)).toBeNull()
    const file = join(fixture.root, 'conversations/conversation/session/threads', createHash('sha256').update(actorThreadId('conversation', 'default')).digest('hex'), 'tree.jsonl')
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
    const snapshot = await fixture.tree.preview('conversation', 'b0', fixture.root, actorThreadId('conversation', 'default'))
    expect(snapshot?.getSessionFile()).toBeUndefined()
    snapshot!.appendMessage(user('private-preview', 'only in preview'))
    expect(await readFile(file, 'utf8')).toBe(saved)
    expect(JSON.stringify((await fixture.tree.preview('conversation', 'b0', fixture.root, actorThreadId('conversation', 'default')))!.getEntries())).not.toContain('only in preview')
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

  it('imports native context edits and tool results into the same actor thread without rewriting the source journal', async () => {
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
    const preview = await fixture.tree.snapshot('conversation', 'b0', fixture.root, old.id, 'after', old.threadId)
    expect(JSON.stringify(preview!.buildSessionContext().messages)).toContain('LEGACY_NATIVE_TOOL')
    expect(JSON.stringify(preview!.buildSessionContext().messages)).toContain('LEGACY_NATIVE_COMPACTION')
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
      const file = join(fixture.root, 'conversations/conversation/session/threads', createHash('sha256').update(actorThreadId('conversation', 'default')).digest('hex'), 'tree.jsonl')
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

async function createFixture(recovery?: BuddySessionRecoveryService['create'], isRunHistoryAvailable?: (runId: string) => boolean) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-native-tree-'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanups.push(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = modelRuntime.getModels().find(model => model.provider === 'anthropic')!
  await modelRuntime.setRuntimeApiKey(model.provider, 'offline-public-context-fixture')
  const requests: string[] = []
  vi.spyOn(modelRuntime, 'streamSimple').mockImplementation((target, context) => {
    requests.push(JSON.stringify(context))
    const stream = createAssistantMessageEventStream()
    const message = { ...assistant([{ type: 'text', text: 'Fixture provider answer' }]), api: target.api, model: target.id, provider: target.provider }
    queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }))
    return stream
  })
  let time = 0
  const now = () => new Date(Date.UTC(2026, 8, 9, 0, 0, ++time)).toISOString()
  conversations.create({ id: 'conversation', branchId: 'b0', spaceId: null, title: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now() })
  const repository = createConversationTreeRepository(database)
  const threads = createThreadBindingRepository(database)
  const buddies = createBuddyRepository(database)
  const tree = new BuddyConversationTree({
    conversations,
    runs,
    conversationsDirectory: join(root, 'conversations'),
    repository,
    threads,
    isRunHistoryAvailable,
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
    database,
    conversations,
    requests,
    actor(name: string) {
      const actor = buddies.create({ name, kind: 'actor' })
      createConversationMemberRepository(database).join({ conversationId: 'conversation', actorId: actor.id, joinedAt: now() })
      threads.ensureActor('conversation', actor.id, now())
      return actor.id
    },
    child(parent: RunRecord, id: string, buddyId: string) {
      const thread = threads.ensureActor('conversation', buddyId, now())
      return runs.create({ id, buddyId, conversationId: parent.conversationId, branchId: parent.branchId, triggeringMessageId: `private-${id}`, provider: model.provider, model: model.id, purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', startedAt: now(), rootRunId: parent.rootRunId, parentRunId: parent.id, executionKind: 'actor_child', threadId: thread.id })
    },
    publish(run: RunRecord, messageId: string, text: string) {
      const event = { runId: run.id, sequence: 1, type: 'message.completed', createdAt: now(), payload: { messageId, role: 'assistant', stopReason: 'completed', content: { text } } }
      new RunEventProjector(database).project([event])
      return event
    },
    events(runId: string) {
      return (database.prepare('SELECT run_id AS runId, sequence, event_type AS type, created_at AS createdAt, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence').all(runId) as { runId: string, sequence: number, type: string, createdAt: string, payload_json: string }[]).map(({ payload_json, ...event }) => ({ ...event, payload: JSON.parse(payload_json) }))
    },
    tree,
    repository,
    runs,
    sessionOptions,
    threads,
    npc(parent: RunRecord, id: string, buddyId = buddies.create({ name: 'NPC', kind: 'npc' }).id) {
      const thread = threads.createNpc(parent.conversationId, buddyId, now())
      return runs.create({ id, buddyId, conversationId: parent.conversationId, branchId: parent.branchId, triggeringMessageId: `private-${id}`, provider: model.provider, model: model.id, purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', startedAt: now(), rootRunId: parent.rootRunId, parentRunId: parent.id, executionKind: 'npc_child', threadId: thread.id })
    },
    branch(id: string, messageId: string) {
      conversations.createBranch({ id, conversationId: 'conversation', parentBranchId: 'b0', forkedFromMessageId: messageId, createdAt: now(), activate: true })
    },
    run(id: string, branchId: string, questionId: string, purpose: RunRecord['purpose'] = 'chat', buddyId?: string) {
      if (!conversations.findMessageById(questionId)) {
        conversations.createMessage({ id: questionId, branchId, conversationId: 'conversation', content: { text: questionId }, role: 'user', runId: null, createdAt: now() })
      }
      return runs.create({ id, ...(buddyId ? { buddyId, threadId: threads.ensureActor('conversation', buddyId, now()).id } : {}), conversationId: 'conversation', branchId, triggeringMessageId: questionId, provider: model.provider, model: model.id, purpose, status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', startedAt: now() })
    },
    complete(run: RunRecord, answerId?: string) {
      runs.reconcileTerminal(run.id, 'completed', now(), null)
      if (answerId) {
        conversations.createMessage({ id: answerId, branchId: run.branchId, conversationId: run.conversationId, content: { text: answerId }, role: 'assistant', runId: run.id, createdAt: now() })
      }
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

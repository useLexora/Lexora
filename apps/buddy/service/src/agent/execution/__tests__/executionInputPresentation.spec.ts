import type { ExecutionMailboxDraft } from '../../../../../shared/executions/executionApi'
import type { ExecutionPresentationOptions } from '../ExecutionPresentationService'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BuddiesService } from '../../../buddies/BuddiesService'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { createExecutionStorageFixture, executionNow } from '../../../storage/__tests__/executionFixture'
import { createApprovalRepository } from '../../../storage/approvalRepository'
import { createArtifactRepository } from '../../../storage/artifactRepository'
import { createMailboxRepository } from '../../../storage/mailboxRepository'
import { createUsageRepository } from '../../../storage/usageRepository'
import { ExecutionPresentationService } from '../ExecutionPresentationService'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})
const scope = { conversationId: 'conversation', branchId: 'branch' }

async function fixture() {
  const storage = createExecutionStorageFixture()
  storage.conversations.createMessage({ id: 'goal', ...scope, runId: null, role: 'user', content: { text: 'Public goal' }, createdAt: executionNow })
  storage.executions.admitChild(storage.child('actor', storage.actor.id))
  storage.executions.admitChild(storage.child('npc'))
  const directory = await mkdtemp(join(tmpdir(), 'lexora-input-receipts-'))
  const events = createRunEventLog({ database: storage.database, conversationsDirectory: directory })
  const mutations = new MutationCoordinator()
  const options: ExecutionPresentationOptions = {
    approvals: createApprovalRepository(storage.database),
    conversations: storage.conversations,
    runs: storage.runs,
    executions: storage.executions,
    mailbox: createMailboxRepository(storage.database),
    buddies: new BuddiesService(storage.buddies),
    coordinator: {
      onDidChange: () => ({ dispose() {} }),
      answerQuestion: async () => {},
      send: async () => {},
      cancel: async () => false,
    },
    mutations,
    events,
    artifacts: createArtifactRepository(storage.database),
    changes: { listSummariesForRuns: () => [] },
    usage: createUsageRepository(storage.database),
    stopExecution: async () => false,
  }
  const services = [new ExecutionPresentationService(options)]
  cleanups.push(async () => {
    services.forEach(service => service.dispose())
    await events.close()
    mutations.dispose()
    storage.database.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    ...storage,
    events,
    mailbox: options.mailbox,
    service: services[0]!,
    send: (runId: string, payload: ExecutionMailboxDraft) => events.append({ runId, type: 'execution.mailbox.sent', payload }),
    reopen() {
      const service = new ExecutionPresentationService({
        ...options,
        mailbox: createMailboxRepository(storage.database),
      })
      services.push(service)
      return service
    },
  }
}

function supplement(messageId: string, targetRunId: string, user = true): ExecutionMailboxDraft {
  return { kind: 'supplement', messageId, targetRunId, targetGeneration: 0, text: messageId, ...(user ? { origin: 'user' as const } : {}) }
}

describe('execution input receipts for the UI', () => {
  it('projects only explicit user supplements and self answers to user questions without publishing them', async () => {
    const f = await fixture()
    await f.send('root', supplement('root-user-input', 'root'))
    await f.send('actor', supplement('actor-user-input', 'actor'))
    await f.send('npc', supplement('npc-private-input', 'npc'))
    await f.send('root', supplement('agent-to-agent', 'actor', false))
    await f.send('root', supplement('cross-run-user-marker', 'actor'))
    await f.send('actor', supplement('legacy-self-input', 'actor', false))
    for (const audience of ['user', 'caller'] as const) {
      const questionId = `question-${audience}`
      await f.send('actor', { kind: 'question', audience, messageId: questionId, questionId, targetRunId: audience === 'user' ? 'actor' : 'root', targetGeneration: 0, text: questionId })
      await f.send('actor', { kind: 'answer', messageId: `answer-${audience}`, questionId, targetRunId: 'actor', targetGeneration: 0, text: `answer-${audience}` })
    }
    await f.send('root', { kind: 'answer', messageId: 'agent-answer', questionId: 'question-user', targetRunId: 'actor', targetGeneration: 0, text: 'Agent answer must stay private' })
    const publicMessages = f.conversations.listBranchMessages(scope.conversationId, scope.branchId)
    const publications = f.database.prepare('SELECT * FROM conversation_publications').all()
    const detail = await f.service.detail({ ...scope, rootRunId: 'root', runId: 'actor' })
    const page = f.reopen().inputs({ ...scope, runIds: ['root', 'actor'] })
    expect(page.inputs.map(input => input.messageId)).toEqual(['root-user-input', 'actor-user-input', 'answer-user'])
    expect(page.inputs[1]).toMatchObject({ ...scope, runId: 'actor', rootRunId: 'root', buddyId: f.actor.id, buddyName: f.actor.name, task: 'Delegated goal', kind: 'supplement', state: 'pending' })
    expect(page.inputs.filter(input => input.runId === 'actor').map(({ kind, messageId, text, createdAt, state }) => ({ kind, messageId, text, createdAt, state }))).toEqual(detail.inputs)
    expect(f.conversations.listBranchMessages(scope.conversationId, scope.branchId)).toEqual(publicMessages)
    expect(f.database.prepare('SELECT * FROM conversation_publications').all()).toEqual(publications)
    expect(JSON.stringify(f.service.list(scope))).not.toContain('actor-user-input')
  })

  it.each([true, false])('hides only a verified original public input from the main receipt projection (exact=%s)', async (exact) => {
    const f = await fixture()
    const text = exact ? 'Public goal' : 'Different user instruction'
    await f.send('actor', { ...supplement('goal', 'actor'), text })
    const detail = await f.service.detail({ ...scope, rootRunId: 'root', runId: 'actor' })
    expect(detail.inputs).toMatchObject([{ messageId: 'goal', text }])
    expect(f.reopen().inputs({ ...scope, runIds: ['actor'] }).inputs).toHaveLength(exact ? 0 : 1)
    expect(f.conversations.listBranchMessages(scope.conversationId, scope.branchId).map(message => message.id)).toEqual(['goal'])
  })

  it('validates every requested run against the visible task branch and excludes NPC targets', async () => {
    const f = await fixture()
    await f.send('npc', supplement('private-npc', 'npc'))
    f.conversations.createBranch({ id: 'other', conversationId: scope.conversationId, parentBranchId: null, forkedFromMessageId: null, createdAt: executionNow, activate: false })
    for (const input of [
      { ...scope, runIds: ['npc'] },
      { ...scope, runIds: ['actor', 'missing'] },
      { ...scope, branchId: 'other', runIds: ['actor'] },
      { ...scope, conversationId: 'other-task', runIds: ['root'] },
    ])
      expect(() => f.service.inputs(input)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
  })

  it('pages the durable index without silently truncating inputs or treating a filtered page as the end', async () => {
    const f = await fixture()
    for (let index = 0; index < 100; index++)
      await f.send('root', supplement(`private-${index}`, 'actor', false))
    await f.send('actor', supplement('last-visible', 'actor'))
    const service = f.reopen()
    const first = service.inputs({ ...scope, runIds: ['actor'] })
    expect(first).toEqual({ inputs: [], nextOffset: 100 })
    const last = service.inputs({ ...scope, runIds: ['actor'], offset: first.nextOffset! })
    expect(last.inputs.map(input => input.messageId)).toEqual(['last-visible'])
    expect(last.nextOffset).toBeNull()
  })

  it('bounds large pages without truncating a user input', async () => {
    const f = await fixture()
    const text = '正文'.repeat(150_000)
    for (const id of ['large-one', 'large-two'])
      await f.send('actor', { ...supplement(id, 'actor'), text })
    const first = f.service.inputs({ ...scope, runIds: ['actor'] })
    expect(first.inputs).toHaveLength(1)
    expect(first.inputs[0]?.text).toBe(text)
    expect(first.nextOffset).toBe(1)
    const next = f.service.inputs({ ...scope, runIds: ['actor'], offset: first.nextOffset! })
    expect(next.inputs.map(input => input.messageId)).toEqual(['large-two'])
    expect(next.inputs[0]?.text).toBe(text)
    expect(next.nextOffset).toBeNull()
  })

  it('keeps the received fact after cancellation while pending inputs become undelivered', async () => {
    const f = await fixture()
    for (const id of ['received', 'pending', 'consumed'])
      await f.send('actor', supplement(id, 'actor'))
    for (const id of ['received', 'consumed']) {
      const message = f.mailbox.find(id)!.message
      const receipt = { messageId: id, sourceRunId: 'actor', payloadHash: message.payloadHash, contextEntryId: `entry-${id}` }
      await f.events.append({ runId: 'actor', type: 'execution.mailbox.accepted', payload: receipt })
      if (id === 'consumed')
        await f.events.append({ runId: 'actor', type: 'execution.mailbox.consumed', payload: receipt })
    }
    f.executions.requestCancel('actor', executionNow)
    expect(f.reopen().inputs({ ...scope, runIds: ['actor'] }).inputs.map(input => [input.messageId, input.state])).toEqual([
      ['received', 'accepted'],
      ['pending', 'undelivered'],
      ['consumed', 'consumed'],
    ])
  })
})

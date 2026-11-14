import type { TrustedProductContext } from '../../../../shared/productProtocol/identity'
import type { BuddyServiceCommands } from '../../BuddyService'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProductDesktopGateway } from '../../../../electron/main/productProtocol/ProductDesktopGateway'
import { productPageSchema, productQuestionSchema } from '../../../../shared/productProtocol/queries'
import { userQuestionRpc } from '../../../../shared/questions/userQuestionApi'
import { ExecutionCoordinator } from '../../agent/execution/ExecutionCoordinator'
import { MutationCoordinator } from '../../changes/MutationCoordinator'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { SqliteRunEventLog } from '../../events/SqliteRunEventLog'
import { createProductCommandHandlers } from '../../productProtocol/createProductCommandHandlers'
import { createProductSynchronization } from '../../productProtocol/createProductSynchronization'
import { ProductConnection } from '../../productProtocol/ProductConnection'
import { ProductQueries } from '../../productProtocol/ProductQueries'
import { RunLifecycleService } from '../../runs/RunLifecycleService'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { createExecutionRepository } from '../../storage/executionRepository'
import { createMailboxRepository } from '../../storage/mailboxRepository'
import { createRunRepository } from '../../storage/runRepository'
import { UserQuestionDelivery } from '../UserQuestionDelivery'
import { UserQuestionService } from '../UserQuestionService'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const scope = { conversationId: 'conversation', branchId: 'branch-conversation' }
const question = { questions: [{ id: 'scope', question: '选择范围', kind: 'single' as const, options: [{ id: 'small', label: '只处理当前目录', recommended: true }, { id: 'large', label: '处理整个空间' }] }] }
const answers = [{ questionId: 'scope', selectedOptionIds: ['small'], text: '保留原始说明😀' }]
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-question-command-'))
  const database = openBuddyMigrationCandidate({ databasePath: join(directory, 'buddy.sqlite3') })
  seedSqliteRun(database, 'root', { conversationId: 'conversation' })
  database.exec('UPDATE runs SET status = \'running\'')
  const storage = { database, conversations: createConversationRepository(database), executions: createExecutionRepository(database), runs: createRunRepository(database) }
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  database.prepare('INSERT INTO storage_actors VALUES (\'phone\', \'device\', \'active\', \'2026-11-09T00:00:00.000Z\')').run()
  const events = new SqliteRunEventLog({ database })
  const mailbox = createMailboxRepository(database)
  const lifecycle = new RunLifecycleService({ eventLog: events, repository: storage.runs })
  const mutations = new MutationCoordinator()
  const coordinator = new ExecutionCoordinator({ executions: storage.executions, mailbox, events, lifecycle, mutations, readResult: () => '', launchChild: async () => {
    throw new Error('Unexpected child')
  }, stopExecution: async () => false, listIncomplete: () => storage.runs.listIncomplete() })
  const delivery = new UserQuestionDelivery({ ...storage, mailbox, coordinator, runner: { hasActiveExecution: () => false, isStopping: false }, turns: { continueQuestion: async () => {
    throw new Error('Unexpected continuation')
  } } })
  let deliveryAvailable = true
  const options = { ...storage, coordinator, deliver: (request: Parameters<UserQuestionDelivery['deliver']>[0]) => deliveryAvailable ? delivery.deliver(request) : Promise.reject(new Error('Fixture delivery unavailable')) }
  const service = new UserQuestionService(options)
  const admission = new CommandAdmissionService({ database, principal: createLocalCommandPrincipal(database), sourceInstanceId: 'instance' })
  const remote = new CommandAdmissionService({ database, principal: { actorId: 'phone', assertAuthenticated() {} }, sourceInstanceId: 'instance' })
  const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
  const queries = new ProductQueries(database, 'phone', 'instance')
  const command = (requestId: string, commandId: string, extra: Record<string, unknown> = {}) => ({ dataGeneration, commandId, expectedServiceInstanceId: 'instance', intent: { ...scope, requestId, ...extra } })
  const ask = (toolCallId = 'ask') => service.ask('root', toolCallId, question, new AbortController().signal)
  const countDeliveries = () => Number(database.prepare('SELECT COUNT(*) AS count FROM execution_mailbox_sources WHERE id LIKE \'user-question:%\'').get()!.count)
  cleanups.push(async () => {
    await admission.dispose()
    await remote.dispose()
    await service.dispose()
    await coordinator.dispose()
    await lifecycle.dispose()
    await events.close()
    mutations.dispose()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { ...storage, directory, events, queries, service, options, admission, remote, command, ask, countDeliveries, setDeliveryAvailable: (value: boolean) => {
    deliveryAvailable = value
  } }
}

describe('durable product question commands', () => {
  it('answers two concurrently running branches into their original execution trees despite a different default selection', async () => {
    const f = fixture()
    f.conversations.createBranch({ id: 'branch-B', conversationId: scope.conversationId, parentBranchId: null, forkedFromMessageId: null, createdAt: '2026-11-09T00:00:00.000Z', activate: false })
    const a = f.runs.findById('root')!
    const b = f.runs.create({ ...a, id: 'root-B', branchId: 'branch-B', rootRunId: 'root-B', threadId: undefined, triggeringMessageId: 'input-B' })
    const qa = f.ask('question-A')
    const qb = f.service.ask(b.id, 'question-B', question, new AbortController().signal)
    f.conversations.activateBranch({ conversationId: scope.conversationId, branchId: b.branchId, updatedAt: '2026-11-09T00:00:01.000Z' })
    expect(f.queries.task(scope.conversationId, true)).toMatchObject({ pendingQuestionCount: 2, activity: 'running' })
    const [ra, rb] = await Promise.all([
      f.service.executeCommand('questions.answer', f.command(qa.id, 'answer-A', { answers }), f.remote),
      f.service.executeCommand('questions.answer', f.command(qb.id, 'answer-B', { branchId: b.branchId, answers: [{ ...answers[0]!, text: 'Only branch B' }] }), f.remote),
    ])
    expect([ra.receipt.decision, rb.receipt.decision]).toEqual(['accepted', 'accepted'])
    expect(f.service.list(scope)[0]).toMatchObject({ id: qa.id, delivery: { state: 'delivered', targetRunId: 'root' } })
    expect(f.service.list({ ...scope, branchId: b.branchId })[0]).toMatchObject({ id: qb.id, delivery: { state: 'delivered', targetRunId: 'root-B' } })
    expect(f.countDeliveries()).toBe(2)
    expect(f.queries.task(scope.conversationId, true)).toMatchObject({ pendingQuestionCount: 0 })
  })

  it('advertises real question reads, enforces reader roles and resolves through the product command handler', async () => {
    const f = fixture()
    const request = f.ask()
    const commands = { admission: f.remote, questions: { execute: (method, input) => f.service.executeCommand(method, input, f.remote) } } as BuddyServiceCommands
    const handlers = { ...f.queries.handlers(), ...createProductCommandHandlers({ commands, assertOwner: () => {}, resolveQuote: () => {
      throw new Error('Unexpected quote')
    }, allowedActions: new Set() }) }
    const initialize = { protocol: { major: 1, minMinor: 0, maxMinor: 0 }, client: { kind: 'mobile', version: 'test' }, supportedContentKinds: [], supportedReviewKinds: [] }
    const context: TrustedProductContext = { serviceId: 'service', profileId: 'profile', dataGeneration: f.command(request.id, 'x').dataGeneration, serviceInstanceId: 'instance', connectionId: 'connection', clientSessionId: 'session', deviceId: 'phone', ownerPrincipalId: 'owner', credentialId: 'credential', grantGeneration: '1', role: 'reader' }
    for (const role of ['reader', 'owner'] as const) {
      const frames: any[] = []
      const connection = new ProductConnection({ context: { ...context, role }, assertCurrent() {}, phase: () => 'ready', handlers, send: (frame) => {
        frames.push(JSON.parse(frame))
        return true
      }, close() {} })
      const send = (method: string, params: unknown) => connection.receive(JSON.stringify({ jsonrpc: '2.0', id: String(frames.length), method, params }))
      await send('initialize', initialize)
      expect(frames.at(-1).result.capabilities).toContain('questions.list')
      expect(frames.at(-1).result.capabilities.includes('questions.answer')).toBe(role === 'owner')
      await send('questions.list', scope)
      expect(frames.at(-1).result.items).toMatchObject([{ id: request.id, questions: question.questions, status: 'pending' }])
      expect(frames.at(-1).result.items[0]).not.toHaveProperty('toolCallId')
      expect(frames.at(-1).result.items[0]).not.toHaveProperty('rootRunId')
      await send('questions.answer', f.command(request.id, 'answer', { answers }))
      if (role === 'reader') {
        expect(frames.at(-1).error.code).toBe('NOT_AUTHORIZED')
        expect(f.countDeliveries()).toBe(0)
      }
      else {
        expect(frames.at(-1).result.receipt).toMatchObject({ decision: 'accepted', target: { questionId: request.id }, result: { questionStatus: 'answered', questionDelivery: 'pending' } })
        expect(f.queries.views.question(request.id)).toMatchObject({ status: 'answered', response: { answers }, delivery: { state: 'delivered' } })
        expect(f.countDeliveries()).toBe(1)
        await send('commands.get', { dataGeneration: context.dataGeneration, commandId: 'answer' })
        expect(frames.at(-1).result).toMatchObject({ lookup: 'decided', receipt: { decision: 'accepted' } })
      }
      connection.close()
    }
  })

  it('preserves Desktop question DTOs and business request IDs while answer, retry and cancel have separate operation identities', async () => {
    const f = fixture()
    const question = f.ask()
    const commands = { admission: f.admission, questions: { execute: (method, input) => f.service.executeCommand(method, input, f.admission) } } as BuddyServiceCommands
    const notifications = new Set<(value: { method: string, params: unknown }) => void>()
    const connection = new ProductConnection({
      context: { serviceId: 'service', profileId: 'profile', dataGeneration: f.command(question.id, 'x').dataGeneration, serviceInstanceId: 'instance', connectionId: 'desktop-connection', clientSessionId: 'desktop-session', deviceId: 'desktop-local', ownerPrincipalId: 'owner', credentialId: 'credential', grantGeneration: '1', role: 'owner' },
      assertCurrent() {},
      phase: () => 'ready',
      handlers: createProductCommandHandlers({ commands, assertOwner() {}, resolveQuote: () => {
        throw new Error('Unexpected quote')
      }, allowedActions: new Set() }),
      send: (frame) => {
        notifications.forEach(notify => notify({ method: 'product.frame', params: { frame } }))
        return true
      },
      close() {},
    })
    const gateway = new ProductDesktopGateway({
      state: { status: 'ready' },
      onNotification: (listener) => {
        notifications.add(listener)
        return () => {
          notifications.delete(listener)
        }
      },
      onStateChange: () => () => {},
      restart: async () => {},
      request: async (method, params) => {
        if (method === 'product.exchange') {
          await connection.receive((params as { frame: string }).frame)
          return { received: true }
        }
        if (method === 'questions.list')
          return f.service.list(userQuestionRpc.list.input.parse(params))
        throw new Error(`Unexpected internal RPC: ${method}`)
      },
    }, join(f.directory, 'desktop-outbox'), 'test')
    try {
      const input = { ...scope, requestId: question.id, answers }
      const answered = userQuestionRpc.answer.response.parse(await gateway.request('questions.answer', input, { requestId: 'desktop-answer' }))
      expect(answered).toMatchObject({ id: question.id, rootRunId: 'root', toolCallId: 'ask', status: 'answered', response: { answers }, delivery: { state: 'delivered' } })
      expect(await gateway.request('questions.answer', input, { requestId: 'desktop-answer' })).toEqual(answered)
      expect(userQuestionRpc.retry.response.parse(await gateway.request('questions.retry', { ...scope, requestId: question.id }, { requestId: 'desktop-retry' }))).toEqual(answered)
      const second = f.ask('decline')
      const cancelled = userQuestionRpc.cancel.response.parse(await gateway.request('questions.cancel', { ...scope, requestId: second.id }, { requestId: 'desktop-cancel' }))
      expect(cancelled).toMatchObject({ id: second.id, rootRunId: 'root', toolCallId: 'decline', status: 'cancelled', response: null, delivery: { state: 'delivered' } })
      const receipts = f.database.prepare('SELECT command_id, method, target_json FROM command_receipts ORDER BY rowid').all()
      expect(receipts.map(receipt => [receipt.command_id, receipt.method, JSON.parse(String(receipt.target_json)).questionId])).toEqual([
        ['desktop-answer', 'questions.answer', question.id],
        ['desktop-retry', 'questions.retry', question.id],
        ['desktop-cancel', 'questions.cancel', second.id],
      ])
      expect(f.countDeliveries()).toBe(2)
      expect(f.queries.views.question(question.id)).not.toHaveProperty('rootRunId')
      expect(f.queries.views.question(question.id)).not.toHaveProperty('toolCallId')
    }
    finally {
      gateway.dispose()
      connection.close()
    }
  })

  it('commits the immutable answer and receipt together before publishing or delivering', async () => {
    const f = fixture()
    const request = f.ask()
    const states: unknown[] = []
    const subscription = f.service.onDidCommit(() => {
      states.push({ question: f.queries.views.question(request.id)?.status, receipt: f.remote.lookup({ dataGeneration: f.command(request.id, 'answer').dataGeneration, commandId: 'answer' }).lookup })
    })
    f.database.exec('CREATE TRIGGER fail_question_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, \'fixture receipt unavailable\'); END')
    await expect(f.service.executeCommand('questions.answer', f.command(request.id, 'answer', { answers }), f.remote)).rejects.toThrow('fixture receipt unavailable')
    expect(f.queries.views.question(request.id)).toMatchObject({ status: 'pending', response: null })
    expect(f.remote.lookup({ dataGeneration: f.command(request.id, 'answer').dataGeneration, commandId: 'answer' }).lookup).toBe('not_found')
    expect(f.countDeliveries()).toBe(0)
    expect(states).toEqual([])
    f.database.exec('DROP TRIGGER fail_question_receipt')
    const result = await f.service.executeCommand('questions.answer', f.command(request.id, 'answer', { answers }), f.remote)
    expect(result.receipt.decision).toBe('accepted')
    expect(states.length).toBeGreaterThan(0)
    expect(states.every(value => JSON.stringify(value) === JSON.stringify({ question: 'answered', receipt: 'decided' }))).toBe(true)
    expect(f.countDeliveries()).toBe(1)
    subscription.dispose()
  })

  it('decides two owner commands once and retains distinct durable receipts for the losing answer', async () => {
    const f = fixture()
    const request = f.ask()
    const results = await Promise.all([
      f.service.executeCommand('questions.answer', f.command(request.id, 'local-answer', { answers }), f.admission),
      f.service.executeCommand('questions.cancel', f.command(request.id, 'phone-cancel'), f.remote),
    ])
    expect(results.map(result => result.receipt.decision)).toEqual(['accepted', 'rejected'])
    expect(results[1]!.receipt).toMatchObject({ errorCode: 'QUESTION_CLOSED' })
    expect(f.countDeliveries()).toBe(1)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()!.count).toBe(2)
    await expect(f.service.executeCommand('questions.answer', f.command(request.id, 'local-answer', { answers: [{ ...answers[0]!, text: 'changed' }] }), f.admission)).rejects.toMatchObject({ code: 'COMMAND_ID_REUSED' })
  })

  it('retains accepted answers separately from failed delivery and only an explicit retry redelivers', async () => {
    const f = fixture()
    const request = f.ask()
    f.setDeliveryAvailable(false)
    const envelope = f.command(request.id, 'answer', { answers })
    const original = await f.service.executeCommand('questions.answer', envelope, f.remote)
    expect(original.receipt).toMatchObject({ decision: 'accepted', result: { questionStatus: 'answered', questionDelivery: 'pending' } })
    expect(f.queries.views.question(request.id)).toMatchObject({ status: 'answered', response: { answers }, delivery: { state: 'failed' } })
    f.setDeliveryAvailable(true)
    expect(await f.service.executeCommand('questions.answer', envelope, f.remote)).toEqual({ created: false, receipt: original.receipt })
    expect(f.countDeliveries()).toBe(0)
    const retry = f.command(request.id, 'retry')
    const retried = await f.service.executeCommand('questions.retry', retry, f.remote)
    expect(retried.receipt.decision).toBe('accepted')
    expect(f.queries.views.question(request.id)).toMatchObject({ response: { answers }, delivery: { state: 'delivered' } })
    expect(f.countDeliveries()).toBe(1)
    expect(await f.service.executeCommand('questions.retry', retry, f.remote)).toEqual({ created: false, receipt: retried.receipt })
    expect((await f.service.executeCommand('questions.retry', f.command(request.id, 'retry-again'), f.remote)).receipt).toMatchObject({ decision: 'accepted', result: { questionDelivery: 'delivered' } })
    expect(f.countDeliveries()).toBe(1)
  })

  it('recovers an interrupted delivery without replaying its durable receipt or duplicating the persisted mailbox source', async () => {
    const f = fixture()
    const request = f.ask()
    const envelope = f.command(request.id, 'answer', { answers })
    const original = await f.service.executeCommand('questions.answer', envelope, f.remote)
    const saved = f.service.list(scope)[0]!
    f.database.prepare('UPDATE user_questions SET request_json = ? WHERE id = ?').run(JSON.stringify({ ...saved, delivery: { state: 'pending', targetRunId: null } }), request.id)
    await f.service.dispose()
    const recovered = new UserQuestionService(f.options)
    const next = new CommandAdmissionService({ database: f.database, principal: { actorId: 'phone', assertAuthenticated() {} }, sourceInstanceId: 'next-instance' })
    cleanups.push(async () => {
      await next.dispose()
      await recovered.dispose()
    })
    expect(recovered.list(scope)[0]).toMatchObject({ status: 'answered', response: { answers }, delivery: { state: 'failed' } })
    expect(await recovered.executeCommand('questions.answer', envelope, next)).toEqual({ created: false, receipt: original.receipt })
    expect(recovered.list(scope)[0]?.delivery?.state).toBe('failed')
    await recovered.executeCommand('questions.retry', { ...f.command(request.id, 'retry'), expectedServiceInstanceId: 'next-instance' }, next)
    expect(recovered.list(scope)[0]).toMatchObject({ response: { answers }, delivery: { state: 'delivered', targetRunId: 'root' } })
    expect(f.countDeliveries()).toBe(1)
  })

  it('rejects invalid, foreign, stale and closed requests without delivering and preserves stale receipts after task restoration', async () => {
    const f = fixture()
    const request = f.ask()
    const invalid = await f.service.executeCommand('questions.answer', f.command(request.id, 'invalid', { answers: [{ ...answers[0]!, selectedOptionIds: ['missing'] }] }), f.remote)
    expect(invalid.receipt).toMatchObject({ decision: 'rejected', errorCode: 'QUESTION_ANSWER_INVALID' })
    const foreign = await f.service.executeCommand('questions.cancel', f.command(request.id, 'foreign', { branchId: 'other' }), f.remote)
    expect(foreign.receipt).toMatchObject({ decision: 'rejected', errorCode: 'QUESTION_NOT_FOUND' })
    f.database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run('2026-11-09T00:00:00.000Z', scope.conversationId)
    const staleEnvelope = f.command(request.id, 'stale', { answers })
    const stale = await f.service.executeCommand('questions.answer', staleEnvelope, f.remote)
    expect(stale.receipt).toMatchObject({ decision: 'rejected', errorCode: 'QUESTION_STALE' })
    f.database.prepare('UPDATE conversations SET deleted_at = NULL WHERE id = ?').run(scope.conversationId)
    expect(await f.service.executeCommand('questions.answer', staleEnvelope, f.remote)).toEqual({ created: false, receipt: stale.receipt })
    expect(f.countDeliveries()).toBe(0)
    const cancelled = await f.service.executeCommand('questions.cancel', f.command(request.id, 'cancel'), f.remote)
    expect(cancelled.receipt).toMatchObject({ decision: 'accepted', result: { questionStatus: 'cancelled' } })
    expect(f.queries.views.question(request.id)).toMatchObject({ status: 'cancelled', response: null, delivery: { state: 'delivered' } })
    expect((await f.service.executeCommand('questions.answer', f.command(request.id, 'late', { answers }), f.remote)).receipt).toMatchObject({ decision: 'rejected', errorCode: 'QUESTION_CLOSED' })
    expect(f.countDeliveries()).toBe(1)
  })

  it('pages public questions and publishes exact task-wide pending counts after durable decisions', async () => {
    const f = fixture()
    const first = f.ask('first')
    const idle = { onDidCommit: () => ({ dispose() {} }) }
    const sync = createProductSynchronization({ database: f.database, queries: f.queries, drafts: idle, metadata: idle, lifecycle: idle, questions: f.service, events: f.events })
    const frames: any[] = []
    const disconnect = sync.publisher.connect('phone', { send: (frame) => {
      frames.push(JSON.parse(frame))
      return true
    }, close() {} })
    const topic = 'questions:conversation:branch-conversation'
    sync.authorizeTopic(topic)
    try {
      for (const name of [topic, 'taskIndex']) {
        const subscription = sync.publisher.subscribe('phone', { topic: name, subscriptionId: name })
        subscription.activate()
        sync.publisher.ack('phone', { subscriptionId: name, ...subscription.snapshot.cursor })
        if (subscription.snapshot.mode !== 'snapshot')
          throw new Error('Initial question subscription must return a snapshot')
        if (name === topic)
          expect(subscription.snapshot.items).toEqual([productQuestionSchema.parse(f.queries.views.question(first.id))])
        else
          expect(subscription.snapshot.items).toMatchObject([{ pendingQuestionCount: 1 }])
      }
      const second = f.ask('second')
      const page = productPageSchema(productQuestionSchema).parse(f.queries.read('questions.list', { ...scope, limit: 1, cursor: null }))
      expect(page.items.map(item => item.id)).toEqual([first.id])
      expect(page.nextCursor).not.toBeNull()
      expect(productPageSchema(productQuestionSchema).parse(f.queries.read('questions.list', { ...scope, limit: 1, cursor: page.nextCursor })).items.map(item => item.id)).toEqual([second.id])
      expect(() => f.queries.read('questions.list', { ...scope, branchId: 'foreign', limit: 1, cursor: page.nextCursor })).toThrow('CURSOR_EXPIRED')
      expect(frames.some(frame => frame.params.changes?.some((change: any) => change.value?.pendingQuestionCount === 2))).toBe(true)
      await f.service.executeCommand('questions.answer', f.command(second.id, 'answer', { answers }), f.remote)
      expect(frames.some(frame => frame.params.changes?.some((change: any) => change.value?.id === second.id && change.value?.status === 'answered' && change.value?.delivery?.state === 'delivered'))).toBe(true)
      expect(f.queries.task(scope.conversationId, true)).toMatchObject({ pendingQuestionCount: 1 })
      expect(() => f.queries.read('questions.list', { ...scope, limit: 1, cursor: page.nextCursor })).toThrow('CURSOR_EXPIRED')
      f.database.prepare('UPDATE conversations SET active_branch_id = NULL WHERE id = ?').run(scope.conversationId)
      expect(f.queries.task(scope.conversationId, true)).toMatchObject({ pendingQuestionCount: 1 })
      f.database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run('2026-11-09T00:00:00.000Z', scope.conversationId)
      expect(f.queries.read('questions.list', { ...scope, limit: 100, cursor: null })).toEqual({ items: [], nextCursor: null })
      expect(() => sync.authorizeTopic('questions:conversation:missing')).toThrow('OBJECT_DELETED')
    }
    finally {
      disconnect()
      sync.dispose()
    }
  })
})

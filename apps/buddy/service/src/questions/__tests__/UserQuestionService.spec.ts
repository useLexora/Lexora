import type { UserQuestionRequest } from '../../../../shared/questions/userQuestionApi'
import { afterEach, describe, expect, it } from 'vitest'
import { askUserInputSchema, validateUserQuestionResponse } from '../../../../shared/questions/userQuestionApi'
import { projectUserQuestionHistory } from '../../../../shared/questions/userQuestionHistory'
import { createExecutionStorageFixture } from '../../storage/__tests__/executionFixture'
import { createMailboxRepository } from '../../storage/mailboxRepository'
import { UserQuestionDelivery } from '../UserQuestionDelivery'
import { UserQuestionService } from '../UserQuestionService'

const fixtures: Array<ReturnType<typeof createExecutionStorageFixture> & { service: UserQuestionService }> = []
afterEach(async () => {
  for (const { service, database } of fixtures.splice(0)) {
    await service.dispose()
    database.close()
  }
})
function fixture(deliver: (request: UserQuestionRequest) => Promise<string | null> = async () => 'root') {
  const f = createExecutionStorageFixture()
  const options = { ...f, deliver, coordinator: { waitForUser: async <T>(_runId: string, wait: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => wait(signal) } }
  const service = new UserQuestionService(options)
  const value = { ...f, service, options }
  fixtures.push(value)
  return value
}
const scope = { conversationId: 'conversation', branchId: 'branch' }
const input = { questions: [{ id: 'scope', question: 'Choose the scope', kind: 'single' as const, options: [{ id: 'a', label: 'Small' }, { id: 'b', label: 'Large' }] }] }
const response = { answers: [{ questionId: 'scope', selectedOptionIds: ['b'], text: 'Original user text' }] }
const signal = () => new AbortController().signal

describe('user question lifecycle', () => {
  it('returns a pending receipt immediately and only explicit waiting holds the caller', async () => {
    const { service, database } = fixture()
    const request = service.ask('root', 'call', input, signal())
    expect(request).toMatchObject({ status: 'pending', mode: 'async', toolCallId: 'call' })
    expect(service.isWaiting('root')).toBe(false)
    expect(service.ask('root', 'call', input, signal()).id).toBe(request.id)
    const result = service.wait('root', request.id, signal())
    expect(service.isWaiting('root')).toBe(true)
    const submit = { ...scope, requestId: request.id, ...response }
    const answered = await service.answer(submit)
    expect((await result).response).toEqual(response)
    expect(service.isWaiting('root')).toBe(false)
    expect(await service.answer(submit)).toEqual(answered)
    expect(answered.delivery).toEqual({ state: 'delivered', targetRunId: 'root' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM user_questions').get()?.count).toBe(1)
    await expect(service.answer({ ...submit, answers: [{ ...response.answers[0]!, text: 'changed' }] })).rejects.toThrow('QUESTION_CLOSED')
  })

  it('keeps accepted answers immutable through delivery failure and retry', async () => {
    let unavailable = true
    const f = fixture(async () => {
      if (unavailable)
        throw new Error('offline')
      return 'continuation'
    })
    const request = f.service.ask('root', 'call', input, signal())
    const submit = { ...scope, requestId: request.id, ...response }
    const waiting = f.service.wait('root', request.id, signal())
    const failed = await f.service.answer(submit)
    expect(f.service.isWaiting('root')).toBe(true)
    expect(failed).toMatchObject({ status: 'answered', response, delivery: { state: 'failed' } })
    const history = projectUserQuestionHistory(failed)!
    expect(history.entries[0]?.answer).toBe('Large\nOriginal user text')
    expect('questions' in history).toBe(false)
    expect('response' in history).toBe(false)
    expect(Object.isFrozen(history.entries[0])).toBe(true)
    unavailable = false
    const delivered = await f.service.retry({ ...scope, requestId: request.id })
    expect(delivered).toMatchObject({ response, delivery: { state: 'delivered', targetRunId: 'continuation' } })
    expect(history.delivery?.state).toBe('failed')
    expect((await waiting).response).toEqual(response)
    expect(f.service.isWaiting('root')).toBe(false)
  })

  it('rejects foreign scope, stale branches and invalid answers before resolving', async () => {
    const f = fixture()
    const request = f.service.ask('root', 'call', input, signal())
    const submit = { ...scope, requestId: request.id, ...response }
    await expect(f.service.answer({ ...submit, branchId: 'foreign' })).rejects.toThrow('QUESTION_NOT_FOUND')
    await expect(f.service.answer({ ...submit, answers: [{ ...response.answers[0]!, selectedOptionIds: ['foreign'] }] })).rejects.toThrow('QUESTION_ANSWER_INVALID')
    expect(f.service.hasPending('root')).toBe(true)
    f.database.prepare('UPDATE conversations SET active_branch_id = NULL WHERE id = ?').run(scope.conversationId)
    await expect(f.service.answer(submit)).rejects.toThrow('QUESTION_STALE')
  })

  it('retains unanswered async requests after a completed run and across restart', async () => {
    const f = fixture()
    const request = f.service.ask('root', 'call', input, signal())
    f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = \'root\'').run()
    await f.service.executionSettled('root')
    const recovered = new UserQuestionService(f.options)
    expect(recovered.list(scope)[0]?.status).toBe('pending')
    expect(await recovered.answer({ ...scope, requestId: request.id, ...response })).toMatchObject({ status: 'answered' })
    await recovered.dispose()
  })

  it('closes interrupted requests without replay and preserves saved undelivered answers', async () => {
    const f = fixture(async () => null)
    const first = f.service.ask('root', 'first', input, signal())
    await f.service.answer({ ...scope, requestId: first.id, ...response })
    const second = f.service.ask('root', 'second', input, signal())
    const recovered = new UserQuestionService(f.options)
    expect(recovered.list(scope).find(request => request.id === first.id)).toMatchObject({ status: 'answered', response, delivery: { state: 'failed' } })
    expect(recovered.list(scope).find(request => request.id === second.id)).toMatchObject({ status: 'interrupted', response: null })
    await recovered.dispose()
  })

  it('delivers an explicit decline without an answer and aborts only the wait on cancellation', async () => {
    const f = fixture()
    const request = f.service.ask('root', 'first', input, signal())
    const controller = new AbortController()
    const waiting = f.service.wait('root', request.id, controller.signal)
    controller.abort(new Error('stopped'))
    await expect(waiting).rejects.toThrow('stopped')
    expect(f.service.isWaiting('root')).toBe(false)
    expect(await f.service.cancel({ ...scope, requestId: request.id })).toMatchObject({ status: 'cancelled', response: null })
  })

  it('retries pending delivery after the target execution settles', async () => {
    let closing = true
    const f = fixture(async () => closing ? null : 'continued')
    const request = f.service.ask('root', 'first', input, signal())
    expect(await f.service.answer({ ...scope, requestId: request.id, ...response })).toMatchObject({ delivery: { state: 'pending' } })
    closing = false
    await f.service.executionSettled('root')
    expect(f.service.list(scope)[0]).toMatchObject({ delivery: { state: 'delivered', targetRunId: 'continued' } })
  })

  it('reconciles a saved answer after the last paused queue entry is removed', async () => {
    let delivery: UserQuestionDelivery
    const f = fixture(request => delivery.deliver(request))
    delivery = new UserQuestionDelivery({ ...f, mailbox: createMailboxRepository(f.database), coordinator: { send: async () => {
      throw new Error('Unexpected live delivery')
    } }, runner: { hasActiveExecution: () => false, isStopping: false }, turns: { continueQuestion: async () => 'continued' } })
    const request = f.service.ask('root', 'first', input, signal())
    f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = \'root\'').run()
    f.database.prepare('UPDATE execution_state SET phase = \'closed\', cleanup_state = \'clean\' WHERE run_id = \'root\'').run()
    f.database.prepare('INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at) VALUES (\'queued\', \'conversation\', \'branch\', \'queued-request\', \'queued-hash\', \'{}\', \'paused\', ?)').run(request.createdAt)
    const drafts = f.database.prepare('SELECT * FROM composer_drafts').all()
    expect(await f.service.answer({ ...scope, requestId: request.id, ...response })).toMatchObject({ response, delivery: { state: 'pending' } })
    await f.service.retryPending(scope)
    expect(f.service.list(scope)[0]?.delivery?.state).toBe('pending')
    f.database.prepare('DELETE FROM chat_queue WHERE id = \'queued\'').run()
    await f.service.retryPending({ ...scope, branchId: 'unrelated' })
    expect(f.service.list(scope)[0]?.delivery?.state).toBe('pending')
    await f.service.retryPending(scope)
    expect(f.service.list(scope)[0]).toMatchObject({ response, delivery: { state: 'delivered', targetRunId: 'continued' } })
    expect(f.database.prepare('SELECT * FROM composer_drafts').all()).toEqual(drafts)
  })

  it('validates complete answers, custom text and multi-selection using stable IDs', () => {
    expect(() => askUserInputSchema.parse({ questions: [input.questions[0], input.questions[0]] })).toThrow()
    expect(() => validateUserQuestionResponse(input.questions, { answers: [] })).toThrow()
    expect(() => validateUserQuestionResponse(input.questions, { answers: [{ questionId: 'scope', selectedOptionIds: ['a', 'b'], text: '' }] })).toThrow()
    expect(validateUserQuestionResponse(input.questions, { answers: [{ questionId: 'scope', selectedOptionIds: [], text: '  My own answer  ' }] }).answers[0]?.text).toBe('  My own answer  ')
    const multiple = [{ ...input.questions[0]!, kind: 'multiple' as const }]
    expect(validateUserQuestionResponse(multiple, { answers: [{ questionId: 'scope', selectedOptionIds: ['b', 'a'], text: '' }] }).answers[0]?.selectedOptionIds).toEqual(['a', 'b'])
    expect(() => validateUserQuestionResponse(multiple, { answers: [{ questionId: 'scope', selectedOptionIds: ['a', 'a'], text: '' }] })).toThrow()
  })
})

import type { AdmitChildExecutionInput } from '../executionRepository'
import { afterEach, describe, expect, it } from 'vitest'
import { hashChildAdmissionRequest, MAX_CHILD_ATTEMPTS_PER_ROOT } from '../executionRepository'
import { createExecutionStorageFixture, executionNow } from './executionFixture'

const fixtures: ReturnType<typeof createExecutionStorageFixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.database.close()))
function fixture() {
  const f = createExecutionStorageFixture()
  fixtures.push(f)
  return f
}
function request(input: AdmitChildExecutionInput, previousRunId?: string) {
  const updated: AdmitChildExecutionInput & { work: NonNullable<AdmitChildExecutionInput['work']> } = { ...input, work: { contextMode: 'isolated' as const, contextSourceIds: [], ...(previousRunId ? { previousRunId } : {}) } }
  return { ...updated, requestHash: hashChildAdmissionRequest(updated) }
}
function settle(f: ReturnType<typeof fixture>, id: string, status: 'completed' | 'failed' | 'cancelled' = 'completed') {
  f.runs.reconcileTerminal(id, status, executionNow, status === 'failed' ? 'RUNTIME_RESTARTED' : null)
  f.executions.recordCleanup(id, 'clean', null)
}

describe('durable execution work', () => {
  it.each(['actor', 'npc'] as const)('isolates new %s assignments and preserves ordinary actor thread identity', (kind) => {
    const f = fixture()
    const target = kind === 'actor' ? f.actor.id : f.npc.id
    const first = f.executions.admitChild(request(f.child('first', target))).execution
    settle(f, first.run.id)
    const second = f.executions.admitChild(request(f.child('second', target))).execution
    expect(second.run.threadId).not.toBe(first.run.threadId)
    expect(second.work.workId).not.toBe(first.work.workId)
    expect(second.run.piSessionFile).toBeNull()
    expect(f.threads.ensureActor('conversation', f.actor.id, executionNow).id).not.toBe(first.run.threadId)
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('continues %s NPC work in a new attempt without changing its old terminal record', (status) => {
    const f = fixture()
    const first = f.executions.admitChild(request(f.child('first'))).execution
    f.runs.bindSession(first.run.id, '/fixture/private.jsonl')
    settle(f, first.run.id, status)
    const before = f.runs.findById(first.run.id)
    const resumed = request(f.child('second'), first.run.id)
    const second = f.executions.admitChild(resumed).execution
    expect(second.work).toMatchObject({ workId: first.run.id, previousRunId: first.run.id, contextMode: 'isolated' })
    expect(second.run.threadId).toBe(first.run.threadId)
    expect(second.run.piSessionFile).toBe('/fixture/private.jsonl')
    expect(f.runs.findById(first.run.id)).toEqual(before)
    expect(f.executions.admitChild(resumed)).toMatchObject({ created: false, execution: { run: { id: second.run.id } } })
    expect(() => f.executions.admitChild(request(f.child('third'), first.run.id))).toThrow(expect.objectContaining({ code: 'stale' }))
  })

  it('continues work after its original caller has ended through a new run of the same actor', () => {
    const f = fixture()
    const first = f.executions.admitChild(request(f.child('first'))).execution
    settle(f, first.run.id)
    settle(f, 'root')
    f.runs.create({ ...f.runs.findById('root')!, id: 'next-root', rootRunId: 'next-root', status: 'running', completedAt: null })
    const second = f.executions.admitChild(request(f.child('second', f.npc.id, 'next-root'), first.run.id)).execution
    expect(second.run.rootRunId).toBe('next-root')
    expect(second.work.workId).toBe(first.run.id)
    expect(f.executions.listOwnedWork('next-root').map(record => record.run.id)).toEqual(['second'])
  })

  it.each(['running', 'cleanup', 'branch', 'owner', 'target', 'mode'] as const)('rejects unsafe continuation: %s', (variant) => {
    const f = fixture()
    const first = f.executions.admitChild(request(f.child('first'))).execution
    if (variant !== 'running')
      settle(f, first.run.id)
    if (variant === 'cleanup')
      f.executions.recordCleanup(first.run.id, 'degraded', 'CLEANUP_FAILED')
    if (variant === 'branch') {
      f.database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('other', 'conversation', executionNow)
      f.database.prepare('UPDATE runs SET branch_id = ? WHERE id = ?').run('other', first.run.id)
    }
    let next = request(f.child('second', variant === 'target' ? f.actor.id : f.npc.id), first.run.id)
    if (variant === 'owner') {
      const other = f.executions.admitChild(f.child('other-actor', f.actor.id)).execution
      f.executions.claimWorking(f.fence(other.run.id))
      next = request(f.child('second', f.npc.id, other.run.id), first.run.id)
    }
    if (variant === 'mode') {
      next.work.contextMode = 'conversation'
      next.requestHash = hashChildAdmissionRequest(next)
    }
    expect(() => f.executions.admitChild(next)).toThrow()
    expect(f.runs.findById('second')).toBeNull()
  })

  it.each(['source', 'attachment'] as const)('rejects a forged %s handoff before creating an execution', (kind) => {
    const f = fixture()
    const input = request(f.child('untrusted'))
    if (kind === 'source')
      input.work.contextSourceIds = ['message:private']
    else input.initialInput.attachmentIds = ['foreign-attachment']
    input.requestHash = hashChildAdmissionRequest(input)
    expect(() => f.executions.admitChild(input)).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    expect(f.runs.findById('untrusted')).toBeNull()
  })

  it('records evidence separately from completion and permits an idempotent owner review', () => {
    const f = fixture()
    const child = f.executions.admitChild(request(f.child('child'))).execution
    f.executions.claimWorking(f.fence(child.run.id))
    const submission = { summary: 'Artifact ready', evidence: ['output.json has the expected keys'], limitations: [] }
    f.executions.submit(child.run.id, submission)
    expect(f.executions.find(child.run.id)?.work.review).toBeNull()
    const review = { verdict: 'accepted' as const, reason: 'Validated the actual output', evidence: ['JSON parse and required fields passed'] }
    expect(() => f.executions.review('root', child.run.id, review)).toThrow()
    settle(f, child.run.id)
    expect(f.executions.review('root', child.run.id, review)).toMatchObject({ submission, review })
    expect(f.executions.review('root', child.run.id, review).review).toEqual(review)
    expect(() => f.executions.submit(child.run.id, submission)).toThrow()
    expect(() => f.executions.review('root', child.run.id, { ...review, verdict: 'rework' })).toThrow()
  })

  it('retains the assignment brief across continuation unless explicitly revised', () => {
    const f = fixture()
    const input = request(f.child('first'))
    input.work.brief = { objective: 'Inspect only the supplied file', acceptance: ['Actual output matches'], constraints: ['No network'], deliverables: ['Finding'] }
    input.requestHash = hashChildAdmissionRequest(input)
    const first = f.executions.admitChild(input).execution
    settle(f, first.run.id)
    const second = f.executions.admitChild(request(f.child('second'), first.run.id)).execution
    expect(second.work.brief).toEqual(first.work.brief)
    expect(second.work.submission).toBeNull()
    expect(second.work.review).toBeNull()
  })

  it('does not elevate a previously read-only work attempt through a writable new caller', () => {
    const f = fixture()
    const input = request(f.child('first'))
    input.run.executionProfile = 'read_only'
    input.requestHash = hashChildAdmissionRequest(input)
    const first = f.executions.admitChild(input).execution
    settle(f, first.run.id)
    expect(() => f.executions.admitChild(request(f.child('second'), first.run.id))).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    const allowed = request(f.child('second'), first.run.id)
    allowed.run.executionProfile = 'read_only'
    allowed.requestHash = hashChildAdmissionRequest(allowed)
    expect(f.executions.admitChild(allowed).execution.fileAccessCeiling).toBe('read_only')
  })

  it('rejects work history and review access from an unrelated actor owner', () => {
    const f = fixture()
    const child = f.executions.admitChild(request(f.child('first'))).execution
    settle(f, child.run.id)
    const other = f.executions.admitChild(f.child('other', f.actor.id)).execution
    f.executions.claimWorking(f.fence(other.run.id))
    expect(f.executions.listOwnedWork(other.run.id)).toEqual([])
    expect(() => f.executions.review(other.run.id, child.run.id, { verdict: 'accepted', reason: 'Foreign claim', evidence: ['Claim'] })).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  })

  it('keeps earlier review evidence immutable after a successor has started', () => {
    const f = fixture()
    const first = f.executions.admitChild(request(f.child('first'))).execution
    settle(f, first.run.id)
    const review = { verdict: 'rework' as const, reason: 'Incorrect output', evidence: ['Observed total 390'] }
    f.executions.review('root', first.run.id, review)
    f.executions.admitChild(request(f.child('second'), first.run.id))
    expect(() => f.executions.review('root', first.run.id, { ...review, verdict: 'accepted' })).toThrow()
    expect(f.executions.find(first.run.id)?.work.review).toEqual(review)
  })

  it('keeps a cancelled attempt distinct from its new successful continuation', () => {
    const f = fixture()
    const first = f.executions.admitChild(request(f.child('first'))).execution
    settle(f, first.run.id, 'cancelled')
    const second = f.executions.admitChild(request(f.child('second'), first.run.id)).execution
    settle(f, second.run.id)
    expect(f.executions.listOwnedWork('root').map(r => [r.run.id, r.run.status])).toEqual([['second', 'completed']])
    expect(f.executions.find(first.run.id)?.run.status).toBe('cancelled')
  })

  it('persists a bounded admission budget across finished children without charging request replay twice', () => {
    const f = fixture()
    for (let index = 0; index < MAX_CHILD_ATTEMPTS_PER_ROOT; index++) {
      const input = request(f.child(`child-${index}`))
      const accepted = f.executions.admitChild(input)
      settle(f, accepted.execution.run.id)
      expect(f.executions.admitChild(input).created).toBe(false)
    }
    expect(() => f.executions.admitChild(request(f.child('overflow')))).toThrow(expect.objectContaining({ code: 'budget_exceeded' }))
    expect(f.executions.listTree('root')).toHaveLength(MAX_CHILD_ATTEMPTS_PER_ROOT + 1)
    expect(f.runs.findById('overflow')).toBeNull()
  })

  it('does not admit resumed work after the target has been disabled', () => {
    const f = fixture()
    const first = f.executions.admitChild(request(f.child('first'))).execution
    settle(f, first.run.id)
    const target = f.buddies.get(f.npc.id)
    f.buddies.update({ buddyId: target.id, expectedRevision: target.revision, enabled: false })
    expect(() => f.executions.admitChild(request(f.child('second'), first.run.id))).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  })

  it('rejects submitting oversized structured evidence without overwriting the earlier submission', () => {
    const f = fixture()
    const child = f.executions.admitChild(request(f.child('child'))).execution
    f.executions.claimWorking(f.fence(child.run.id))
    const submission = { summary: 'First checked artifact', evidence: ['read output.json'], limitations: [] }
    f.executions.submit(child.run.id, submission)
    expect(() => f.executions.submit(child.run.id, { ...submission, evidence: ['a'.repeat(8000), 'b'.repeat(8000)] })).toThrow()
    expect(f.executions.find(child.run.id)?.work.submission).toEqual(submission)
  })

  it('cannot accept failed work as verified success', () => {
    const f = fixture()
    const child = f.executions.admitChild(request(f.child('child'))).execution
    settle(f, child.run.id, 'failed')
    expect(() => f.executions.review('root', child.run.id, { verdict: 'accepted', reason: 'Looks fine', evidence: [] })).toThrow()
    expect(f.executions.review('root', child.run.id, { verdict: 'blocked', reason: 'Provider failed', evidence: ['RUNTIME_RESTARTED'] }).review?.verdict).toBe('blocked')
  })
})

import type { OwnedProcessVerification } from '../../../../platform/process/ownedProcessRecovery'
import type { MutationRecoveryOptions } from '../MutationRecoveryService'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { MutationCoordinator } from '../MutationCoordinator'
import { createMutationEvidenceRepository } from '../mutationEvidenceRepository'
import { MutationRecoveryService } from '../MutationRecoveryService'
import { createMutationRepository } from '../mutationRepository'

const cleanups: (() => void | Promise<void>)[] = []
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse())
      await cleanup()
  }
  finally { vi.useRealTimers() }
})

const signal = new AbortController().signal
const unknown: OwnedProcessVerification = { status: 'unknown', reason: 'receipt_missing' }
const released: OwnedProcessVerification = { status: 'released', reason: 'supervisor_receipt' }
const active: OwnedProcessVerification = { status: 'active', reason: 'supervisor_active' }
const native = (id: string) => JSON.stringify({ kind: 'native-shell', platform: process.platform, pid: 123, startTime: '123', nonce: id })
const claims = (id: string) => [{ kind: 'tree' as const, canonicalPath: join(tmpdir(), 'mutation-recovery-scheduling', id) }]
const flush = () => vi.advanceTimersByTimeAsync(0)

function fixture(resources?: NonNullable<ConstructorParameters<typeof MutationCoordinator>[0]>['resources']) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  let closed = false
  const close = () => {
    if (!closed) {
      closed = true
      database.close()
    }
  }
  cleanups.push(close)
  const repository = createMutationRepository(database)
  const evidence = createMutationEvidenceRepository(database)
  const mutations = new MutationCoordinator({ repository, evidence, resources })
  cleanups.push(() => mutations.dispose())
  return {
    database,
    repository,
    evidence,
    mutations,
    close,
    async hazard(id: string, effect: () => void = () => {}) {
      const lease = await mutations.acquire({ runId: `${id}-run`, invocationId: id, claims: claims(id), lifetime: 'external', signal })
      await mutations.withInvocation(lease, async () => {
        effect()
      })
      mutations.recordOwnedProcessSettlement({ invocationId: id, processId: native(id), settlement: 'unknown' })
      lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
      await mutations.waitForSettlements()
    },
    recovery(options: Omit<MutationRecoveryOptions, 'mutations' | 'evidence'> = {}) {
      const recovery = new MutationRecoveryService({ mutations, evidence, checkpoint: async () => null, ...options })
      cleanups.push(async () => {
        mutations.stopAdmission()
        await recovery.dispose()
      })
      return recovery
    },
  }
}

function verificationGate() {
  const gate = Promise.withResolvers<OwnedProcessVerification>()
  cleanups.push(() => gate.resolve(unknown))
  return gate
}

function context(f: ReturnType<typeof fixture>) {
  const conversations = createConversationRepository(f.database)
  const runs = createRunRepository(f.database)
  const now = new Date().toISOString()
  conversations.create({ id: 'task', branchId: 'task', createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, title: 'Recovery' })
  conversations.createMessage({ id: 'question', conversationId: 'task', branchId: 'task', role: 'user', runId: null, createdAt: now, content: { text: 'Fixture' } })
  runs.create({ id: 'old-run', conversationId: 'task', branchId: 'task', triggeringMessageId: 'question', provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'failed', startedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', piSessionFile: null })
  return { conversations, runs }
}

describe('bounded mutation recovery scheduling', () => {
  it('starts immediately and continues bounded background checks without blocking new work', async () => {
    const f = fixture()
    for (const id of ['one', 'two', 'three', 'four'])
      await f.hazard(id)
    const gate = verificationGate()
    const visited = new Map<string, number>()
    const recovery = f.recovery({ verify: async (id) => {
      const attempt = (visited.get(id) ?? 0) + 1
      visited.set(id, attempt)
      return attempt === 1 && [native('one'), native('two')].includes(id) ? gate.promise : released
    } })
    let started = false
    const starting = recovery.start().then(() => {
      started = true
    })
    await flush()
    expect([...visited.keys()]).toEqual([native('one'), native('two')])
    await vi.advanceTimersByTimeAsync(4_999)
    expect(started).toBe(true)
    const next = await f.mutations.acquire({ runId: 'next-run', invocationId: 'next', claims: claims('one'), lifetime: 'runtime', signal })
    next.release()
    expect(f.mutations.getOwnedProcesses('one')).toEqual([{ processId: native('one'), settlement: 'unknown' }])
    await vi.advanceTimersByTimeAsync(1)
    await starting
    expect(started).toBe(true)
    expect(f.repository.listUnreleased().map(item => item.invocationId).sort()).toEqual(['one', 'two'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.repository.listUnreleased()).toEqual([])
    expect(f.evidence.decision('four')).toMatchObject({ kind: 'quiesced', outcome: 'applied' })
    gate.resolve(active)
    await flush()
    expect(f.repository.listUnreleased()).toEqual([])
  })

  it('admits new work after exhausted verification without replaying or settling the old effect', async () => {
    const f = fixture()
    const effects: string[] = []
    await f.hazard('old', () => effects.push('old'))
    let outcome = unknown
    const recovery = f.recovery({ verify: async () => outcome })
    await recovery.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.repository.listUnreleased()).toHaveLength(1)
    outcome = released
    const lease = await f.mutations.acquire({ runId: 'next-run', invocationId: 'next', claims: claims('old'), lifetime: 'runtime', signal })
    await f.mutations.withInvocation(lease, async () => {
      effects.push('next')
    })
    lease.release()
    await f.mutations.waitForSettlements()
    expect(effects).toEqual(['old', 'next'])
    expect(f.evidence.relatedRuns('old')).toEqual(['next-run'])
    expect(f.repository.listUnreleased().map(item => item.invocationId)).toEqual(['old'])
    expect(f.mutations.getOwnedProcesses('old')).toEqual([{ processId: native('old'), settlement: 'unknown' }])
    await recovery.recheck()
    expect(f.repository.listUnreleased()).toEqual([])
    expect(f.evidence.decision('old')).toMatchObject({ kind: 'quiesced', outcome: 'applied', actor: 'system' })
  })

  it('shares verification for one invocation while cancellation only ends that caller\'s wait', async () => {
    const f = fixture()
    await f.hazard('old')
    const gate = verificationGate()
    const entered = Promise.withResolvers<AbortSignal>()
    let checks = 0
    const recovery = f.recovery({ verify: async (_id, options) => {
      checks++
      entered.resolve(options!.signal!)
      return gate.promise
    } })
    const controller = new AbortController()
    const first = recovery.recheck({ invocationIds: ['old'], signal: controller.signal })
    const sharedSignal = await entered.promise
    let secondFinished = false
    const second = recovery.recheck({ invocationIds: ['old'] }).then(() => {
      secondFinished = true
    })
    controller.abort()
    await first
    expect(sharedSignal.aborted).toBe(false)
    expect(secondFinished).toBe(false)
    gate.resolve(released)
    await second
    expect(checks).toBe(1)
    expect(f.repository.listUnreleased()).toEqual([])
  })

  it('preserves observed active and unknown facts while bounding background retries', async () => {
    const f = fixture()
    await f.hazard('old')
    let outcome = active
    let checks = 0
    const recovery = f.recovery({ verify: async () => {
      checks++
      return outcome
    } })
    await recovery.start()
    await flush()
    const next = await f.mutations.acquire({ runId: 'next-run', invocationId: 'next', claims: claims('old'), lifetime: 'runtime', signal })
    next.release()
    expect(f.evidence.latest('old')).toMatchObject({ outcome: 'active' })
    outcome = unknown
    await vi.advanceTimersByTimeAsync(60_000)
    const exhausted = checks
    expect(f.evidence.latest('old')).toMatchObject({ outcome: 'unknown' })
    expect(f.repository.listUnreleased()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(checks).toBe(exhausted)
    outcome = released
    f.mutations.recordOwnedProcessSettlement({ invocationId: 'old', processId: native('new-child'), settlement: 'unknown' })
    await flush()
    expect(f.repository.listUnreleased()).toEqual([])
    expect(f.evidence.decision('old')).toMatchObject({ kind: 'quiesced', outcome: 'applied' })
  })

  it('persists each verified process so a multi-process invocation can recover across verification budgets', async () => {
    const f = fixture()
    await f.hazard('old')
    for (const id of ['second', 'third'])
      f.mutations.recordOwnedProcessSettlement({ invocationId: 'old', processId: native(id), settlement: 'unknown' })
    const recovery = f.recovery({ verify: async () => {
      await new Promise(resolve => setTimeout(resolve, 2_000))
      return released
    } })
    const starting = recovery.start()
    await vi.advanceTimersByTimeAsync(5_000)
    await starting
    expect(f.repository.listUnreleased()[0]?.processes).toEqual(expect.arrayContaining([
      { processId: native('old'), settlement: 'released' },
      { processId: native('second'), settlement: 'released' },
      { processId: native('third'), settlement: 'unknown' },
    ]))
    expect(f.mutations.getHazards()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.repository.listUnreleased()).toEqual([])
    expect(f.evidence.decision('old')).toMatchObject({ kind: 'quiesced', outcome: 'applied' })
  })

  it('does not restart exhausted retries for duplicate notices about an already released process', async () => {
    const f = fixture()
    await f.hazard('old')
    f.mutations.recordOwnedProcessSettlement({ invocationId: 'old', processId: native('unknown-child'), settlement: 'unknown' })
    const recovery = f.recovery({ verify: async id => id === native('old') ? released : unknown })
    await recovery.start()
    await vi.advanceTimersByTimeAsync(60_000)
    const observations = f.database.prepare('SELECT count(*) AS count FROM run_mutation_evidence').get()
    for (let index = 0; index < 3; index++) {
      f.mutations.recordOwnedProcessSettlement({
        invocationId: 'old',
        processId: native('old'),
        settlement: 'unknown',
        launchState: 'settled',
        executionId: '11111111-1111-4111-8111-111111111111',
        dispatchId: '22222222-2222-4222-8222-222222222222',
      })
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.database.prepare('SELECT count(*) AS count FROM run_mutation_evidence').get()).toEqual(observations)
    expect(f.repository.listUnreleased()[0]?.processes).toEqual(expect.arrayContaining([
      { processId: native('old'), settlement: 'released' },
      { processId: native('unknown-child'), settlement: 'unknown' },
    ]))
    expect(f.evidence.decision('old')).toBeNull()
  })

  it('stops polling unverifiable legacy records without silently waiving their protection', async () => {
    const f = fixture()
    const lease = await f.mutations.acquire({ runId: 'legacy-run', invocationId: 'legacy', claims: claims('legacy'), lifetime: 'external', signal })
    lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
    const recovery = f.recovery()
    await recovery.start()
    await vi.advanceTimersByTimeAsync(60_000)
    const observations = f.database.prepare('SELECT count(*) AS count FROM run_mutation_evidence').get()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(f.database.prepare('SELECT count(*) AS count FROM run_mutation_evidence').get()).toEqual(observations)
    expect(f.evidence.latest('legacy')).toMatchObject({ outcome: 'unknown', reason: 'PROCESS_IDENTITY_MISSING' })
    expect(f.evidence.decision('legacy')).toBeNull()
    expect(f.repository.listUnreleased()).toHaveLength(1)
  })

  it.each(['quiesced', 'waived'] as const)('resumes a requested %s decision after transient native release failure', async (kind) => {
    let failing = true
    const f = fixture({
      acquire: async () => {},
      reconcile: async () => {},
      release: async (_id, protectedState) => {
        if (!protectedState && failing)
          throw new Error('NATIVE_RELEASE_FAILED')
      },
    })
    await f.hazard('old')
    if (kind === 'waived')
      await expect(f.mutations.waiveHazard('old')).rejects.toThrow('NATIVE_RELEASE_FAILED')
    const recovery = f.recovery({ verify: async () => released })
    await recovery.start()
    await flush()
    expect(f.evidence.decision('old')).toMatchObject({ kind, outcome: 'requested' })
    expect(f.repository.listUnreleased()).toHaveLength(1)
    failing = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.repository.listUnreleased()).toEqual([])
    expect(f.evidence.decision('old')).toMatchObject({ kind, outcome: 'applied', actor: kind === 'waived' ? 'user' : 'system' })
    expect(f.database.prepare('SELECT settlement FROM run_mutation_processes').get()).toEqual({ settlement: kind === 'waived' ? 'unknown' : 'released' })
  })

  it('keeps requested release protected past timeout until the coordinator finishes native settlement', async () => {
    const release = Promise.withResolvers<void>()
    const f = fixture({
      acquire: async () => {},
      reconcile: async () => {},
      release: async (_id, protectedState) => {
        if (!protectedState)
          await release.promise
      },
    })
    cleanups.push(() => release.resolve())
    await f.hazard('old')
    const recovery = f.recovery({ verify: async () => released })
    const starting = recovery.start()
    await vi.advanceTimersByTimeAsync(5_000)
    await starting
    expect(f.repository.listUnreleased()).toHaveLength(1)
    expect(f.evidence.decision('old')).toMatchObject({ kind: 'quiesced', outcome: 'requested' })
    await recovery.dispose()
    expect(f.repository.listUnreleased()).toHaveLength(1)
    release.resolve()
    await f.mutations.waitForSettlements()
    expect(f.repository.listUnreleased()).toEqual([])
  })

  it('cancels a pending acquire behind a real lease while background verification remains independent', async () => {
    const f = fixture()
    await f.hazard('old')
    const gate = verificationGate()
    const recovery = f.recovery({ verify: async () => gate.promise })
    await recovery.start()
    const running = await f.mutations.acquire({ runId: 'running-run', invocationId: 'running', claims: claims('old'), lifetime: 'runtime', signal })
    const effects: string[] = []
    const controller = new AbortController()
    const first = f.mutations.acquire({ runId: 'cancelled-run', invocationId: 'cancelled', claims: claims('old'), lifetime: 'runtime', signal: controller.signal }).then((lease) => {
      effects.push('cancelled')
      lease.release()
    })
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = f.mutations.acquire({ runId: 'next-run', invocationId: 'next', claims: claims('old'), lifetime: 'runtime', signal }).then((lease) => {
      effects.push('next')
      lease.release()
    })
    await flush()
    controller.abort()
    await cancelled
    expect(f.mutations.getRunState('cancelled-run')).toMatchObject({ pending: 0, active: 0 })
    expect(f.mutations.getRunState('next-run')).toMatchObject({ pending: 1, active: 0 })
    running.release()
    await second
    expect(effects).toEqual(['next'])
    expect(f.repository.listUnreleased().map(item => item.invocationId)).toEqual(['old'])
    gate.resolve(released)
    await recovery.recheck()
    expect(f.repository.listUnreleased()).toEqual([])
  })

  it('disposes background verification without blocking or rewriting subsequent operations', async () => {
    const f = fixture()
    const gate = verificationGate()
    const recovery = f.recovery({ verify: async () => gate.promise })
    await recovery.start()
    await f.hazard('old')
    const next = await f.mutations.acquire({ runId: 'next-run', invocationId: 'next', claims: claims('old'), lifetime: 'runtime', signal })
    next.release()
    await flush()
    await recovery.dispose()
    gate.resolve(released)
    await flush()
    expect(f.mutations.getRunState('next-run')).toMatchObject({ pending: 0, active: 0 })
    expect(f.repository.listUnreleased().map(item => item.invocationId)).toEqual(['old'])
    expect(f.mutations.getOwnedProcesses('old')).toEqual([{ processId: native('old'), settlement: 'unknown' }])
    const later = await f.mutations.acquire({ runId: 'later-run', invocationId: 'later', claims: claims('old'), lifetime: 'runtime', signal })
    later.release()
  })

  it.each(['verify', 'checkpoint'] as const)('discards a late %s result after disposal and database close', async (stage) => {
    const f = fixture()
    await f.hazard('old')
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let writes = 0
    const append = f.evidence.append
    f.evidence.append = (value) => {
      writes++
      append(value)
    }
    const recovery = f.recovery({
      verify: async () => {
        if (stage === 'verify') {
          entered.resolve()
          await gate.promise
        }
        return stage === 'verify' ? released : unknown
      },
      checkpoint: async () => {
        entered.resolve()
        await gate.promise
        return JSON.stringify({ kind: 'recovery-boot', version: 1, platform: process.platform, bootId: '11111111-1111-4111-8111-111111111111' })
      },
    })
    const checking = recovery.recheck()
    await entered.promise
    await recovery.dispose()
    await checking
    const writesAtDisposal = writes
    expect(f.repository.listUnreleased()[0]?.processes).toEqual([{ processId: native('old'), settlement: 'unknown' }])
    f.close()
    gate.resolve()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(writes).toBe(writesAtDisposal)
    expect(f.mutations.getOwnedProcesses('old')).toEqual([{ processId: native('old'), settlement: 'unknown' }])
  })

  it.each(['verify', 'checkpoint'] as const)('does not overwrite completed settlement with a late %s observation', async (stage) => {
    const f = fixture()
    await f.hazard('old')
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const recovery = f.recovery({
      verify: async () => {
        if (stage === 'verify') {
          entered.resolve()
          await gate.promise
        }
        return stage === 'verify' ? active : unknown
      },
      checkpoint: async () => {
        entered.resolve()
        await gate.promise
        return JSON.stringify({ kind: 'recovery-boot', version: 1, platform: process.platform, bootId: '11111111-1111-4111-8111-111111111111' })
      },
    })
    const checking = recovery.recheck()
    await entered.promise
    f.mutations.recordOwnedProcessSettlement({ invocationId: 'old', processId: native('old'), settlement: 'released' })
    await f.mutations.waitForSettlements()
    gate.resolve()
    await checking
    expect(f.repository.listUnreleased()).toEqual([])
    expect(f.evidence.latest('old')).toMatchObject({ kind: 'quiesced', outcome: 'applied' })
  })

  it('revalidates a queued waiver after the same invocation becomes active', async () => {
    const f = fixture()
    await f.hazard('old')
    const gate = verificationGate()
    const recovery = f.recovery({ context: context(f), verify: async () => gate.promise })
    const item = recovery.list({ conversationId: 'task' })[0]!
    const checking = recovery.recheck()
    const resolving = recovery.resolve({ conversationId: 'task', decision: 'waived', items: [item] })
    const rejected = expect(resolving).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await flush()
    gate.resolve(active)
    await checking
    await rejected
    expect(f.evidence.decision('old')).toBeNull()
    expect(recovery.list({ conversationId: 'task' })[0]).toMatchObject({ status: 'active' })
    expect(f.repository.listUnreleased()).toHaveLength(1)
  })

  it('allows new work immediately while historical verification keeps its background order', async () => {
    const f = fixture()
    for (const id of ['one', 'two', 'three', 'four', 'five'])
      await f.hazard(id)
    const gate = verificationGate()
    const visited: string[] = []
    const recovery = f.recovery({ verify: async (id) => {
      visited.push(id)
      return [native('one'), native('two')].includes(id) ? gate.promise : id === native('five') ? released : unknown
    } })
    const starting = recovery.start()
    await flush()
    const writer = await f.mutations.acquire({ runId: 'writer-run', invocationId: 'writer', claims: claims('five'), lifetime: 'runtime', signal })
    writer.release()
    await flush()
    expect(visited).toEqual([native('one'), native('two')])
    const unrelated = await f.mutations.acquire({ runId: 'free-run', invocationId: 'free', claims: claims('free'), lifetime: 'runtime', signal })
    unrelated.release()
    gate.resolve(unknown)
    await starting
    await flush()
    expect(visited).toEqual(['one', 'two', 'three', 'four', 'five'].map(native))
    expect(f.repository.isReleased('five')).toBe(true)
    expect(f.repository.listUnreleased().map(item => item.invocationId).sort()).toEqual(['four', 'one', 'three', 'two'])
  })

  it('does not schedule background work until explicitly started', async () => {
    const f = fixture()
    await f.hazard('old')
    const recovery = f.recovery({ verify: async () => unknown })
    await recovery.recheck()
    const observations = f.database.prepare('SELECT count(*) AS count FROM run_mutation_evidence').get()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(f.database.prepare('SELECT count(*) AS count FROM run_mutation_evidence').get()).toEqual(observations)
    expect(f.repository.listUnreleased()).toHaveLength(1)
  })

  it('isolates a failed invocation verification from other recoverable hazards', async () => {
    const f = fixture()
    await f.hazard('bad')
    await f.hazard('good')
    const recovery = f.recovery({ verify: async (id) => {
      if (id === native('bad'))
        throw new Error('VERIFIER_UNAVAILABLE')
      return released
    } })
    await recovery.recheck()
    expect(f.repository.isReleased('good')).toBe(true)
    expect(f.repository.listUnreleased().map(item => item.invocationId)).toEqual(['bad'])
    expect(f.evidence.latest('bad')).toMatchObject({ outcome: 'unknown', reason: 'RECOVERY_VERIFICATION_FAILED' })
  })
})

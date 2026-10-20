import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { MutationCoordinator } from '../MutationCoordinator'
import { createMutationRepository } from '../mutationRepository'

const coordinators: MutationCoordinator[] = []
afterEach(() => coordinators.splice(0).forEach(coordinator => coordinator.dispose()))

function setup() {
  const coordinator = new MutationCoordinator()
  coordinators.push(coordinator)
  return coordinator
}

describe('mutation ownership', () => {
  it('keeps conflicting writers queued during native settlement but fences late process dispatch', async () => {
    const released = Promise.withResolvers<void>()
    const mutations = new MutationCoordinator({ resources: { acquire: async () => {}, reconcile: async () => {}, release: async () => released.promise } })
    coordinators.push(mutations)
    const input = { lifetime: 'external' as const, claims: [{ kind: 'host' as const }], signal: new AbortController().signal }
    const lease = await mutations.acquire({ ...input, runId: 'first', invocationId: 'first' })
    lease.release()
    expect(mutations.recordOwnedProcessSettlement({ invocationId: 'first', processId: 'late-process', settlement: 'pending' })).toBe(false)
    const waiting = mutations.acquire({ ...input, runId: 'next', invocationId: 'next' })
    expect(mutations.getRunState('next')).toMatchObject({ active: 0, pending: 1 })
    released.resolve()
    const next = await waiting
    next.release()
    await mutations.waitForSettlements()
    expect(mutations.getRunState('first')).toMatchObject({ active: 0, hazards: [] })
  })

  it('never admits a new process through an already hazardous invocation', async () => {
    const mutations = setup()
    const lease = await mutations.acquire({ runId: 'first', invocationId: 'first', lifetime: 'external', claims: [{ kind: 'host' }], signal: new AbortController().signal })
    lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
    expect(mutations.recordOwnedProcessSettlement({ invocationId: 'first', processId: 'late-process', settlement: 'pending' })).toBe(false)
    expect(mutations.getRunState('first').hazards).toHaveLength(1)
  })

  it('takes all claims atomically while unrelated paths continue and cancelled waiters never start', async () => {
    const mutations = setup()
    const signal = new AbortController().signal
    const a = await mutations.acquire({ lifetime: 'runtime' as const, runId: 'a', invocationId: 'a1', claims: [{ kind: 'tree', canonicalPath: '/workspace/a' }], signal })
    const pending = new AbortController()
    const b = mutations.acquire({ lifetime: 'runtime' as const, runId: 'b', invocationId: 'b1', claims: [{ kind: 'file', canonicalPath: '/workspace/b.txt' }, { kind: 'file', canonicalPath: '/workspace/a/nested.txt' }], signal: pending.signal })
    const cancelled = expect(b).rejects.toMatchObject({ name: 'AbortError' })
    const c = await mutations.acquire({ lifetime: 'runtime' as const, runId: 'c', invocationId: 'c1', claims: [{ kind: 'file', canonicalPath: '/workspace/ab/nested.txt' }], signal })
    expect(mutations.getRunState('b')).toEqual({ pending: 1, active: 0, hazards: [] })
    expect(mutations.getRunState('c').active).toBe(1)
    pending.abort()
    await cancelled
    a.release()
    c.release()
    expect(await mutations.waitForRun('b')).toEqual({ pending: 0, active: 0, hazards: [] })
    const next = await mutations.acquire({ lifetime: 'runtime' as const, runId: 'd', invocationId: 'd1', claims: [{ kind: 'file', canonicalPath: '/workspace/b.txt' }], signal })
    next.release()
  })

  it('persists unsafe claims independently of capture and only clears them after every owned process settles', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const repository = createMutationRepository(database)
      const first = new MutationCoordinator({ repository })
      coordinators.push(first)
      const input = { lifetime: 'external' as const, runId: 'deleted-run', invocationId: 'owned-shell', claims: [{ kind: 'tree' as const, canonicalPath: '/workspace' }], signal: new AbortController().signal }
      const lease = await first.acquire(input)
      await first.withInvocation(lease, async () => {
        expect(first.recordOwnedProcessSettlement({ processId: 'parent', settlement: 'pending' })).toBe(true)
        expect(first.recordOwnedProcessSettlement({ processId: 'child', settlement: 'pending' })).toBe(true)
        first.recordOwnedProcessSettlement({ processId: 'parent', settlement: 'released' })
      })
      first.dispose()
      const recovered = new MutationCoordinator({ repository })
      coordinators.push(recovered)
      expect(recovered.getRunState(input.runId)).toMatchObject({ active: 0, pending: 0, hazards: [{ invocationId: input.invocationId, reason: 'MUTATION_INTERRUPTED' }] })
      await expect(recovered.acquire({ ...input, invocationId: 'overlap' })).rejects.toMatchObject({ code: 'MUTATION_RESOURCE_UNSAFE' })
      recovered.recordOwnedProcessSettlement({ invocationId: input.invocationId, processId: 'parent', settlement: 'unknown' })
      expect(recovered.getRunState(input.runId).hazards).toHaveLength(1)
      recovered.recordOwnedProcessSettlement({ invocationId: input.invocationId, processId: 'child', settlement: 'released' })
      expect(recovered.getRunState(input.runId).hazards).toEqual([])
      expect(repository.listUnreleased()).toEqual([])
      const restarted = new MutationCoordinator({ repository })
      coordinators.push(restarted)
      const next = await restarted.acquire({ ...input, invocationId: 'new-writer' })
      next.release()
      expect(repository.listUnreleased()).toEqual([])
    }
    finally { database.close() }
  })

  it.each(['file', 'released-processes'] as const)('recovers a crashed %s lease without replaying its tool or waiting for a lost callback', async (kind) => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const repository = createMutationRepository(database)
      const first = new MutationCoordinator({ repository })
      coordinators.push(first)
      const input = { lifetime: kind === 'file' ? 'runtime' as const : 'external' as const, runId: 'interrupted', invocationId: 'old', claims: [{ kind: 'host' as const }], signal: new AbortController().signal }
      await first.acquire(input)
      if (kind === 'released-processes') {
        for (const processId of ['supervisor-a', 'supervisor-b'])
          first.recordOwnedProcessSettlement({ invocationId: 'old', processId, settlement: 'released' })
      }
      first.dispose()
      const recovered = new MutationCoordinator({ repository })
      coordinators.push(recovered)
      expect(recovered.getRunState('interrupted').hazards).toEqual([])
      expect(repository.listUnreleased()).toEqual([])
      const lease = await recovered.acquire({ ...input, runId: 'next', invocationId: 'next' })
      lease.release()
      expect(repository.listUnreleased()).toEqual([])
    }
    finally { database.close() }
  })

  it('keeps a supervised lease unsafe when the process handshake was not durably recorded', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const repository = createMutationRepository(database)
      const first = new MutationCoordinator({ repository })
      coordinators.push(first)
      const input = { lifetime: 'external' as const, runId: 'interrupted', invocationId: 'old', claims: [{ kind: 'host' as const }], signal: new AbortController().signal }
      await first.acquire(input)
      first.dispose()
      const recovered = new MutationCoordinator({ repository })
      coordinators.push(recovered)
      await expect(recovered.acquire({ ...input, invocationId: 'next' })).rejects.toMatchObject({ code: 'MUTATION_RESOURCE_UNSAFE' })
      expect(repository.listUnreleased()).toHaveLength(1)
    }
    finally { database.close() }
  })

  it('preserves same-execution continuity but splits root, child and resumed root ownership', async () => {
    const mutations = setup()
    const input = { lifetime: 'runtime' as const, claims: [{ kind: 'file' as const, canonicalPath: '/workspace/file.txt' }], signal: new AbortController().signal }
    const first = await mutations.acquire({ ...input, runId: 'root', invocationId: 'root-1' })
    const same = mutations.acquire({ ...input, runId: 'root', invocationId: 'root-2' })
    expect(mutations.getRunState('root')).toMatchObject({ active: 1, pending: 1 })
    first.release()
    const second = await same
    expect(second.segmentId).toBe(first.segmentId)
    second.release()
    const child = await mutations.acquire({ ...input, runId: 'child', invocationId: 'child-1' })
    child.release()
    const resumed = await mutations.acquire({ ...input, runId: 'root', invocationId: 'root-3' })
    expect(new Set([first.segmentId, child.segmentId, resumed.segmentId]).size).toBe(3)
    expect(resumed.sequence).toBeGreaterThan(child.sequence)
    resumed.release()
  })

  it('settles an unsafe execution without releasing its resource and restores that hazard independently', async () => {
    const mutations = setup()
    const input = { lifetime: 'external' as const, claims: [{ kind: 'host' as const }], signal: new AbortController().signal }
    const lease = await mutations.acquire({ ...input, runId: 'failed', invocationId: 'host-1' })
    const settled = mutations.waitForRun('failed')
    const waiting = mutations.acquire({ ...input, runId: 'next', invocationId: 'next-1' })
    const blocked = expect(waiting).rejects.toMatchObject({ code: 'MUTATION_RESOURCE_UNSAFE' })
    lease.markHazard('PROCESS_CLEANUP_UNCONFIRMED')
    await blocked
    const state = await settled
    expect(state).toMatchObject({ pending: 0, active: 0, hazards: [{ invocationId: 'host-1', runId: 'failed' }] })
    lease.release()
    expect(mutations.getRunState('failed').hazards).toHaveLength(1)
    const restored = setup()
    restored.restoreHazard(state.hazards[0]!)
    await expect(restored.acquire({ ...input, runId: 'other', invocationId: 'other-1' })).rejects.toMatchObject({ code: 'MUTATION_RESOURCE_UNSAFE' })
    await expect(restored.confirmReleased('host-1')).rejects.toThrow('PROCESS_RELEASE_EVIDENCE_MISSING')
    restored.recordOwnedProcessSettlement({ invocationId: 'host-1', processId: 'verified-original', settlement: 'released' })
    await restored.confirmReleased('host-1')
    const recovered = await restored.acquire({ ...input, runId: 'other', invocationId: 'other-2' })
    expect(restored.getRunState('failed').hazards).toEqual([])
    recovered.release()
  })
})

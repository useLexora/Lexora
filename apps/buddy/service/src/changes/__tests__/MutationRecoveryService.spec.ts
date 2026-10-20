import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { MutationCoordinator } from '../MutationCoordinator'
import { MutationRecoveryService } from '../MutationRecoveryService'
import { createMutationRepository } from '../mutationRepository'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const signal = new AbortController().signal
const checkpoint = JSON.stringify({ kind: 'recovery-boot', version: 1, platform: process.platform, bootId: '11111111-1111-4111-8111-111111111111' })
const native = (nonce: string, requestId?: string) => JSON.stringify({ kind: 'native-shell', platform: process.platform, pid: 123, startTime: '123', nonce, ...(requestId ? { requestId } : {}) })
const dispatch = (requestId: string) => JSON.stringify({ kind: 'sandbox-dispatch', requestId })

async function fixture(processIds: string[]) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanups.push(() => database.close())
  const repository = createMutationRepository(database)
  const mutations = new MutationCoordinator({ repository })
  cleanups.push(() => mutations.dispose())
  const lease = await mutations.acquire({ runId: 'run', invocationId: 'invocation', lifetime: 'external', claims: [{ kind: 'tree', canonicalPath: '/workspace' }], signal })
  for (const processId of processIds)
    mutations.recordOwnedProcessSettlement({ invocationId: lease.invocationId, processId, settlement: 'unknown' })
  lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
  return { database, repository, mutations }
}

describe('mutation recovery evidence', () => {
  it('retains malformed dispatch identities instead of associating absent request identifiers', async () => {
    const f = await fixture([JSON.stringify({ kind: 'sandbox-dispatch' }), native('old')])
    f.mutations.recordOwnedProcessSettlement({ invocationId: 'invocation', processId: native('old'), settlement: 'released' })
    const recovery = new MutationRecoveryService({ mutations: f.mutations, checkpoint: async () => null })
    await recovery.recheck()
    expect(f.repository.listUnreleased()).toHaveLength(1)
  })

  it('retains a child reported while verification was awaiting its original snapshot', async () => {
    const f = await fixture([native('old')])
    const recovery = new MutationRecoveryService({ mutations: f.mutations, verify: async () => {
      f.mutations.recordOwnedProcessSettlement({ invocationId: 'invocation', processId: 'late-child', settlement: 'unknown' })
      return { status: 'released', reason: 'supervisor_receipt' }
    } })
    await recovery.recheck()
    expect(f.repository.listUnreleased()[0]?.processes).toContainEqual({ processId: 'late-child', settlement: 'unknown' })
    expect(f.mutations.getHazards()).toHaveLength(1)
  })

  it('releases dispatch and job together only after every associated process is proven released', async () => {
    const f = await fixture([dispatch('request'), JSON.stringify({ kind: 'native-shell-dispatch', nonce: 'nonce', requestId: 'request' }), native('nonce', 'request')])
    const recovery = new MutationRecoveryService({ mutations: f.mutations, verify: async () => ({ status: 'released', reason: 'boot_changed' }) })
    await recovery.recheck()
    expect(f.repository.listUnreleased()).toEqual([])
    const writer = await f.mutations.acquire({ runId: 'other', invocationId: 'writer', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    writer.release()
  })

  it('retains observed descendants and malformed identities as warnings without blocking new work', async () => {
    const f = await fixture([dispatch('other-request'), native('nonce', 'request'), 'invalid'])
    const recovery = new MutationRecoveryService({ mutations: f.mutations, verify: async () => ({ status: 'active', reason: 'job_active' }), checkpoint: async () => null })
    await recovery.recheck()
    const next = await f.mutations.acquire({ runId: 'next', invocationId: 'next', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    next.release()
    expect(f.mutations.getOwnedProcesses('invocation').every(item => item.settlement === 'unknown')).toBe(true)
    expect(f.repository.listUnreleased()).toHaveLength(1)
  })

  it('does not release an MCP or an external lease with no handshake', async () => {
    const f = await fixture([])
    const recovery = new MutationRecoveryService({ mutations: f.mutations, verify: async () => ({ status: 'released', reason: 'boot_changed' }), checkpoint: async () => checkpoint })
    await recovery.recheck()
    const next = await f.mutations.acquire({ runId: 'next', invocationId: 'next', lifetime: 'external', claims: [{ kind: 'host' }], signal })
    next.release()
    expect(f.mutations.getOwnedProcesses('invocation')).toEqual([])
    expect(f.repository.listUnreleased()).toHaveLength(1)
  })

  it('persists a legacy boot checkpoint and can resume recovery after another runtime interruption', async () => {
    const f = await fixture([dispatch('legacy'), native('legacy')])
    const first = new MutationRecoveryService({ mutations: f.mutations, verify: async () => ({ status: 'unknown', reason: 'legacy_identity' }), checkpoint: async () => checkpoint })
    await first.recheck()
    expect(f.repository.listUnreleased()[0]?.processes).toContainEqual({ processId: checkpoint, settlement: 'pending' })
    await f.mutations.dispose()
    const restored = new MutationCoordinator({ repository: f.repository })
    cleanups.push(() => restored.dispose())
    const next = new MutationRecoveryService({ mutations: restored, verify: async (_id, options) => options?.checkpoint === checkpoint ? { status: 'released', reason: 'boot_changed' } : { status: 'unknown', reason: 'legacy_identity' } })
    await next.recheck()
    expect(f.repository.listUnreleased()).toEqual([])
  })

  it('does not release a second unmatched dispatch when one job was verified', async () => {
    const f = await fixture([dispatch('one'), dispatch('two'), native('nonce', 'one')])
    const recovery = new MutationRecoveryService({ mutations: f.mutations, verify: async () => ({ status: 'released', reason: 'boot_changed' }), checkpoint: async () => null })
    await recovery.recheck()
    expect(f.mutations.getHazards()).toHaveLength(1)
    expect(f.mutations.getOwnedProcesses('invocation').find(item => item.processId === dispatch('two'))?.settlement).toBe('unknown')
  })

  it('bounds waiting for native reconciliation without removing the protection early', async () => {
    const released = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    const mutations = new MutationCoordinator({ resources: { acquire: async () => {}, reconcile: async () => {}, release: async () => {
      requested.resolve()
      return released.promise
    } } })
    cleanups.push(() => mutations.dispose())
    mutations.restoreHazard({ runId: 'run', invocationId: 'invocation', claims: [{ kind: 'host' }], reason: 'FILE_RESOURCE_SETTLEMENT_FAILED' })
    const controller = new AbortController()
    const recovery = new MutationRecoveryService({ mutations })
    const pending = recovery.recheck({ signal: controller.signal })
    await requested.promise
    controller.abort()
    await pending
    expect(mutations.getHazards()).toHaveLength(1)
    released.resolve()
    await mutations.waitForSettlements()
    expect(mutations.getHazards()).toEqual([])
  })

  it('bounds startup verification without treating cancellation as release evidence', async () => {
    const f = await fixture([native('nonce')])
    const controller = new AbortController()
    const recovery = new MutationRecoveryService({ mutations: f.mutations, verify: async () => {
      controller.abort()
      throw controller.signal.reason
    } })
    await expect(recovery.recheck({ signal: controller.signal })).resolves.toBeUndefined()
    expect(f.repository.listUnreleased()).toHaveLength(1)
  })
})

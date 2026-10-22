import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMigrationFixtureDatabase } from '../../storage/__tests__/migrationFixture'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { BUDDY_SCHEMA_MIGRATIONS } from '../../storage/schema'
import { MutationCoordinator } from '../MutationCoordinator'
import { createMutationEvidenceRepository } from '../mutationEvidenceRepository'
import { MutationRecoveryService } from '../MutationRecoveryService'
import { createMutationRepository } from '../mutationRepository'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const signal = new AbortController().signal

function setup(database: DatabaseSync) {
  const repository = createMutationRepository(database)
  const evidence = createMutationEvidenceRepository(database)
  const mutations = new MutationCoordinator({ repository, evidence })
  cleanups.push(() => mutations.dispose())
  return { repository, evidence, mutations }
}

async function memoryFixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanups.push(() => database.close())
  return { database, ...setup(database) }
}

async function hazard(mutations: MutationCoordinator, invocationId = 'old', runId = 'old-run') {
  const lease = await mutations.acquire({ invocationId, runId, lifetime: 'external', claims: [{ kind: 'host' }], signal })
  mutations.recordOwnedProcessSettlement({ invocationId, processId: JSON.stringify({ kind: 'sandbox-dispatch', requestId: invocationId }), settlement: 'unknown' })
  lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
  await mutations.waitForSettlements()
}

function context(database: DatabaseSync) {
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const now = '2026-10-01T00:00:00.000Z'
  for (const id of ['old', 'next', 'unrelated']) {
    conversations.create({ id, branchId: id, createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, title: id })
    conversations.createMessage({ id: `question-${id}`, conversationId: id, branchId: id, role: 'user', runId: null, createdAt: now, content: { text: id } })
    runs.create({ id: `${id}-run`, conversationId: id, branchId: id, triggeringMessageId: `question-${id}`, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'failed', startedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', piSessionFile: null })
  }
  return { conversations, runs }
}

describe('durable mutation recovery decisions', () => {
  it('migrates six legacy records and keeps a waiver distinct from process release after reopening twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutation-recovery-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const databasePath = join(root, 'buddy.sqlite3')
    let database = openMigrationFixtureDatabase(databasePath)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 30))
      database.exec(migration.sql)
    const now = '2026-10-01T00:00:00.000Z'
    for (let index = 0; index < 6; index++) {
      const id = `legacy-${index}`
      database.prepare('INSERT INTO run_mutation_leases (invocation_id, run_id, segment_id, claims_json, lifetime, status, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, id, id, JSON.stringify([{ kind: 'tree', canonicalPath: join(root, id) }]), 'external', 'hazard', 'OWNED_PROCESS_CLEANUP_UNCONFIRMED', now, now)
      const process = index === 5 ? { kind: 'sandbox-dispatch', requestId: randomUUID() } : { kind: 'native-shell', platform: 'win32', pid: index + 1, startTime: '1', nonce: randomUUID() }
      database.prepare('INSERT INTO run_mutation_processes (invocation_id, process_id, settlement, updated_at) VALUES (?, ?, ?, ?)').run(id, JSON.stringify(process), 'unknown', now)
    }
    database.exec('PRAGMA user_version = 30')
    database.close()
    database = openBuddyDatabase({ databasePath })
    let f = setup(database)
    expect(f.repository.listUnreleased()).toHaveLength(6)
    for (const item of f.mutations.getHazards()) await f.mutations.waiveHazard(item.invocationId)
    expect(database.prepare('SELECT count(*) AS count FROM run_mutation_processes WHERE settlement = \'unknown\'').get()).toEqual({ count: 6 })
    expect(database.prepare('SELECT count(*) AS count FROM run_mutation_evidence WHERE kind = \'waived\' AND outcome = \'applied\' AND actor = \'user\'').get()).toEqual({ count: 6 })
    await f.mutations.dispose()
    database.close()
    database = openBuddyDatabase({ databasePath })
    cleanups.push(() => database.close())
    f = setup(database)
    await f.mutations.initialize()
    expect(f.mutations.getHazards()).toEqual([])
    expect(database.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const next = await f.mutations.acquire({ invocationId: 'next', runId: 'next', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    next.release()
  })

  it('resumes only the recorded decision after native protection release fails', async () => {
    const f = await memoryFixture()
    let fail = true
    const resources = {
      acquire: async () => {},
      reconcile: async () => {},
      release: async (_id: string, protectedState: boolean) => {
        if (!protectedState && fail)
          throw new Error('NATIVE_RELEASE_FAILED')
      },
    }
    const first = new MutationCoordinator({ repository: f.repository, evidence: f.evidence, resources })
    cleanups.push(() => first.dispose())
    await hazard(first)
    await expect(first.waiveHazard('old')).rejects.toThrow('NATIVE_RELEASE_FAILED')
    expect(first.getHazards()).toHaveLength(1)
    expect(f.evidence.decision('old')).toMatchObject({ kind: 'waived', outcome: 'requested' })
    await first.dispose()
    fail = false
    const restored = new MutationCoordinator({ repository: f.repository, evidence: f.evidence, resources })
    cleanups.push(() => restored.dispose())
    await restored.initialize()
    await restored.waitForSettlements()
    expect(restored.getHazards()).toEqual([])
    expect(f.evidence.decision('old')).toMatchObject({ kind: 'waived', outcome: 'applied' })
    expect(f.database.prepare('SELECT settlement FROM run_mutation_processes').get()).toEqual({ settlement: 'unknown' })
  })

  it('shows admitted cross-task overlaps without blocking and rejects stale or active decisions', async () => {
    const f = await memoryFixture()
    const scope = context(f.database)
    await hazard(f.mutations)
    const recovery = new MutationRecoveryService({ mutations: f.mutations, evidence: f.evidence, context: scope, checkpoint: async () => null })
    expect(recovery.list({ conversationId: 'next' })).toEqual([])
    const next = await f.mutations.acquire({ invocationId: 'next-attempt', runId: 'next-run', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    expect(f.mutations.getRunState('next-run').active).toBe(1)
    next.release()
    expect(f.database.prepare('SELECT reason, related_run_id FROM run_mutation_evidence WHERE related_run_id IS NOT NULL').all()).toEqual([{ reason: 'RESOURCE_OVERLAP', related_run_id: 'next-run' }])
    const item = recovery.list({ conversationId: 'next' })[0]!
    expect(item).toMatchObject({ invocationId: 'old', conversationId: 'old' })
    expect(recovery.list({ conversationId: 'unrelated' })).toEqual([])
    await expect(recovery.resolve({ conversationId: 'unrelated', items: [item], decision: 'waived' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    f.evidence.append({ invocationId: 'old', actor: 'system', kind: 'observed', outcome: 'active', reason: 'supervisor_active' })
    await expect(recovery.resolve({ conversationId: 'next', items: [item], decision: 'waived' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    f.evidence.append({ invocationId: 'old', actor: 'system', kind: 'observed', outcome: 'unknown', reason: 'job_not_found' })
    await expect(recovery.resolve({ conversationId: 'next', items: [item], decision: 'waived' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const current = recovery.list({ conversationId: 'next' })[0]!
    await recovery.resolve({ conversationId: 'next', items: [current], decision: 'waived' })
    expect(recovery.list({ conversationId: 'next' })).toEqual([])
    expect(f.database.prepare('SELECT settlement FROM run_mutation_processes').get()).toEqual({ settlement: 'unknown' })
  })

  it('records only admitted overlapping requests and publishes the notice without weakening active ownership', async () => {
    const f = await memoryFixture()
    const scope = context(f.database)
    const recovery = new MutationRecoveryService({ mutations: f.mutations, evidence: f.evidence, context: scope })
    const root = join(tmpdir(), 'mutation-overlap', 'shared')
    const old = await f.mutations.acquire({ invocationId: 'old', runId: 'old-run', lifetime: 'external', claims: [{ kind: 'tree', canonicalPath: root }], signal })
    f.mutations.recordOwnedProcessSettlement({ invocationId: 'old', processId: 'unverified-owner', settlement: 'unknown' })
    const observed: { active: number, invocationIds: string[] }[] = []
    const subscription = f.mutations.onDidChange(({ runId }) => {
      if (runId === 'next-run')
        observed.push({ active: f.mutations.getRunState(runId).active, invocationIds: recovery.list({ conversationId: 'next' }).map(item => item.invocationId) })
    })
    cleanups.push(() => subscription.dispose())
    const input = { runId: 'next-run', lifetime: 'runtime' as const, claims: [{ kind: 'file' as const, canonicalPath: join(root, 'note.txt') }], signal }
    const pending = f.mutations.acquire({ ...input, invocationId: 'next' })
    const controller = new AbortController()
    const cancelled = f.mutations.acquire({ ...input, runId: 'unrelated-run', invocationId: 'cancelled', signal: controller.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    const unrelated = await f.mutations.acquire({ ...input, runId: 'unrelated-run', invocationId: 'unrelated', claims: [{ kind: 'file', canonicalPath: join(`${root}-other`, 'note.txt') }] })
    unrelated.release()
    expect(f.mutations.getRunState('next-run')).toMatchObject({ active: 0, pending: 1 })
    expect(f.evidence.relatedRuns('old')).toEqual([])
    old.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
    const next = await pending
    expect(observed).toContainEqual({ active: 1, invocationIds: ['old'] })
    next.release()
    const repeated = await f.mutations.acquire({ ...input, invocationId: 'next-repeat' })
    repeated.release()
    expect(f.evidence.relatedRuns('old')).toEqual(['next-run'])
    expect(f.evidence.latest('old')).toBeNull()
    expect(recovery.list({ conversationId: 'unrelated' })).toEqual([])
    expect(f.database.prepare('SELECT reason, related_run_id FROM run_mutation_evidence').all()).toEqual([{ reason: 'RESOURCE_OVERLAP', related_run_id: 'next-run' }])
    expect(f.mutations.getOwnedProcesses('old')).toEqual([{ processId: 'unverified-owner', settlement: 'unknown' }])
  })

  it('preserves new overlap notices and legacy blocked associations after reopening without rewriting evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutation-overlap-reopen-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const databasePath = join(root, 'buddy.sqlite3')
    let database = openBuddyDatabase({ databasePath })
    cleanups.push(() => database.close())
    let f = setup(database)
    context(database)
    await hazard(f.mutations)
    const next = await f.mutations.acquire({ invocationId: 'next', runId: 'next-run', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    next.release()
    f.evidence.append({ invocationId: 'old', kind: 'observed', outcome: 'unknown', reason: 'WRITE_BLOCKED', actor: 'system', relatedRunId: 'unrelated-run' })
    const before = database.prepare('SELECT * FROM run_mutation_evidence ORDER BY sequence').all()
    expect(before.map(row => row.reason)).toEqual(['RESOURCE_OVERLAP', 'WRITE_BLOCKED'])
    await f.mutations.dispose()
    database.close()
    database = openBuddyDatabase({ databasePath })
    f = setup(database)
    const recovery = new MutationRecoveryService({ mutations: f.mutations, evidence: f.evidence, context: {
      conversations: createConversationRepository(database),
      runs: createRunRepository(database),
    } })
    for (const conversationId of ['next', 'unrelated'])
      expect(recovery.list({ conversationId })).toEqual([expect.objectContaining({ invocationId: 'old', status: 'unknown', conversationId: 'old' })])
    expect(database.prepare('SELECT * FROM run_mutation_evidence ORDER BY sequence').all()).toEqual(before)
    expect(f.mutations.getInvocationSettlement('old')).toBe('unknown')
  })

  it('does not turn a failed risk-notice write into an admission lock or a successful recovery', async () => {
    const f = await memoryFixture()
    await hazard(f.mutations)
    f.database.exec(`CREATE TRIGGER reject_overlap BEFORE INSERT ON run_mutation_evidence
      WHEN NEW.related_run_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'notice unavailable'); END`)
    const next = await f.mutations.acquire({ invocationId: 'next', runId: 'next-run', lifetime: 'runtime', claims: [{ kind: 'host' }], signal })
    expect(f.mutations.getRunState('next-run').active).toBe(1)
    expect(f.evidence.relatedRuns('old')).toEqual([])
    expect(f.evidence.decision('old')).toBeNull()
    expect(f.mutations.getInvocationSettlement('old')).toBe('unknown')
    next.release()
    expect(f.repository.listUnreleased().map(item => item.invocationId)).toEqual(['old'])
  })

  it('atomically binds launch authorization and never rolls it back to prepared', async () => {
    const f = await memoryFixture()
    const executionId = randomUUID()
    const dispatchId = randomUUID()
    const lease = await f.mutations.acquire({ invocationId: 'run', runId: 'run', lifetime: 'external', claims: [{ kind: 'host' }], signal })
    const record = { invocationId: 'run', processId: 'dispatch', settlement: 'pending' as const, executionId, dispatchId }
    f.mutations.recordOwnedProcessSettlement({ ...record, launchState: 'prepared' })
    f.mutations.recordOwnedProcessSettlement({ ...record, processId: 'identity', launchState: 'authorized' })
    expect(() => f.mutations.recordOwnedProcessSettlement({ ...record, processId: 'second-launch', launchState: 'authorized' })).toThrow('MUTATION_EXECUTION_CONFLICT')
    f.mutations.recordOwnedProcessSettlement({ ...record, launchState: 'prepared' })
    expect(f.database.prepare('SELECT launch_state FROM run_mutation_executions').get()).toEqual({ launch_state: 'authorized' })
    expect(() => f.mutations.recordOwnedProcessSettlement({ ...record, processId: 'wrong', dispatchId: randomUUID(), launchState: 'authorized' })).toThrow('MUTATION_EXECUTION_CONFLICT')
    expect(f.mutations.getOwnedProcesses('run').some(process => process.processId === 'wrong')).toBe(false)
    f.mutations.recordOwnedProcessSettlement({ ...record, processId: 'identity', settlement: 'released', launchState: 'settled' })
    expect(() => f.mutations.recordOwnedProcessSettlement({ ...record, processId: 'late-start', launchState: 'authorized' })).toThrow('MUTATION_EXECUTION_CONFLICT')
    lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
    await f.mutations.waitForSettlements()
  })

  it('does not apply a queued user decision cancelled before durable acceptance', async () => {
    const f = await memoryFixture()
    const scope = context(f.database)
    const lease = await f.mutations.acquire({ invocationId: 'old', runId: 'old-run', lifetime: 'external', claims: [{ kind: 'host' }], signal })
    f.mutations.recordOwnedProcessSettlement({ invocationId: 'old', processId: JSON.stringify({ kind: 'native-shell', platform: 'linux', nonce: 'nonce', pid: 1, startTime: '1' }), settlement: 'unknown' })
    lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const recovery = new MutationRecoveryService({ mutations: f.mutations, evidence: f.evidence, context: scope, checkpoint: async () => null, verify: async () => {
      entered.resolve()
      await gate.promise
      return { status: 'unknown', reason: 'legacy_identity' }
    } })
    const checking = recovery.recheck()
    await entered.promise
    const controller = new AbortController()
    const pending = recovery.resolve({ conversationId: 'old', items: recovery.list({ conversationId: 'old' }), decision: 'waived' }, controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    gate.resolve()
    await checking
    await assertion
    expect(f.evidence.decision('old')).toBeNull()
    expect(f.mutations.getHazards()).toHaveLength(1)
  })

  it('keeps verified recovery requested until native protection has actually settled after restart', async () => {
    const f = await memoryFixture()
    await hazard(f.mutations)
    f.database.prepare('UPDATE run_mutation_processes SET settlement = \'released\'').run()
    f.evidence.append({ invocationId: 'old', kind: 'quiesced', outcome: 'requested', actor: 'system', reason: 'PROCESS_RELEASE_CONFIRMED' })
    const restored = new MutationCoordinator({ repository: f.repository, evidence: f.evidence, resources: {
      acquire: async () => {},
      reconcile: async () => {},
      release: async () => {
        expect(f.repository.isReleased('old')).toBe(false)
        expect(f.evidence.decision('old')).toMatchObject({ outcome: 'requested' })
      },
    } })
    cleanups.push(() => restored.dispose())
    expect(restored.getHazards()).toHaveLength(1)
    await restored.initialize()
    await restored.waitForSettlements()
    expect(restored.getHazards()).toEqual([])
    expect(f.evidence.decision('old')).toMatchObject({ kind: 'quiesced', outcome: 'applied' })
  })

  it('cannot waive without a durable audit repository', async () => {
    const mutations = new MutationCoordinator()
    cleanups.push(() => mutations.dispose())
    await hazard(mutations)
    await expect(mutations.waiveHazard('old')).rejects.toThrow('MUTATION_RECOVERY_AUDIT_UNAVAILABLE')
    expect(mutations.getHazards()).toHaveLength(1)
  })
})

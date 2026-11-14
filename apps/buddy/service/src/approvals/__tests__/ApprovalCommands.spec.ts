import type { DatabaseSync } from 'node:sqlite'
import type { ApprovalRequest } from '../ApprovalService'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_QUERY_METHODS } from '../../../../shared/productProtocol/queries'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { SqliteRunEventLog } from '../../events/SqliteRunEventLog'
import { ProductQueries } from '../../productProtocol/ProductQueries'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { createApprovalRepository } from '../../storage/approvalRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { ApprovalService } from '../ApprovalService'

const databases: DatabaseSync[] = []
const services: ApprovalService[] = []
const logs: SqliteRunEventLog[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const service of services.splice(0)) await service.dispose().catch(() => {})
  for (const log of logs.splice(0)) await log.close().catch(() => {})
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
})
function fixture(options: { onExpired?: (runId: string) => Promise<void> | void } = {}) {
  const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  databases.push(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  seedSqliteRun(database, 'run-1')
  database.exec('UPDATE runs SET status = \'running\'')
  const log = new SqliteRunEventLog({ database })
  logs.push(log)
  const admission = new CommandAdmissionService({ database, principal: createLocalCommandPrincipal(database), sourceInstanceId: 'instance-1' })
  const repository = createApprovalRepository(database)
  const service = new ApprovalService({ repository, eventLog: log, commandAdmission: { database, admission, events: log.transactionWriter }, ...options })
  services.push(service)
  const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
  const request = (overrides: Partial<ApprovalRequest> = {}) => {
    const signal = new AbortController()
    const promise = service.request({ runId: 'run-1', toolCallId: 'tool-1', toolName: 'bash', kind: 'shell', summary: 'Run a fixture command', arguments: { command: 'printf fixture', api_key: 'secret-fixture-token' }, signal: signal.signal, ...overrides })
    void promise.catch(() => {})
    return { promise, signal }
  }
  const pending = async () => {
    await vi.waitFor(() => expect(repository.listPending()).toHaveLength(1))
    await Promise.resolve()
    return repository.listPending()[0]!
  }
  const command = (record: Awaited<ReturnType<typeof pending>>, commandId = 'command-1', decision = 'approved') => ({
    dataGeneration,
    commandId,
    expectedServiceInstanceId: 'instance-1',
    intent: { approvalId: record.id, runId: record.runId, reviewVersion: record.review!.reviewVersion, decision },
  })
  return { database, log, admission, repository, service, dataGeneration, request, pending, command }
}

describe('conditional approval decisions', () => {
  it('drains an accepted persistent effect during shutdown without rewriting its receipt', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    let started = false
    let persisted = false
    const waiting = f.request({ persist: async () => {
      started = true
      expect(f.database.isTransaction).toBe(false)
      await gate.promise
      persisted = true
    } })
    const pending = await f.pending()
    const command = f.command(pending, 'persistent', 'approved_persistently')
    const accepted = await f.service.resolveCommand(command)
    expect(started).toBe(true)
    let disposed = false
    const disposal = f.service.dispose().then(() => {
      disposed = true
    })
    await expect(waiting.promise).rejects.toMatchObject({ code: 'APPROVAL_CANCELLED' })
    expect(disposed).toBe(false)
    gate.resolve()
    await disposal
    expect(persisted).toBe(true)
    expect(f.repository.findById(pending.id)).toMatchObject({ status: 'approved', resolution: 'approved_persistently' })
    expect(await f.service.resolveCommand(command)).toEqual({ created: false, receipt: accepted.receipt })
    expect((await f.log.read('run-1')).filter(event => event.type === 'approval.resolved')).toHaveLength(1)
  })

  it('keeps an NPC approval review actionable with explicit scope without exposing its private execution', async () => {
    const f = fixture()
    seedSqliteRun(f.database, 'npc')
    f.database.prepare('UPDATE runs SET execution_kind = \'npc_child\', root_run_id = \'run-1\', parent_run_id = \'run-1\', status = \'running\' WHERE id = \'npc\'').run()
    const waiting = f.request({ runId: 'npc' })
    const pending = await f.pending()
    const queries = new ProductQueries(f.database, 'desktop-local', 'instance-1')
    const projected = PRODUCT_QUERY_METHODS['approvals.get'].output.parse(queries.read('approvals.get', { approvalId: pending.id }))
    expect(projected).toMatchObject({ runId: 'npc', conversationId: 'task-1', branchId: 'branch-task-1', review: { complete: true, allowedDecisions: expect.arrayContaining(['approved']) } })
    expect(queries.read('runs.get', { runId: 'npc' })).toBeNull()
    expect(queries.read('runs.getExecutionState', { runId: 'npc' })).toBeNull()
    expect(queries.read('runs.listEvents', { runId: 'npc', limit: 100, cursor: null })).toEqual({ items: [], nextCursor: null })
    expect((await f.service.resolveCommand(f.command(pending))).receipt.decision).toBe('accepted')
    expect(await waiting.promise).toEqual({ approvalId: pending.id, decision: 'approved_once' })
  })

  it('binds full safe review to an immutable lifetime and persists the original decision before releasing its waiter', async () => {
    const f = fixture()
    const waiting = f.request()
    const pending = await f.pending()
    expect(pending.review).toMatchObject({ complete: true, contentVersion: 1, allowedDecisions: expect.arrayContaining(['denied', 'approved']) })
    expect(JSON.stringify(pending.review)).not.toContain('secret-fixture-token')
    expect(JSON.stringify(pending.review)).toContain('[redacted]')
    expect(Date.parse(pending.review!.expiresAt) - Date.parse(pending.createdAt)).toBe(30 * 60 * 1000)
    const result = await f.service.resolveCommand(f.command(pending))
    expect(result.receipt).toMatchObject({ decision: 'accepted', result: { status: 'approved', resolution: 'approved' } })
    expect(await waiting.promise).toEqual({ approvalId: pending.id, decision: 'approved_once' })
    expect(f.repository.findById(pending.id)).toMatchObject({ status: 'approved', decisionActorId: 'desktop-local', resolution: 'approved' })
    expect(await f.service.resolveCommand(f.command(pending))).toEqual({ created: false, receipt: result.receipt })
    const other = await f.service.resolveCommand(f.command(pending, 'another-command', 'denied'))
    expect(other.receipt).toMatchObject({ decision: 'rejected', errorCode: 'APPROVAL_ALREADY_RESOLVED', result: { resolution: 'approved' } })
  })

  it('rolls back approval facts and projections if the receipt fails and never releases early', async () => {
    const f = fixture()
    const waiting = f.request()
    const pending = await f.pending()
    let settled = false
    void waiting.promise.then(() => {
      settled = true
    })
    f.database.exec('CREATE TRIGGER reject_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, \'receipt unavailable\'); END')
    await expect(f.service.resolveCommand(f.command(pending))).rejects.toThrow('receipt unavailable')
    expect(settled).toBe(false)
    expect(f.repository.findById(pending.id)?.status).toBe('pending')
    expect(f.database.prepare('SELECT * FROM approval_decisions').all()).toEqual([])
    expect((await f.log.read('run-1')).filter(event => event.type === 'approval.resolved')).toEqual([])
    f.database.exec('DROP TRIGGER reject_receipt')
    await f.service.resolveCommand(f.command(pending))
    expect(await waiting.promise).toMatchObject({ decision: 'approved_once' })
  })

  it('does not release its waiter or report a missing receipt after an uncertain COMMIT', async () => {
    const f = fixture()
    const waiting = f.request()
    const pending = await f.pending()
    let released = false
    void waiting.promise.then(() => {
      released = true
    }, () => {})
    const exec = f.database.exec.bind(f.database)
    const spy = vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
      exec(sql)
      if (sql === 'COMMIT')
        throw new Error('commit acknowledgement lost')
    })
    await expect(f.service.resolveCommand(f.command(pending))).rejects.toMatchObject({ code: 'COMMAND_RESULT_UNKNOWN' })
    expect(released).toBe(false)
    expect(() => f.admission.lookup({ dataGeneration: f.dataGeneration, commandId: 'command-1' })).toThrowError(expect.objectContaining({ code: 'COMMAND_RESULT_UNKNOWN' }))
    spy.mockRestore()
  })

  it('expires at the fixed deadline without revival on clock rollback and drains expiry before shutdown', async () => {
    const gate = Promise.withResolvers<void>()
    const f = fixture({ onExpired: () => gate.promise })
    const waiting = f.request()
    const pending = await f.pending()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(pending.review!.expiresAt))
    const result = await f.service.resolveCommand(f.command(pending))
    expect(result.receipt).toMatchObject({ decision: 'rejected', errorCode: 'APPROVAL_ALREADY_RESOLVED', result: { reason: 'expired' } })
    await expect(waiting.promise).rejects.toMatchObject({ code: 'AUTOMATION_APPROVAL_EXPIRED' })
    expect(f.repository.findById(pending.id)).toMatchObject({ status: 'cancelled', cancellationReason: 'expired' })
    expect(new ProductQueries(f.database, 'phone', 'instance-1').views.approvalDecision(pending.id)).toMatchObject({ status: 'cancelled', actor: null, cancellationReason: 'expired' })
    vi.mocked(Date.now).mockReturnValue(Date.parse(pending.createdAt) - 1000)
    expect(await f.service.resolveCommand(f.command(pending))).toEqual({ created: false, receipt: result.receipt })
    expect((await f.service.resolveCommand(f.command(pending, 'new-command'))).receipt).toMatchObject({ decision: 'rejected', errorCode: 'APPROVAL_ALREADY_RESOLVED' })
    let disposed = false
    const disposal = f.service.dispose().then(() => {
      disposed = true
    })
    await setImmediate()
    expect(disposed).toBe(false)
    gate.resolve()
    await disposal
    expect(disposed).toBe(true)
  })

  it('distinguishes user denial from rejected commands and refuses obsolete review identity', async () => {
    const f = fixture()
    const waiting = f.request()
    const pending = await f.pending()
    const wrong = f.command(pending, 'wrong-review')
    wrong.intent.reviewVersion = 'a'.repeat(64)
    expect((await f.service.resolveCommand(wrong)).receipt).toMatchObject({ decision: 'rejected', errorCode: 'REVIEW_CHANGED' })
    expect((await f.service.resolveCommand(f.command(pending, 'deny', 'denied'))).receipt).toMatchObject({ decision: 'accepted', result: { status: 'denied' } })
    expect(await waiting.promise).toMatchObject({ decision: 'denied' })
  })

  it('refuses pending records without a current waiter and incomplete review approval', async () => {
    const f = fixture()
    const waiting = f.request({ arguments: { command: 'x'.repeat(1024 * 1024 + 1) } })
    const pending = await f.pending()
    expect(pending.review?.complete).toBe(false)
    expect((await f.service.resolveCommand(f.command(pending))).receipt).toMatchObject({ decision: 'rejected', errorCode: 'REVIEW_CHANGED' })
    const reconstructed = new ApprovalService({ repository: f.repository, eventLog: f.log, commandAdmission: { database: f.database, admission: f.admission, events: f.log.transactionWriter } })
    services.push(reconstructed)
    expect((await reconstructed.resolveCommand(f.command(pending, 'no-waiter', 'denied'))).receipt).toMatchObject({ decision: 'rejected', errorCode: 'RESOURCE_UNAVAILABLE' })
    await f.service.resolveCommand(f.command(pending, 'deny-large', 'denied'))
    expect(await waiting.promise).toMatchObject({ decision: 'denied' })
  })

  it('restricts persistent authorization effects to the trusted local actor and applies them after commit', async () => {
    const f = fixture()
    let persisted = false
    const waiting = f.request({ persist: async () => {
      expect(f.database.isTransaction).toBe(false)
      expect(f.database.prepare('SELECT decision FROM command_receipts WHERE command_id = ?').get('local-command')?.decision).toBe('accepted')
      persisted = true
    } })
    const pending = await f.pending()
    f.database.exec('INSERT INTO storage_actors VALUES (\'remote\', \'device\', \'active\', \'2026-11-07T00:00:00.000Z\')')
    const remote = new CommandAdmissionService({ database: f.database, sourceInstanceId: 'instance-1', principal: { actorId: 'remote', assertAuthenticated() {} } })
    expect((await f.service.resolveCommand(f.command(pending, 'remote-command', 'approved_persistently'), remote)).receipt).toMatchObject({ decision: 'rejected', errorCode: 'REVIEW_CHANGED', result: { reason: 'local_authorization_required' } })
    expect(persisted).toBe(false)
    await f.service.resolveCommand(f.command(pending, 'local-command', 'approved_persistently'))
    expect(await waiting.promise).toMatchObject({ decision: 'approved_persistently' })
    expect(persisted).toBe(true)
  })
})

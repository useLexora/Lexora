import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuddyTurnLauncher } from '../../agent/execution/BuddyTurnLauncher'
import { ExecutionCoordinator } from '../../agent/execution/ExecutionCoordinator'
import { ApprovalService } from '../../approvals/ApprovalService'
import { MutationCoordinator } from '../../changes/MutationCoordinator'
import { RunLifecycleService } from '../../runs/RunLifecycleService'
import { RunRecoveryService } from '../../runs/RunRecoveryService'
import { createExecutionStorageFixture, executionNow } from '../../storage/__tests__/executionFixture'
import { createApprovalRepository } from '../../storage/approvalRepository'
import { createMailboxRepository } from '../../storage/mailboxRepository'
import { createRunEventLog } from '../createRunEventLog'
import { RunEventCorruptionError, RunEventLogFatalError } from '../RunEventFailure'
import { RunEventStore } from '../RunEventStore'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function fixture() {
  const storage = createExecutionStorageFixture()
  const directory = await mkdtemp(join(tmpdir(), 'lexora-event-quarantine-'))
  const fatal = vi.fn()
  const quarantined = vi.fn()
  const events = createRunEventLog({ database: storage.database, conversationsDirectory: directory, onFatalFailure: fatal, onRunQuarantined: quarantined })
  storage.executions.admitChild(storage.child('child'))
  storage.conversations.create({ id: 'healthy', branchId: 'healthy-branch', createdAt: executionNow, title: 'Healthy fixture', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  storage.runs.create({ ...storage.runs.findById('root')!, id: 'healthy-run', rootRunId: 'healthy-run', threadId: undefined, conversationId: 'healthy', branchId: 'healthy-branch', triggeringMessageId: 'healthy-input', purpose: 'automation' })
  const file = (runId: string) => join(directory, runId === 'healthy-run' ? 'healthy' : 'conversation', 'events', `${runId}.jsonl`)
  for (const runId of ['root', 'child', 'healthy-run'])
    await events.append({ runId, type: 'audit.before', payload: { preserved: true } })
  cleanups.push(async () => {
    await events.close()
    storage.database.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...storage, directory, events, file, fatal, quarantined }
}

const corruptions = [
  ['terminated invalid JSON', '{broken}\n'],
  ['invalid middle line', `{broken}\n${JSON.stringify({ runId: 'child', sequence: 3, type: 'audit.after', payload: {}, createdAt: executionNow })}\n`],
  ['wrong run identity', `${JSON.stringify({ runId: 'root', sequence: 2, type: 'audit.after', payload: {}, createdAt: executionNow })}\n`],
  ['non-monotonic sequence', `${JSON.stringify({ runId: 'child', sequence: 1, type: 'audit.after', payload: {}, createdAt: executionNow })}\n`],
] as const

describe('run event quarantine', () => {
  it.each(corruptions)('isolates %s to its conversation without rewriting evidence or accepting stale projections', async (_, corruption) => {
    const f = await fixture()
    await appendFile(f.file('child'), corruption)
    const damaged = await readFile(f.file('child'), 'utf8')
    const before = f.database.prepare('SELECT * FROM run_events WHERE run_id = ?').all('child')
    expect(await f.events.recoverAll()).toMatchObject({ scanned: 3, rebuilt: 2, failed: 1, failures: [{ code: 'EVENT_LOG_CORRUPTED', conversationId: 'conversation', runId: 'child' }] })
    expect(f.events.state).toBe('open')
    expect(f.fatal).not.toHaveBeenCalled()
    expect(f.quarantined).toHaveBeenCalledTimes(1)
    expect(await readFile(f.file('child'), 'utf8')).toBe(damaged)
    expect(f.database.prepare('SELECT * FROM run_events WHERE run_id = ?').all('child')).toEqual(before)
    await expect(f.events.append({ runId: 'healthy-run', type: 'audit.after', payload: {} })).resolves.toMatchObject({ sequence: 2 })
    for (const runId of ['root', 'child']) {
      await expect(f.events.append({ runId, type: 'run.completed', payload: {} })).rejects.toBeInstanceOf(RunEventCorruptionError)
      await expect(f.events.read(runId)).rejects.toBeInstanceOf(RunEventCorruptionError)
      await expect(f.events.list(runId)).rejects.toBeInstanceOf(RunEventCorruptionError)
      expect(() => f.events.assertRunWritable(runId)).toThrow(RunEventCorruptionError)
    }
    expect(() => f.events.listForConversation('conversation')).toThrow(RunEventCorruptionError)
    expect(() => f.events.listForRuns(['root'])).toThrow(RunEventCorruptionError)
    expect(() => f.events.listToolCounts(['child'])).toThrow(RunEventCorruptionError)
    expect(() => f.events.assertConversationWritable('conversation')).toThrow(RunEventCorruptionError)
    await expect(f.events.replayAll()).rejects.toBeInstanceOf(RunEventCorruptionError)
    expect(f.events.getRecoveryFailures()).toHaveLength(1)
    expect(f.runs.findById('root')?.status).toBe('running')
  })

  it('continues terminal-run compaction without touching a quarantined historical log', async () => {
    const f = await fixture()
    for (const runId of ['child', 'healthy-run']) {
      await f.events.appendBatch([
        { runId, type: 'message.delta', payload: { messageId: `answer-${runId}`, delta: 'answer' } },
        { runId, type: 'message.completed', payload: { messageId: `answer-${runId}`, role: 'assistant', content: { text: 'answer' }, stopReason: 'completed' } },
        { runId, type: 'run.completed', payload: {} },
      ])
    }
    await appendFile(f.file('child'), '{broken}\n')
    const damaged = await readFile(f.file('child'), 'utf8')
    expect(await f.events.recoverAll()).toMatchObject({ failed: 1 })
    expect(await f.events.compactTerminalRuns()).toBe(1)
    expect(await f.events.list('healthy-run')).toHaveLength(3)
    expect(await readFile(f.file('child'), 'utf8')).toBe(damaged)
    expect(f.events.getRecoveryFailures()).toHaveLength(1)
  })

  it('keeps every corrupt run blocked until its real nonempty log is stable and successfully rebuilt', async () => {
    const f = await fixture()
    const originalChild = await readFile(f.file('child'), 'utf8')
    const originalRoot = await readFile(f.file('root'), 'utf8')
    await appendFile(f.file('child'), '{broken}\n')
    await appendFile(f.file('root'), '{broken}\n')
    expect(await f.events.recoverAll()).toMatchObject({ failed: 2 })
    await rm(f.file('child'))
    await expect(f.events.replay('child')).rejects.toBeInstanceOf(RunEventCorruptionError)
    await writeFile(f.file('child'), '')
    await expect(f.events.replay('child')).rejects.toBeInstanceOf(RunEventCorruptionError)
    await writeFile(f.file('child'), originalChild)
    await expect(f.events.read('child')).rejects.toBeInstanceOf(RunEventCorruptionError)
    await expect(f.events.replay('child')).resolves.toBe(1)
    expect(f.events.getRecoveryFailures().map(failure => failure.runId)).toEqual(['root'])
    expect(() => f.events.assertRunWritable('child')).toThrow(RunEventCorruptionError)
    await writeFile(f.file('root'), originalRoot)
    expect(await f.events.recoverAll()).toMatchObject({ failed: 0, failures: [] })
    await expect(f.events.append({ runId: 'child', type: 'audit.resumed', payload: {} })).resolves.toMatchObject({ sequence: 2 })
    expect(await f.events.list('root')).toHaveLength(1)
  })

  it.each(['missing', 'empty'] as const)('does not trust stale projections after a %s log is observed by a new runtime', async (state) => {
    const f = await fixture()
    const before = f.database.prepare('SELECT * FROM run_events WHERE run_id = ?').all('child')
    if (state === 'missing')
      await rm(f.file('child'))
    else
      await writeFile(f.file('child'), '')
    await f.events.close()
    const reopened = createRunEventLog({ database: f.database, conversationsDirectory: f.directory })
    try {
      expect(await reopened.recoverAll()).toMatchObject({ failed: 1, failures: [{ runId: 'child', conversationId: 'conversation', code: 'EVENT_LOG_CORRUPTED' }] })
      expect(() => reopened.assertRunExecutable('root')).toThrow(RunEventCorruptionError)
      expect(f.database.prepare('SELECT * FROM run_events WHERE run_id = ?').all('child')).toEqual(before)
      await expect(reopened.append({ runId: 'healthy-run', type: 'audit.healthy', payload: {} })).resolves.toMatchObject({ sequence: 2 })
    }
    finally {
      await reopened.close()
    }
  })

  it('retains quarantine and fails globally when repaired data cannot commit to shared SQLite', async () => {
    const f = await fixture()
    const original = await readFile(f.file('child'), 'utf8')
    await appendFile(f.file('child'), '{broken}\n')
    await f.events.recoverAll()
    await writeFile(f.file('child'), original)
    f.database.exec(`CREATE TRIGGER reject_projection BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
    await expect(f.events.replay('child')).rejects.toBeInstanceOf(RunEventLogFatalError)
    expect(f.events.state).toBe('failed')
    expect(f.fatal).toHaveBeenCalledTimes(1)
    expect(f.events.getRecoveryFailures()).toHaveLength(1)
    await expect(f.events.append({ runId: 'healthy-run', type: 'audit.after', payload: {} })).rejects.toMatchObject({ code: 'EVENT_PROJECTION_FAILED' })
    expect(await readFile(f.file('child'), 'utf8')).toBe(original)
  })

  it('does not certify a repaired file that changes during validation', async () => {
    const f = await fixture()
    const original = await readFile(f.file('child'), 'utf8')
    await appendFile(f.file('child'), '{broken}\n')
    await f.events.recoverAll()
    await writeFile(f.file('child'), original)
    const read = RunEventStore.prototype.readAndRepair
    vi.spyOn(RunEventStore.prototype, 'readAndRepair').mockImplementationOnce(async function (this: RunEventStore, runId, conversationId) {
      const events = await read.call(this, runId, conversationId)
      await appendFile(f.file('child'), '{changed}\n')
      return events
    })
    await expect(f.events.replay('child')).rejects.toBeInstanceOf(RunEventCorruptionError)
    expect(f.events.getRecoveryFailures()).toHaveLength(1)
  })

  it('preflights the whole execution tree before recovering interrupted runs, and recovers unrelated automation runs', async () => {
    const f = await fixture()
    await appendFile(f.file('child'), '{broken}\n')
    const damaged = await readFile(f.file('child'), 'utf8')
    const captured: string[] = []
    const cancellable: string[] = []
    const lifecycle = new RunLifecycleService({ eventLog: f.events, repository: f.runs })
    const recovery = new RunRecoveryService({
      conversations: f.conversations,
      eventLog: f.events,
      lifecycle,
      repository: f.runs,
      captureInterruptedChanges: async (runId) => { captured.push(runId) },
      cancelPendingApprovals: async (canRecover) => {
        for (const runId of ['root', 'child', 'healthy-run']) {
          if (canRecover(runId))
            cancellable.push(runId)
        }
        return cancellable.length
      },
      usage: { record: async () => { throw new Error('Unexpected compaction') } },
    })
    expect(await recovery.recoverInterruptedRuns()).toBe(1)
    expect(captured).toEqual(['healthy-run'])
    expect(cancellable).toEqual(['healthy-run'])
    expect(f.runs.findById('healthy-run')).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_RESTARTED' })
    expect(f.runs.findById('root')?.status).toBe('running')
    expect(f.runs.findById('child')?.status).toBe('queued')
    expect(await readFile(f.file('root'), 'utf8')).not.toContain('run.failed')
    expect(await readFile(f.file('child'), 'utf8')).toBe(damaged)
    expect(await recovery.recoverInterruptedRuns()).toBe(0)
    await lifecycle.dispose()
  })

  it('preserves quarantined approvals while durably cancelling healthy approvals during startup', async () => {
    const f = await fixture()
    const repository = createApprovalRepository(f.database)
    const approvals = new ApprovalService({ eventLog: f.events, repository })
    for (const runId of ['child', 'healthy-run']) {
      await f.events.append({ runId, type: 'approval.requested', payload: {
        id: `approval-${runId}`,
        runId,
        toolCallId: `tool-${runId}`,
        kind: 'read',
        status: 'pending',
        summary: 'Read fixture',
        createdAt: executionNow,
        resolvedAt: null,
        payload: { card: 'paths', access: 'read', grant: null, toolName: 'read', targets: [{ path: '/fixture.txt', zone: 'workspace' }] },
      } })
    }
    await appendFile(f.file('child'), '{broken}\n')
    const damaged = await readFile(f.file('child'), 'utf8')
    await f.events.recoverAll()
    const lifecycle = new RunLifecycleService({ eventLog: f.events, repository: f.runs })
    const recovery = new RunRecoveryService({
      conversations: f.conversations,
      eventLog: f.events,
      lifecycle,
      repository: f.runs,
      cancelPendingApprovals: canRecover => approvals.cancelPendingApprovals('recovery', canRecover),
      usage: { record: async () => { throw new Error('Unexpected compaction') } },
    })
    expect(await recovery.recoverInterruptedRuns()).toBe(1)
    expect(repository.findById('approval-child')?.status).toBe('pending')
    expect(repository.findById('approval-healthy-run')?.status).toBe('cancelled')
    expect(await readFile(f.file('child'), 'utf8')).toBe(damaged)
    await lifecycle.dispose()
    await expect(approvals.dispose()).resolves.toBeUndefined()
    expect(repository.findById('approval-child')?.status).toBe('pending')
    expect(await readFile(f.file('child'), 'utf8')).toBe(damaged)
  })

  it('waits for every actual executor to stop and still rejects shared storage failures', async () => {
    const f = await fixture()
    const mutations = new MutationCoordinator()
    const lifecycle = new RunLifecycleService({ eventLog: f.events, repository: f.runs })
    const release = Promise.withResolvers<void>()
    const stopped: string[] = []
    const coordinator = new ExecutionCoordinator({
      availability: f.events,
      executions: f.executions,
      mailbox: createMailboxRepository(f.database),
      events: f.events,
      lifecycle,
      mutations,
      readResult: async () => '',
      launchChild: async () => { throw new Error('Unexpected launch') },
      stopExecution: async (runId) => {
        stopped.push(runId)
        if (runId === 'healthy-run')
          await release.promise
        return false
      },
      listIncomplete: () => f.runs.listIncomplete(),
    })
    f.database.exec(`CREATE TRIGGER reject_projection BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
    await expect(f.events.replay('root')).rejects.toBeInstanceOf(RunEventLogFatalError)
    let settled = false
    const disposing = coordinator.dispose().catch((error) => {
      settled = true
      return error
    })
    try {
      await vi.waitFor(() => expect(stopped.toSorted()).toEqual(['child', 'healthy-run', 'root']))
      expect(settled).toBe(false)
    }
    finally {
      release.resolve()
    }
    expect(await disposing).toBeInstanceOf(AggregateError)
    expect(f.events.state).toBe('failed')
    expect(f.runs.findById('root')?.status).toBe('running')
    expect(f.runs.findById('healthy-run')?.status).toBe('running')
    await lifecycle.dispose()
    await mutations.dispose()
  })

  it('rejects child and launcher admission before projection or model side effects while still allowing cleanup', async () => {
    const f = await fixture()
    const mutations = new MutationCoordinator()
    const lifecycle = new RunLifecycleService({ eventLog: f.events, repository: f.runs })
    const stopped: string[] = []
    const coordinator = new ExecutionCoordinator({
      availability: f.events,
      executions: f.executions,
      mailbox: createMailboxRepository(f.database),
      events: f.events,
      lifecycle,
      mutations,
      readResult: async () => '',
      launchChild: async () => { throw new Error('Unexpected launch') },
      stopExecution: async (runId) => {
        stopped.push(runId)
        return false
      },
      listIncomplete: () => f.runs.listIncomplete(),
    })
    await appendFile(f.file('child'), '{broken}\n')
    await f.events.recoverAll()
    const before = f.executions.listTree('root')
    const launcher = new BuddyTurnLauncher({
      executions: coordinator,
      planner: { resolve: async () => { throw new Error('Unexpected planning') } },
      runner: {
        startTurn: () => { throw new Error('Unexpected model') },
        startCompaction: () => { throw new Error('Unexpected model') },
      },
    })
    await expect(launcher.launch('child')).rejects.toBeInstanceOf(RunEventCorruptionError)
    await expect(coordinator.admitChild(f.child('another-child'))).rejects.toBeInstanceOf(RunEventCorruptionError)
    await expect(coordinator.begin('root', new AbortController().signal)).rejects.toBeInstanceOf(RunEventCorruptionError)
    expect(f.executions.listTree('root')).toEqual(before)
    expect(f.runs.findById('another-child')).toBeNull()
    await coordinator.cancel('root', 'RUN_CANCELLED', async (runId) => {
      stopped.push(runId)
      return false
    })
    expect(stopped).toEqual(['root', 'child'])
    expect(f.executions.listTree('root')).toEqual(before)
    await coordinator.dispose()
    await lifecycle.dispose()
    await mutations.dispose()
  })
})

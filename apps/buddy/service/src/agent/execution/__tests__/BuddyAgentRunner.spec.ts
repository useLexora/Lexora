import type { AssistantMessage, ToolResultMessage, Usage } from '@earendil-works/pi-ai'
import type { AgentSessionEvent, CompactionResult } from '@earendil-works/pi-coding-agent'
import type { DatabaseSync } from 'node:sqlite'
import type { BuddySessionBlueprint } from '../../sessions/BuddySessionBlueprint'
import type { BuddySessionTurnContext, ReusableBuddySession } from '../../sessions/ReusableBuddySession'
import type { PiTurnExecutorOptions } from '../PiTurnExecutor'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { RunEventStorageError } from '../../../events/RunEventFailure'
import { RunContinuityService } from '../../../runs/RunContinuityService'
import { RunLifecycleService } from '../../../runs/RunLifecycleService'
import {
  prepareTestCommandRequest,
  prepareTestTurnRequest,
} from '../../../storage/__tests__/composerDraftTestFixture'
import { createConversationRepository } from '../../../storage/conversationRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { createRunRepository } from '../../../storage/runRepository'
import { createUsageRepository } from '../../../storage/usageRepository'
import { UsageService } from '../../../usage/UsageService'
import { createBuddyInputReference } from '../../context/BuddyInputReference'
import { PiEventBridge } from '../../events/PiEventBridge'
import { BuddySessionStorageError } from '../../sessions/BuddySessionErrors'
import { BuddySessionRegistry } from '../../sessions/BuddySessionRegistry'
import { BuddyAgentRunner } from '../BuddyAgentRunner'
import { PiTurnExecutor } from '../PiTurnExecutor'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('buddyAgentRunner', () => {
  it('bounds automation background session startup and records a stable timeout', async () => {
    const fixture = await createFixture()
    const startupSignal: { current: AbortSignal | null } = { current: null }
    const lateSession = new IdleSession()
    const shutdownLateSession = vi.spyOn(lateSession, 'shutdown')
    let resolveFactory!: (binding: {
      piSessionFile: string
      session: ReusableBuddySession
    }) => void
    const runner = fixture.createRunnerFromFactory(
      input => new Promise((resolve) => {
        startupSignal.current = input.signal
        resolveFactory = resolve
      }),
      new BuddySessionRegistry<ReusableBuddySession>(),
      { automationSessionStartupTimeoutMs: 5 },
    )
    const input = {
      branchId: 'branch-timeout',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-timeout',
      cwd: fixture.root,
      model: 'model-timeout',
      spaceId: null,
      prompt: 'Run automation',
      provider: 'provider-timeout',
      resources: emptyResources(),
      runId: 'run-session-timeout',
      sessionMode: 'automation_background' as const,
    }
    fixture.prepareTurn(input, 'message-session-timeout')
    fixture.database.prepare(`
      UPDATE runs SET purpose = 'automation' WHERE id = ?
    `).run(input.runId)

    await expect(runner.startTurn(withSession(input)).completion).resolves.toMatchObject({
      errorCode: 'AUTOMATION_RUN_TIMEOUT',
      status: 'cancelled',
    })
    expect(startupSignal.current?.aborted).toBe(true)
    resolveFactory({
      piSessionFile: join(fixture.root, 'late-session.jsonl'),
      session: lateSession,
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(shutdownLateSession).toHaveBeenCalledWith('invalidate')
  })

  it('buffers interrupted reasoning deltas into one replayable chunk', async () => {
    const fixture = await createFixture()
    const runner = fixture.createRunner(new ReasoningFailureSession())
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'gpt-5.6',
      spaceId: null,
      prompt: 'Inspect the workspace',
      provider: 'openai-codex',
      resources: emptyResources(),
      runId: 'run-reasoning-failed',
    }
    fixture.prepareTurn(input, 'message-user-reasoning')

    await expect(runner.startTurn(withSession(input)).completion).resolves.toMatchObject({ status: 'failed' })

    expect((await fixture.eventLog.read(input.runId)).filter(
      event => event.type === 'message.block.delta',
    )).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ delta: 'Inspecting workspace files' }),
    })])
  })

  it('retains refused recovery records for retry and acknowledges them only after one durable batch', async () => {
    const fixture = await createFixture()
    const sessions = new BuddySessionRegistry<ReusableBuddySession>()
    const session = new IdleSession()
    const runner = fixture.createRunnerFromFactory(async () => ({
      piSessionFile: join(fixture.root, 'recovered-session.jsonl'),
      recoveredFromProductHistory: true,
      recoveryDegradation: { missingAttachmentIds: ['attachment-missing'], recoveredImageCount: 1 },
      session,
    }), sessions)
    const appendBatch = fixture.eventLog.appendBatch.bind(fixture.eventLog)
    let refuseRecovery = true
    vi.spyOn(fixture.eventLog, 'appendBatch').mockImplementation((events) => {
      if (refuseRecovery && events.some(event => event.type === 'session.recovered')) {
        refuseRecovery = false
        return Promise.reject(new Error('Recovery batch refused before commit'))
      }
      return appendBatch(events)
    })
    const base = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Continue recovered context',
      provider: 'anthropic',
      resources: emptyResources(),
    }
    const first = { ...base, runId: 'run-recovery-refused' }
    const second = { ...base, runId: 'run-recovery-retried' }
    const third = { ...base, runId: 'run-after-recovery-acknowledged' }
    const recoveryTypes = ['session.recovered', 'session.recovery.degraded']

    try {
      fixture.prepareTurn(first, 'message-recovery-refused')
      await expect(runner.startTurn(withSession(first)).completion).resolves.toMatchObject({ status: 'failed' })
      expect(sessions.snapshot()).toMatchObject([{ recoveryPending: true, status: 'ready' }])
      expect(sessions.getReady(base.conversationId, base.branchId)).toBe(session)
      expect((await fixture.eventLog.read(first.runId)).filter(event => recoveryTypes.includes(event.type))).toEqual([])

      fixture.prepareTurn(second, 'message-recovery-retried')
      await expect(runner.startTurn(withSession(second)).completion).resolves.toMatchObject({ status: 'completed' })
      expect(sessions.snapshot()).toMatchObject([{ recoveryPending: false, status: 'ready' }])
      const recovered = (await fixture.eventLog.read(second.runId)).filter(event => recoveryTypes.includes(event.type))
      expect(recovered.map(event => event.type)).toEqual(recoveryTypes)
      expect(recovered[1]?.payload).toEqual({ missingAttachmentCount: 1, missingAttachmentIds: ['attachment-missing'], recoveredImageCount: 1, source: 'sqlite' })
      expect((await fixture.eventLog.list(second.runId)).filter(event => recoveryTypes.includes(event.type))).toEqual(recovered)

      fixture.prepareTurn(third, 'message-after-recovery-acknowledged')
      await expect(runner.startTurn(withSession(third)).completion).resolves.toMatchObject({ status: 'completed' })
      expect(sessions.getReady(base.conversationId, base.branchId)).toBe(session)
      expect((await fixture.eventLog.read(third.runId)).filter(event => recoveryTypes.includes(event.type))).toEqual([])
      expect(fixture.eventLog.listForRuns([first.runId, second.runId, third.runId])
        .filter(event => recoveryTypes.includes(event.type)).map(event => event.type)).toEqual(recoveryTypes)
    }
    finally {
      await runner.dispose()
      await fixture.eventLog.close()
    }
  })

  it('leaves a turn recoverable when durable usage projection fails', async () => {
    const fixture = await createFixture()
    const target = join(fixture.root, 'article-without-usage.md')
    const runner = fixture.createRunner(new OfflineSession(target))
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Write an article while usage storage is unavailable',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-usage-storage-failed',
    }
    fixture.prepareTurn(input, 'message-user-usage-storage-failed')
    fixture.database.exec(`
      CREATE TRIGGER fail_turn_usage_record
      BEFORE INSERT ON usage_records
      BEGIN
        SELECT RAISE(ABORT, 'injected turn usage failure');
      END;
    `)

    const run = await runner.startTurn(withSession(input)).completion

    expect(run).toMatchObject({ errorCode: null, status: 'running' })
    expect(fixture.conversations.listMessages('conversation-1', 'branch-1')
      .map(message => message.role)).toEqual(['user', 'assistant'])
    expect(fixture.usageRepository.listForRun(run.id)).toEqual([])
    fixture.database.exec('DROP TRIGGER fail_turn_usage_record')
    const recovered = createRunEventLog({
      database: fixture.database,
      conversationsDirectory: fixture.conversationsDirectory,
    })
    const events = await recovered.read(run.id)
    expect(events.map(event => event.type)).toEqual([
      'run.started',
      'message.started',
      'run.progress',
      'message.delta',
      'run.progress',
      'message.delta',
      'message.completed',
      'usage.recorded',
    ])
    await expect(recovered.replay(run.id)).resolves.toBe(events.length)
    expect(fixture.usageRepository.listForRun(run.id)).toMatchObject([{
      purpose: 'turn',
      sourceEntryId: expect.any(String),
    }])
  })

  it('observes a fatal usage event tail while leaving the turn recoverable', async () => {
    const fixture = await createFixture()
    const target = join(fixture.root, 'article-with-fatal-usage-event.md')
    const append = fixture.eventLog.append.bind(fixture.eventLog)
    vi.spyOn(fixture.eventLog, 'append').mockImplementation((input) => {
      if (input.type !== 'usage.recorded')
        return append(input)
      return Promise.reject(new RunEventStorageError({
        firstSequence: 5,
        lastSequence: 5,
        runId: input.runId,
      }, 'append', 'write', 'unknown'))
    })
    const runner = fixture.createRunner(new OfflineSession(target))
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Keep a fatal usage event outcome recoverable',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-usage-event-fatal',
    }
    fixture.prepareTurn(input, 'message-user-usage-event-fatal')

    const run = await runner.startTurn(withSession(input)).completion

    expect(run).toMatchObject({ errorCode: null, status: 'running' })
    expect(fixture.usageRepository.listForRun(run.id)).toEqual([])
    expect((await fixture.eventLog.read(run.id)).map(event => event.type)).toEqual([
      'run.started',
      'message.started',
      'run.progress',
      'message.delta',
      'run.progress',
      'message.delta',
      'message.completed',
    ])
  })

  it('keeps a completed run terminal when post-commit notification fails', async () => {
    const fixture = await createFixture({
      onCommit: () => {
        throw new Error('runtime peer closed')
      },
    })
    const target = join(fixture.root, 'notification-safe.md')
    const runner = fixture.createRunner(new OfflineSession(target))
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Write despite a disconnected observer',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-notification-failure',
    }
    fixture.prepareTurn(input, 'message-user-notification-failure')

    await expect(runner.startTurn(withSession(input)).completion).resolves.toMatchObject({
      errorCode: null,
      status: 'completed',
    })
    expect(fixture.runs.findById(input.runId)).toMatchObject({
      errorCode: null,
      status: 'completed',
    })
    expect((await fixture.eventLog.read(input.runId)).at(-1)?.type).toBe('run.completed')
  })

  it('does not overwrite a durable terminal fact when its SQLite projection stays unavailable', async () => {
    const fixture = await createFixture()
    const target = join(fixture.root, 'projection-recovery.md')
    const runner = fixture.createRunner(new OfflineSession(target))
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Write before projection recovery',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-projection-failure',
    }
    fixture.prepareTurn(input, 'message-user-projection-failure')
    fixture.database.exec(`
      CREATE TRIGGER fail_terminal_projection
      BEFORE INSERT ON run_events
      WHEN NEW.event_type = 'run.completed'
      BEGIN
        SELECT RAISE(ABORT, 'injected persistent terminal projection failure');
      END;
    `)

    await expect(runner.startTurn(withSession(input)).completion).resolves.toMatchObject({
      errorCode: null,
      status: 'running',
    })
    expect(fixture.runs.findById(input.runId)).toMatchObject({
      errorCode: null,
      status: 'running',
    })
    expect((await fixture.eventLog.read(input.runId)).map(event => event.type))
      .toEqual(expect.arrayContaining(['run.completed']))
    expect((await fixture.eventLog.read(input.runId)).filter(event => (
      event.type === 'run.completed' || event.type === 'run.failed'
    )).map(event => event.type)).toEqual(['run.completed'])

    fixture.database.exec('DROP TRIGGER fail_terminal_projection')
    await fixture.eventLog.replay(input.runId)
    expect(fixture.runs.findById(input.runId)).toMatchObject({
      errorCode: null,
      status: 'completed',
    })
  })

  it('does not compensate a fatal event storage commit outcome', async () => {
    const fixture = await createFixture()
    const runner = fixture.createRunner(new IdleSession())
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Finish without compensating an unknown storage outcome',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-storage-failure',
    }
    fixture.prepareTurn(input, 'message-user-storage-failure')
    const append = fixture.eventLog.append.bind(fixture.eventLog)
    vi.spyOn(fixture.eventLog, 'append').mockImplementation((event) => {
      if (event.type !== 'run.completed')
        return append(event)
      return Promise.reject(new RunEventStorageError({
        firstSequence: 2,
        lastSequence: 2,
        runId: event.runId,
      }, 'append', 'close', 'committed'))
    })

    await expect(runner.startTurn(withSession(input)).completion).resolves.toMatchObject({
      errorCode: null,
      status: 'running',
    })
    expect(fixture.runs.findById(input.runId)).toMatchObject({
      errorCode: null,
      status: 'running',
    })
    expect((await fixture.eventLog.read(input.runId)).map(event => event.type))
      .toEqual(['run.started'])
  })

  it('cancels and waits for every active run bound to a revoked root', async () => {
    const fixture = await createFixture()
    const session = new WaitingSession()
    const runner = fixture.createRunner(session)
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Wait',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-revoke',
    }
    fixture.prepareTurn(input, 'message-user-revoke')
    const handle = runner.startTurn(withSession(input))
    await session.started

    await expect(runner.cancelAndWaitForRoot(fixture.root)).resolves.toBe(1)
    await expect(handle.completion).resolves.toMatchObject({ status: 'cancelled' })
    expect(fixture.runs.findById(input.runId)).toMatchObject({
      errorCode: 'RUN_CANCELLED',
      status: 'cancelled',
    })
    expect((await fixture.eventLog.read(input.runId)).at(-1)?.type).toBe('run.cancelled')
  })

  it('does not prompt a session that finishes initializing after cancellation', async () => {
    const fixture = await createFixture()
    let releaseFactory!: () => void
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve
    })
    const prompt = vi.fn(async () => {})
    const session: ReusableBuddySession = {
      abort: async () => {},
      abortCompaction: () => {},
      activateTurn: async () => () => {},
      canCompact: () => true,
      compact: async () => { throw new Error('not used') },
      shutdown: async () => {},
      prompt,
      subscribe: () => () => {},
      waitForIdle: async () => {},
    }
    const runner = fixture.createRunnerFromFactory(async () => {
      await factoryGate
      return { piSessionFile: join(fixture.root, 'session.jsonl'), session }
    })
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Wait',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-initializing',
    }
    fixture.prepareTurn(input, 'message-user-initializing')
    const handle = runner.startTurn(withSession(input))
    const cancellation = runner.cancelAndWaitForConversation('conversation-1')
    releaseFactory()

    await expect(cancellation).resolves.toBe(1)
    await expect(handle.completion).resolves.toMatchObject({ status: 'cancelled' })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('does not prompt a session cancelled while turn activation is pending', async () => {
    const fixture = await createFixture()
    let releaseActivation!: () => void
    let resolveActivationStarted!: () => void
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve
    })
    const activationStarted = new Promise<void>((resolve) => {
      resolveActivationStarted = resolve
    })
    const prompt = vi.fn(async () => {})
    const session: ReusableBuddySession = {
      abort: async () => releaseActivation(),
      abortCompaction: () => {},
      activateTurn: async () => {
        resolveActivationStarted()
        await activationGate
        return () => {}
      },
      canCompact: () => true,
      compact: async () => { throw new Error('not used') },
      shutdown: async () => {},
      prompt,
      subscribe: () => () => {},
      waitForIdle: async () => {},
    }
    const runner = fixture.createRunner(session)
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Wait for activation',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-activating',
    }
    fixture.prepareTurn(input, 'message-user-activating')
    const handle = runner.startTurn(withSession(input))
    await activationStarted

    await expect(runner.cancel(input.runId)).resolves.toBe(true)
    await expect(handle.completion).resolves.toMatchObject({
      errorCode: 'RUN_CANCELLED',
      status: 'cancelled',
    })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('persists the redacted Pi model failure reason on the terminal run event', async () => {
    const fixture = await createFixture()
    const runner = fixture.createRunner(new ModelFailureSession())
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'model-1',
      spaceId: null,
      prompt: 'Fail with a visible reason',
      provider: 'provider-1',
      resources: emptyResources(),
      runId: 'run-model-failed',
    }
    fixture.prepareTurn(input, 'message-user-model-failed')

    await expect(runner.startTurn(withSession(input)).completion).resolves.toMatchObject({
      errorCode: 'MODEL_NOT_SUPPORTED',
      status: 'failed',
    })
    expect((await fixture.eventLog.read(input.runId)).at(-1)).toMatchObject({
      payload: {
        errorCode: 'MODEL_NOT_SUPPORTED',
        errorMessage: 'The configured model does not exist; api_key=[redacted]',
      },
      type: 'run.failed',
    })
  })

  it('completes a run when the final assistant answer is durable before Pi session persistence fails', async () => {
    const fixture = await createFixture()
    const sessions = new BuddySessionRegistry<ReusableBuddySession>()
    const failedSession = new MessageThenStorageFailureSession('stop')
    failedSession.shutdown = async () => {
      throw new Error('session shutdown hook failed')
    }
    const shutdownFailedSession = vi.spyOn(failedSession, 'shutdown')
    const sessionFactory = vi.fn(async () => ({
      piSessionFile: join(fixture.root, 'session.jsonl'),
      session: sessionFactory.mock.calls.length === 1
        ? failedSession
        : new IdleSession(),
    }))
    const runner = fixture.createRunnerFromFactory(sessionFactory, sessions)
    const base = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      provider: 'anthropic',
      resources: emptyResources(),
    }
    const first = { ...base, prompt: 'First', runId: 'run-storage-after-final' }
    fixture.prepareTurn(first, 'message-user-storage-after-final')

    await expect(runner.startTurn(withSession(first)).completion).resolves.toMatchObject({
      errorCode: null,
      piSessionFile: null,
      status: 'completed',
    })
    expect(fixture.conversations.listMessages('conversation-1', 'branch-1'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: { text: 'Durable final answer' },
          role: 'assistant',
          runId: first.runId,
        }),
      ]))
    expect(await fixture.eventLog.read(first.runId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: {
          errorCode: 'SESSION_STORAGE_UNAVAILABLE',
          source: 'pi_session',
        },
        type: 'session.continuity.degraded',
      }),
      expect.objectContaining({ type: 'run.completed' }),
    ]))

    const second = { ...base, prompt: 'Second', runId: 'run-after-storage-degradation' }
    fixture.prepareTurn(second, 'message-user-after-storage-degradation')
    await expect(runner.startTurn(withSession(second)).completion).resolves.toMatchObject({
      status: 'completed',
    })
    expect(sessionFactory).toHaveBeenCalledTimes(2)
    expect(sessionFactory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      piSessionFile: null,
    }))
    expect(shutdownFailedSession).toHaveBeenCalledOnce()
  })

  it('fails a run when Pi session persistence breaks after a tool-use assistant message', async () => {
    const fixture = await createFixture()
    const session = new MessageThenStorageFailureSession('toolUse')
    const runner = fixture.createRunner(session)
    const input = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Use a tool',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-storage-after-tool-use',
    }
    fixture.prepareTurn(input, 'message-user-storage-after-tool-use')

    await expect(runner.startTurn(withSession(input)).completion).resolves.toMatchObject({
      errorCode: 'SESSION_STORAGE_UNAVAILABLE',
      status: 'failed',
    })
    const events = await fixture.eventLog.read(input.runId)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({ stopReason: 'tool_use' }),
        type: 'message.completed',
      }),
      expect.objectContaining({
        payload: { errorCode: 'SESSION_STORAGE_UNAVAILABLE' },
        type: 'run.failed',
      }),
    ]))
    expect(events.some(event => event.type === 'session.continuity.degraded')).toBe(false)
  })

  it('resumes the latest bound Pi session after the in-memory session is invalidated', async () => {
    const fixture = await createFixture()
    const sessions = new BuddySessionRegistry<ReusableBuddySession>()
    const sessionFactory = vi.fn(async (input: { piSessionFile: string | null, runId: string }) => ({
      piSessionFile: input.piSessionFile ?? join(fixture.root, `${input.runId}.jsonl`),
      session: new IdleSession(),
    }))
    const runner = fixture.createRunnerFromFactory(sessionFactory, sessions)
    const base = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      provider: 'anthropic',
      resources: emptyResources(),
    }
    const first = { ...base, prompt: 'First turn', runId: 'run-first' }
    fixture.prepareTurn(first, 'message-user-first')
    await runner.startTurn(withSession(first)).completion
    await sessions.invalidateRoot(fixture.root)

    const second = { ...base, prompt: 'Second turn', runId: 'run-second' }
    fixture.prepareTurn(second, 'message-user-second')
    await runner.startTurn(withSession(second)).completion

    expect(sessionFactory).toHaveBeenCalledTimes(2)
    expect(sessionFactory.mock.calls[1]?.[0]).toMatchObject({
      piSessionFile: join(fixture.root, 'run-first.jsonl'),
      runId: 'run-second',
    })
    expect(fixture.runs.findById('run-second')?.piSessionFile)
      .toBe(join(fixture.root, 'run-first.jsonl'))
  })

  it('reuses one Pi session while activating and releasing fresh run context for every turn', async () => {
    const fixture = await createFixture()
    const activations: Array<{ model: string, provider: string, runId: string }> = []
    const releases: string[] = []
    const session = new IdleSession()
    session.activateTurn = async (input) => {
      activations.push({ model: input.model, provider: input.provider, runId: input.runId })
      return () => releases.push(input.runId)
    }
    const sessionFactory = vi.fn(async () => ({
      piSessionFile: join(fixture.root, 'session.jsonl'),
      session,
    }))
    const runner = fixture.createRunnerFromFactory(sessionFactory)
    const base = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      spaceId: null,
      provider: 'anthropic',
      resources: emptyResources(),
    }
    const first = {
      ...base,
      model: 'claude-sonnet-4-5',
      prompt: 'First turn',
      runId: 'run-first',
    }
    fixture.prepareTurn(first, 'message-user-first')
    await runner.startTurn(withSession(first)).completion
    const second = {
      ...base,
      model: 'claude-opus-4-1',
      prompt: 'Second turn',
      runId: 'run-second',
    }
    fixture.prepareTurn(second, 'message-user-second')
    await runner.startTurn(withSession(second)).completion

    expect(sessionFactory).toHaveBeenCalledTimes(1)
    expect(activations).toEqual([
      { model: 'claude-sonnet-4-5', provider: 'anthropic', runId: 'run-first' },
      { model: 'claude-opus-4-1', provider: 'anthropic', runId: 'run-second' },
    ])
    expect(releases).toEqual(['run-first', 'run-second'])
  })

  it('runs manual compaction as an audited Buddy run and records Pi usage', async () => {
    const fixture = await createFixture()
    fixture.prepareCompletedTurn()
    fixture.prepareCompaction('run-compact')
    const session = new CompactionSession()
    const runner = fixture.createRunner(session)

    const run = await runner.startCompaction(withSession({
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      customInstructions: 'focus on decisions',
      cwd: fixture.root,
      spaceId: null,
      resources: emptyResources(),
      runId: 'run-compact',
    })).completion

    expect(run).toMatchObject({ status: 'completed' })
    expect(session.compactionInstructions).toEqual(['focus on decisions'])
    expect(fixture.conversations.listMessages('conversation-1', 'branch-1')).toHaveLength(1)
    expect(fixture.usageRepository.listForRun('run-compact')).toMatchObject([{
      inputTokens: 20,
      outputTokens: 5,
      purpose: 'compaction',
      sourceEntryId: 'compaction:pi-message-1',
    }])
    expect((await fixture.eventLog.read('run-compact')).map(event => event.type)).toEqual([
      'run.started',
      'context.compaction.started',
      'context.compaction.completed',
      'usage.recorded',
      'run.completed',
    ])
  })

  it('leaves committed manual compaction recoverable when usage projection fails', async () => {
    const fixture = await createFixture()
    fixture.prepareCompletedTurn()
    fixture.prepareCompaction('run-compact-usage-failed')
    fixture.database.exec(`
      CREATE TRIGGER fail_compaction_usage_record
      BEFORE INSERT ON usage_records
      WHEN NEW.purpose = 'compaction'
      BEGIN
        SELECT RAISE(ABORT, 'injected compaction usage failure');
      END;
    `)
    const runner = fixture.createRunner(new CompactionSession())

    const run = await runner.startCompaction(withSession({
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      customInstructions: '',
      cwd: fixture.root,
      spaceId: null,
      resources: emptyResources(),
      runId: 'run-compact-usage-failed',
    })).completion

    expect(run).toMatchObject({ errorCode: null, status: 'running' })
    expect(fixture.usageRepository.listForRun(run.id)).toEqual([])
    fixture.database.exec('DROP TRIGGER fail_compaction_usage_record')
    const recovered = createRunEventLog({
      database: fixture.database,
      conversationsDirectory: fixture.conversationsDirectory,
    })
    expect(await recovered.read(run.id)).toEqual([
      expect.objectContaining({ type: 'run.started' }),
      expect.objectContaining({ type: 'context.compaction.started' }),
      expect.objectContaining({ type: 'context.compaction.completed' }),
      expect.objectContaining({ type: 'usage.recorded' }),
    ])
    await expect(recovered.replay(run.id)).resolves.toBe(4)
    expect(fixture.usageRepository.listForRun(run.id)).toMatchObject([{
      purpose: 'compaction',
      sourceEntryId: 'compaction:pi-message-1',
    }])
  })

  it('does not terminalize a committed compaction after fatal usage event storage failure', async () => {
    const fixture = await createFixture()
    fixture.prepareCompletedTurn()
    fixture.prepareCompaction('run-compact-usage-event-fatal')
    const append = fixture.eventLog.append.bind(fixture.eventLog)
    vi.spyOn(fixture.eventLog, 'append').mockImplementation((input) => {
      if (input.type !== 'usage.recorded')
        return append(input)
      return Promise.reject(new RunEventStorageError({
        firstSequence: 4,
        lastSequence: 4,
        runId: input.runId,
      }, 'append', 'write', 'unknown'))
    })
    const runner = fixture.createRunner(new CompactionSession())

    const run = await runner.startCompaction(withSession({
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      customInstructions: '',
      cwd: fixture.root,
      spaceId: null,
      resources: emptyResources(),
      runId: 'run-compact-usage-event-fatal',
    })).completion

    expect(run).toMatchObject({ errorCode: null, status: 'running' })
    expect(fixture.usageRepository.listForRun(run.id)).toEqual([])
    expect((await fixture.eventLog.read(run.id)).map(event => event.type)).toEqual([
      'run.started',
      'context.compaction.started',
      'context.compaction.completed',
    ])
  })

  it('invalidates active compaction session continuity on storage failure', async () => {
    const fixture = await createFixture()
    fixture.prepareCompletedTurn()
    fixture.prepareCompaction('run-compact-storage-failed')
    const sessions = new BuddySessionRegistry<ReusableBuddySession>()
    const failedSession = new CompactionStorageFailureSession()
    const shutdownFailedSession = vi.spyOn(failedSession, 'shutdown')
    const sessionFactory = vi.fn(async () => ({
      piSessionFile: join(fixture.root, 'session.jsonl'),
      session: sessionFactory.mock.calls.length === 1
        ? failedSession
        : new IdleSession(),
    }))
    const runner = fixture.createRunnerFromFactory(sessionFactory, sessions)

    const run = await runner.startCompaction(withSession({
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      customInstructions: '',
      cwd: fixture.root,
      spaceId: null,
      resources: emptyResources(),
      runId: 'run-compact-storage-failed',
    })).completion

    expect(run).toMatchObject({
      errorCode: 'SESSION_STORAGE_UNAVAILABLE',
      piSessionFile: null,
      status: 'failed',
    })
    const events = await fixture.eventLog.read(run.id)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: {
          errorCode: 'COMPACTION_FAILED',
          reason: 'manual',
          willRetry: false,
        },
        type: 'context.compaction.failed',
      }),
      expect.objectContaining({
        payload: { errorCode: 'SESSION_STORAGE_UNAVAILABLE' },
        type: 'run.failed',
      }),
    ]))
    expect(JSON.stringify(events)).not.toContain('/secret/session.jsonl')

    const nextTurn = {
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      cwd: fixture.root,
      model: 'claude-sonnet-4-5',
      spaceId: null,
      prompt: 'Continue after compaction storage recovery',
      provider: 'anthropic',
      resources: emptyResources(),
      runId: 'run-after-compact-storage-failed',
    }
    fixture.prepareTurn(nextTurn, 'message-user-after-compact-storage-failed')
    await expect(runner.startTurn(withSession(nextTurn)).completion).resolves.toMatchObject({
      status: 'completed',
    })
    expect(sessionFactory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      piSessionFile: null,
    }))
    expect(shutdownFailedSession).toHaveBeenCalledOnce()
  })

  it('fails an ineligible manual compaction without activating the provider or calling Pi compact', async () => {
    const fixture = await createFixture()
    fixture.prepareCompletedTurn()
    fixture.prepareCompaction('run-compact-not-needed')
    const session = new IneligibleCompactionSession()
    const runner = fixture.createRunner(session)

    const run = await runner.startCompaction(withSession({
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      customInstructions: '',
      cwd: fixture.root,
      spaceId: null,
      resources: emptyResources(),
      runId: 'run-compact-not-needed',
    })).completion

    expect(run).toMatchObject({
      errorCode: 'CONTEXT_COMPACTION_NOT_NEEDED',
      status: 'failed',
    })
    expect(session.activationCount).toBe(0)
    expect(session.compactionInstructions).toEqual([])
  })

  it('cancels Pi compaction before closing the Buddy run', async () => {
    const fixture = await createFixture()
    fixture.prepareCompletedTurn()
    fixture.prepareCompaction('run-compact-cancel')
    const session = new WaitingCompactionSession()
    const runner = fixture.createRunner(session)
    const handle = runner.startCompaction(withSession({
      branchId: 'branch-1',
      canonicalRoot: fixture.root,
      conversationId: 'conversation-1',
      customInstructions: '',
      cwd: fixture.root,
      spaceId: null,
      resources: emptyResources(),
      runId: 'run-compact-cancel',
    }))
    await session.started

    expect(await runner.cancel('run-compact-cancel')).toBe(true)
    expect(session.compactionAborted).toBe(true)
    expect(await handle.completion).toMatchObject({
      errorCode: 'RUN_CANCELLED',
      status: 'cancelled',
    })
  })
})

class OfflineSession implements ReusableBuddySession {
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>()
  readonly #target: string
  #turnContext: BuddySessionTurnContext | null = null

  constructor(target: string) {
    this.#target = target
  }

  readonly toolSources = new Map([['write', {
    extensionId: '@lexora/buddy-extension-workspace',
    origin: 'product' as const,
    scope: 'product' as const,
  }]])

  abort(): Promise<void> {
    return Promise.resolve()
  }

  abortCompaction(): void {}

  canCompact(): boolean {
    return true
  }

  activateTurn(input: BuddySessionTurnContext): Promise<() => void> {
    this.#turnContext = input
    return Promise.resolve(() => {
      this.#turnContext = null
    })
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  compact(): Promise<CompactionResult> {
    return Promise.reject(new Error('not used'))
  }

  async prompt(): Promise<void> {
    const first = assistant('I will write', usage(10, 4))
    this.#emit({ type: 'message_start', message: first })
    for (const delta of ['I ', 'will ', 'write']) {
      this.#emit({
        type: 'message_update',
        message: first,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta,
          partial: first,
        },
      })
    }
    this.#emit({ type: 'message_end', message: first })
    this.#emit({ type: 'entry_appended', entry: entry('pi-assistant-1', first) })
    this.#emit({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'write',
      args: { path: this.#target, content: 'Article' },
    })
    await this.#turnContext?.onToolExecutionAuthorized({
      arguments: { path: this.#target, content: 'Article' },
      toolCallId: 'tool-1',
      toolName: 'write',
    })
    await writeFile(this.#target, 'Article')
    this.#emit({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'written' }] },
      isError: false,
    })
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'tool-1',
      toolName: 'write',
      content: [{ type: 'text', text: 'written' }],
      isError: false,
      timestamp: Date.now(),
      usage: usage(2, 1),
    }
    this.#emit({ type: 'message_end', message: toolResult })
    this.#emit({ type: 'entry_appended', entry: entry('pi-tool-1', toolResult) })
    const final = assistant('Done', usage(5, 2))
    this.#emit({ type: 'message_start', message: final })
    this.#emit({
      type: 'message_update',
      message: final,
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Done',
        partial: final,
      },
    })
    this.#emit({ type: 'message_end', message: final })
    this.#emit({ type: 'entry_appended', entry: entry('pi-assistant-2', final) })
    this.#emit({ reason: 'threshold', type: 'compaction_start' })
    this.#emit({
      aborted: false,
      reason: 'threshold',
      result: {
        estimatedTokensAfter: 320,
        firstKeptEntryId: 'pi-assistant-2',
        summary: 'Private automatic summary',
        tokensBefore: 1_024,
        usage: usage(8, 3),
      },
      type: 'compaction_end',
      willRetry: false,
    })
    this.#emit({ type: 'agent_settled', aborted: false })
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve()
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners)
      listener(event)
  }
}

class ReasoningFailureSession implements ReusableBuddySession {
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>()

  abort(): Promise<void> {
    return Promise.resolve()
  }

  abortCompaction(): void {}

  canCompact(): boolean {
    return true
  }

  activateTurn(): Promise<() => void> {
    return Promise.resolve(() => {})
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  compact(): Promise<CompactionResult> {
    return Promise.reject(new Error('not used'))
  }

  prompt(): Promise<void> {
    const partial = assistant('', usage(1, 0))
    this.#emit({ message: partial, type: 'message_start' })
    this.#emit({
      assistantMessageEvent: { contentIndex: 0, partial, type: 'thinking_start' },
      message: partial,
      type: 'message_update',
    })
    for (const delta of ['Inspecting ', 'workspace ', 'files']) {
      this.#emit({
        assistantMessageEvent: { contentIndex: 0, delta, partial, type: 'thinking_delta' },
        message: partial,
        type: 'message_update',
      })
    }
    return Promise.reject(new Error('provider failed'))
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve()
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners)
      listener(event)
  }
}

class WaitingSession implements ReusableBuddySession {
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>()
  readonly started: Promise<void>
  #releaseStarted!: () => void
  #releasePrompt!: () => void

  constructor() {
    this.started = new Promise((resolve) => {
      this.#releaseStarted = resolve
    })
  }

  async abort(): Promise<void> {
    this.#releasePrompt()
    this.#emit({ type: 'agent_settled', aborted: true })
  }

  abortCompaction(): void {}

  canCompact(): boolean {
    return true
  }

  activateTurn(): Promise<() => void> {
    return Promise.resolve(() => {})
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  compact(): Promise<CompactionResult> {
    return Promise.reject(new Error('not used'))
  }

  prompt(): Promise<void> {
    this.#releaseStarted()
    return new Promise((resolve) => {
      this.#releasePrompt = resolve
    })
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve()
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners)
      listener(event)
  }
}

class ModelFailureSession implements ReusableBuddySession {
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>()

  abort(): Promise<void> {
    return Promise.resolve()
  }

  abortCompaction(): void {}

  canCompact(): boolean {
    return true
  }

  activateTurn(): Promise<() => void> {
    return Promise.resolve(() => {})
  }

  compact(): Promise<CompactionResult> {
    return Promise.reject(new Error('not used'))
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  prompt(): Promise<void> {
    const message: AssistantMessage = {
      api: 'openai-completions',
      content: [],
      errorMessage: 'The configured model does not exist; api_key=private-key',
      model: 'model-1',
      provider: 'provider-1',
      role: 'assistant',
      stopReason: 'error',
      timestamp: Date.now(),
      usage: usage(0, 0),
    }
    for (const listener of this.#listeners) {
      listener({ message, type: 'message_start' })
      listener({ message, type: 'message_end' })
    }
    return Promise.resolve()
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve()
  }
}

class IdleSession implements ReusableBuddySession {
  activateTurn: ReusableBuddySession['activateTurn'] = async () => () => {}

  abort(): Promise<void> {
    return Promise.resolve()
  }

  abortCompaction(): void {}

  canCompact(): boolean {
    return true
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  compact(): Promise<CompactionResult> {
    return Promise.reject(new Error('not used'))
  }

  prompt(): Promise<void> {
    return Promise.resolve()
  }

  subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
    return () => {}
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve()
  }
}

class MessageThenStorageFailureSession extends IdleSession {
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>()
  readonly #stopReason: AssistantMessage['stopReason']

  constructor(stopReason: AssistantMessage['stopReason']) {
    super()
    this.#stopReason = stopReason
  }

  override prompt(): Promise<void> {
    const message = {
      ...assistant('Durable final answer', usage(5, 2)),
      stopReason: this.#stopReason,
    }
    this.#emit({ type: 'message_start', message })
    this.#emit({ type: 'message_end', message })
    return Promise.reject(new BuddySessionStorageError())
  }

  override subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners)
      listener(event)
  }
}

class CompactionSession extends IdleSession {
  readonly compactionInstructions: string[] = []
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>()

  compact(instructions?: string): Promise<{
    estimatedTokensAfter: number
    firstKeptEntryId: string
    summary: string
    tokensBefore: number
    usage: Usage
  }> {
    this.compactionInstructions.push(instructions ?? '')
    const result = {
      estimatedTokensAfter: 400,
      firstKeptEntryId: 'pi-message-1',
      summary: 'Summary',
      tokensBefore: 1_200,
      usage: usage(20, 5),
    }
    this.#emit({ reason: 'manual', type: 'compaction_start' })
    this.#emit({
      aborted: false,
      reason: 'manual',
      result,
      type: 'compaction_end',
      willRetry: false,
    })
    return Promise.resolve(result)
  }

  override subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners)
      listener(event)
  }
}

class CompactionStorageFailureSession extends IdleSession {
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>()

  override compact(): Promise<never> {
    this.#emit({ reason: 'manual', type: 'compaction_start' })
    this.#emit({
      aborted: false,
      errorMessage: 'Compaction failed: EACCES: /secret/session.jsonl',
      reason: 'manual',
      result: undefined,
      type: 'compaction_end',
      willRetry: false,
    })
    return Promise.reject(new BuddySessionStorageError())
  }

  override subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners)
      listener(event)
  }
}

class IneligibleCompactionSession extends CompactionSession {
  activationCount = 0

  canCompact(): boolean {
    return false
  }

  override activateTurn = async (): Promise<() => void> => {
    this.activationCount += 1
    return () => {}
  }
}

class WaitingCompactionSession extends IdleSession {
  readonly started: Promise<void>
  compactionAborted = false
  #reject!: (reason: unknown) => void
  #started!: () => void

  constructor() {
    super()
    this.started = new Promise((resolve) => {
      this.#started = resolve
    })
  }

  abortCompaction(): void {
    this.compactionAborted = true
    const error = new Error('aborted')
    error.name = 'AbortError'
    this.#reject(error)
  }

  compact(): Promise<never> {
    this.#started()
    return new Promise((_, reject) => {
      this.#reject = reject
    })
  }
}

function assistant(text: string, value: Usage): AssistantMessage {
  return {
    api: 'anthropic-messages',
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    role: 'assistant',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: value,
  }
}

function entry(id: string, message: AssistantMessage | ToolResultMessage) {
  return {
    createdAt: new Date().toISOString(),
    id,
    message,
    parentId: null,
    timestamp: new Date().toISOString(),
    type: 'message' as const,
  }
}

function usage(input: number, output: number): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.02, total: 0.03 },
    input,
    output,
    totalTokens: input + output,
  }
}

interface SessionTestInput {
  branchId: string
  canonicalRoot: string
  conversationId: string
  cwd: string
  memoryScope?: 'personal_and_space' | 'space_only'
  spaceId: string | null
  resources: ReturnType<typeof emptyResources>
  scratchRoot?: string
  sessionMode?: 'automation_background' | 'interactive'
}

function withSession<T extends SessionTestInput & { prompt: string, runId: string }>(
  input: T,
): T & { session: BuddySessionBlueprint, userInput: ReturnType<typeof createBuddyInputReference> }
function withSession<T extends SessionTestInput>(input: T): T & { session: BuddySessionBlueprint }
function withSession<T extends SessionTestInput>(input: T) {
  const scratchRoot = input.scratchRoot ?? input.canonicalRoot
  const primaryGrant = {
    canonicalRoot: input.canonicalRoot,
    grantId: input.spaceId ? 'directory-1' : input.conversationId,
    kind: 'workspace' as const,
    root: input.canonicalRoot,
  }
  return {
    ...input,
    ...('prompt' in input && 'runId' in input
      ? {
          userInput: createBuddyInputReference({
            images: [],
            messageId: `message-${input.runId}`,
            prompt: String(input.prompt),
          }),
        }
      : {}),
    session: {
      branchId: input.branchId,
      canonicalRoot: input.canonicalRoot,
      conversationId: input.conversationId,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      grantRevision: 'grants-1',
      grants: scratchRoot === input.canonicalRoot
        ? [primaryGrant]
        : [primaryGrant, {
            canonicalRoot: scratchRoot,
            grantId: input.conversationId,
            kind: 'workspace' as const,
            root: scratchRoot,
          }],
      space: input.spaceId
        ? {
            additionalDirectoryBindings: [],
            id: input.spaceId,
            memoryScope: input.memoryScope ?? 'personal_and_space',
            primaryDirectoryBinding: { id: 'directory-1', revision: 1 },
          }
        : null,
      resources: input.resources,
      scratchRoot,
      sessionMode: input.sessionMode ?? 'interactive',
    },
  }
}

function emptyResources() {
  return {
    skillReadRoots: [],
    skillReferences: [],
    approvedSkills: [],
    context: { agentsFiles: [], diagnostics: [] },
    directoryContext: '',
    revision: 'resources-1',
  }
}

async function createFixture(options: { onCommit?: () => void } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-runner-')))
  directories.push(root)
  await mkdir(root, { recursive: true })
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const conversationsDirectory = join(root, 'conversations')
  const eventsDirectory = join(conversationsDirectory, 'conversation-1', 'events')
  const eventLog = createRunEventLog({ conversationsDirectory, database })
  if (options.onCommit)
    eventLog.onDidCommit(options.onCommit)
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const usageRepository = createUsageRepository(database)
  const usageService = new UsageService({ eventLog, repository: usageRepository })

  return {
    conversations,
    conversationsDirectory,
    createRunner(session: ReusableBuddySession) {
      return this.createRunnerFromFactory(async () => ({
        piSessionFile: join(root, 'session.jsonl'),
        session,
      }))
    },
    createRunnerFromFactory(
      sessionFactory: PiTurnExecutorOptions['sessionFactory'],
      sessions = new BuddySessionRegistry<ReusableBuddySession>(),
      executorOptions: Pick<PiTurnExecutorOptions, 'automationSessionStartupTimeoutMs'> = {},
    ) {
      const piEvents = new PiEventBridge({ eventLog, usage: usageService })
      return new BuddyAgentRunner({
        executor: new PiTurnExecutor({
          ...executorOptions,
          eventLog,
          piEvents,
          continuity: new RunContinuityService(runs),
          sessionFactory,
          sessions,
        }),
        lifecycle: new RunLifecycleService({ eventLog, repository: runs }),
        sessions,
      })
    },
    database,
    eventLog,
    eventsDirectory,
    prepareTurn(input: {
      branchId: string
      conversationId: string
      model: string
      spaceId: string | null
      provider: string
      runId: string
    }, userMessageId: string) {
      prepareTestTurnRequest(database, {
        attachmentBindings: [],
        branchId: input.branchId,
        conversationId: input.conversationId,
        createdAt: new Date().toISOString(),
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        model: input.model,
        spaceId: input.spaceId,
        provider: input.provider,
        requestFingerprint: `fingerprint-${input.runId}`,
        requestId: `request-${input.runId}`,
        runInput: {
          attachmentIds: [],
          contextItems: [],
          prompt: 'Prompt',
          reasoning: null,
          serviceTier: null,
        },
        runId: input.runId,
        title: null,
        userMessageContent: { text: 'Prompt' },
        userMessageId,
      })
    },
    prepareCompletedTurn() {
      this.prepareTurn({
        branchId: 'branch-1',
        conversationId: 'conversation-1',
        model: 'claude-sonnet-4-5',
        spaceId: null,
        provider: 'anthropic',
        runId: 'run-source',
      }, 'message-source')
      database.prepare(`
        UPDATE runs
        SET status = 'completed', pi_session_file = ?, completed_at = ?
        WHERE id = 'run-source'
      `).run(join(root, 'session.jsonl'), '2026-08-15T00:00:01.000Z')
    },
    prepareCompaction(runId: string) {
      prepareTestCommandRequest(database, {
        arguments: '',
        branchId: 'branch-1',
        command: 'compact',
        conversationId: 'conversation-1',
        createdAt: '2026-08-15T00:00:02.000Z',
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        requestFingerprint: `fingerprint-${runId}`,
        requestId: `request-${runId}`,
        runId,
      })
    },
    prepareInterruptedCompaction(runId: string) {
      this.prepareCompaction(runId)
      database.prepare(`
        UPDATE runs SET status = 'running' WHERE id = ?
      `).run(runId)
    },
    root,
    runs,
    usageRepository,
  }
}

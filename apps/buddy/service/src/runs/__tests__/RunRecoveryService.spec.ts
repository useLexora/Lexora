import type { Usage } from '@earendil-works/pi-ai'
import type { DatabaseSync } from 'node:sqlite'
import type { RunRecoveryServiceOptions } from '../RunRecoveryService'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BuddySessionStorageError } from '../../agent/sessions/BuddySessionErrors'
import { createRunEventLog } from '../../events/createRunEventLog'
import {
  prepareTestCommandRequest,
  prepareTestTurnRequest,
} from '../../storage/__tests__/composerDraftTestFixture'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { createUsageRepository } from '../../storage/usageRepository'
import { UsageService } from '../../usage/UsageService'
import { RunLifecycleService } from '../RunLifecycleService'
import { RunRecoveryService } from '../RunRecoveryService'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('runRecoveryService', () => {
  it('recovers an interrupted assistant snapshot before failing the run', async () => {
    const fixture = await createFixture()
    fixture.prepareInterruptedTurn('run-interrupted', 'message-interrupted')
    await fixture.eventLog.append({
      payload: { messageId: 'assistant-interrupted', role: 'assistant' },
      runId: 'run-interrupted',
      type: 'message.started',
    })
    await fixture.eventLog.appendBatch([
      {
        payload: { delta: 'Recovered ', messageId: 'assistant-interrupted' },
        runId: 'run-interrupted',
        type: 'message.delta',
      },
      {
        payload: { delta: 'partial answer', messageId: 'assistant-interrupted' },
        runId: 'run-interrupted',
        type: 'message.delta',
      },
    ])

    expect(await fixture.createRecoveryService().recoverInterruptedRuns()).toBe(1)
    expect(fixture.runs.findById('run-interrupted')).toMatchObject({
      errorCode: 'RUNTIME_RESTARTED',
      status: 'failed',
    })
    expect(fixture.conversations.findMessageById('assistant-interrupted')).toMatchObject({
      content: {
        state: 'interrupted',
        text: 'Recovered partial answer',
        truncated: false,
      },
      role: 'assistant',
      runId: 'run-interrupted',
    })
    expect((await fixture.eventLog.read('run-interrupted')).map(event => event.type)).toEqual([
      'message.started',
      'message.delta',
      'message.delta',
      'message.interrupted',
      'run.failed',
    ])
    await fixture.eventLog.compactTerminalRun('run-interrupted')
    expect((await fixture.eventLog.read('run-interrupted')).map(event => event.type)).toEqual([
      'message.started',
      'message.interrupted',
      'run.failed',
    ])
  })

  it('does not append an interrupted snapshot when the product message already exists', async () => {
    const fixture = await createFixture()
    fixture.prepareInterruptedTurn('run-existing-message', 'message-user-existing')
    await fixture.eventLog.append({
      createdAt: '2026-08-14T00:00:01.000Z',
      payload: { messageId: 'assistant-existing', role: 'assistant', content: { text: 'Already committed answer' }, stopReason: 'completed' },
      runId: 'run-existing-message',
      type: 'message.completed',
    })
    await fixture.eventLog.append({
      payload: { delta: 'Unmatched partial answer', messageId: 'assistant-existing' },
      runId: 'run-existing-message',
      type: 'message.delta',
    })

    await expect(fixture.createRecoveryService().recoverInterruptedRuns()).resolves.toBe(1)

    expect(fixture.conversations.findMessageById('assistant-existing')).toMatchObject({
      content: { text: 'Already committed answer' },
    })
    expect((await fixture.eventLog.read('run-existing-message')).map(event => event.type)).toEqual([
      'message.completed',
      'message.delta',
      'run.failed',
    ])
  })

  it('stops recovery when product message inspection fails', async () => {
    const fixture = await createFixture()
    fixture.prepareInterruptedTurn('run-message-inspection-failed', 'message-user-inspection')
    await fixture.eventLog.append({
      payload: { delta: 'Uncommitted answer', messageId: 'assistant-inspection' },
      runId: 'run-message-inspection-failed',
      type: 'message.delta',
    })
    const failure = new Error('product message inspection failed')

    await expect(fixture.createRecoveryService({
      conversations: {
        findMessageById() {
          throw failure
        },
      },
    }).recoverInterruptedRuns()).rejects.toBe(failure)

    expect(fixture.runs.findById('run-message-inspection-failed')).toMatchObject({
      errorCode: null,
      status: 'running',
    })
    expect((await fixture.eventLog.read('run-message-inspection-failed')).map(
      event => event.type,
    )).toEqual(['message.delta'])
  })

  it.each([false, true])('recovers Pi compaction evidence and usage with an existing Buddy completion: %s', async (completionRecorded) => {
    const fixture = await createFixture()
    fixture.prepareInterruptedCompaction('run-recover-compact')
    if (completionRecorded) {
      await fixture.eventLog.append({
        payload: { estimatedTokensAfter: 7, reason: 'manual', tokensBefore: 25, willRetry: false },
        runId: 'run-recover-compact',
        type: 'context.compaction.completed',
      })
    }

    expect(await fixture.createRecoveryService({
      inspectCommittedCompaction: async () => ({
        compactionEntryId: 'pi-compaction-1',
        estimatedTokensAfter: 7,
        firstKeptEntryId: 'pi-message-1',
        tokensBefore: 25,
        usage: usage(20, 5),
      }),
    }).recoverInterruptedRuns()).toBe(1)
    expect(fixture.runs.findById('run-recover-compact')).toMatchObject({
      errorCode: null,
      status: 'completed',
    })
    expect((await fixture.eventLog.read('run-recover-compact')).map(event => event.type)).toEqual([
      'context.compaction.completed',
      'usage.recorded',
      'run.completed',
    ])
    expect(fixture.usageRepository.listForRun('run-recover-compact')).toMatchObject([{
      inputTokens: 20,
      outputTokens: 5,
      purpose: 'compaction',
      sourceEntryId: 'compaction:pi-message-1',
    }])
    expect(fixture.conversations.listTimelinePage(
      'conversation-1',
      'branch-1',
      { limit: 10 },
    ).items.find(item => item.id === 'run-recover-compact')).toMatchObject({
      estimatedTokensAfter: 7,
      kind: 'compaction',
      status: 'completed',
      tokensBefore: 25,
    })
  })

  it('keeps durable compaction completion when optional Pi evidence is unavailable', async () => {
    const fixture = await createFixture()
    fixture.prepareInterruptedCompaction('run-recover-event-storage-failed')
    await fixture.eventLog.append({
      payload: {
        estimatedTokensAfter: 8,
        reason: 'manual',
        tokensBefore: 30,
        willRetry: false,
      },
      runId: 'run-recover-event-storage-failed',
      type: 'context.compaction.completed',
    })

    expect(await fixture.createRecoveryService({
      inspectCommittedCompaction: async () => { throw new BuddySessionStorageError() },
    }).recoverInterruptedRuns()).toBe(1)
    expect(fixture.runs.findById('run-recover-event-storage-failed')).toMatchObject({
      errorCode: null,
      status: 'completed',
    })
    expect((await fixture.eventLog.read('run-recover-event-storage-failed')).map(
      event => event.type,
    )).toEqual([
      'context.compaction.completed',
      'run.completed',
    ])
  })

  it('does not reinterpret a compaction lifecycle failure as missing evidence', async () => {
    const fixture = await createFixture()
    fixture.prepareInterruptedCompaction('run-compaction-lifecycle-failed')
    await fixture.eventLog.append({
      payload: {
        estimatedTokensAfter: 8,
        reason: 'manual',
        tokensBefore: 30,
        willRetry: false,
      },
      runId: 'run-compaction-lifecycle-failed',
      type: 'context.compaction.completed',
    })
    const failure = new Error('terminal reconciliation failed')

    await expect(fixture.createRecoveryService({
      lifecycle: {
        finalize(input) {
          if (input.status === 'completed')
            return Promise.reject(failure)
          return fixture.lifecycle.finalize(input)
        },
      },
    }).recoverInterruptedRuns()).rejects.toBe(failure)

    expect(fixture.runs.findById('run-compaction-lifecycle-failed')).toMatchObject({
      errorCode: null,
      status: 'running',
    })
    expect((await fixture.eventLog.read('run-compaction-lifecycle-failed')).map(
      event => event.type,
    )).toEqual(['context.compaction.completed'])
  })

  it.each([
    { storageUnavailable: false, errorCode: 'RUNTIME_RESTARTED' },
    { storageUnavailable: true, errorCode: 'SESSION_STORAGE_UNAVAILABLE' },
  ])('fails compaction without committed evidence using $errorCode', async ({ storageUnavailable, errorCode }) => {
    const fixture = await createFixture()
    fixture.prepareInterruptedCompaction('run-missing-compaction')

    expect(await fixture.createRecoveryService({
      inspectCommittedCompaction: async () => {
        if (storageUnavailable)
          throw new BuddySessionStorageError()
        return null
      },
    }).recoverInterruptedRuns()).toBe(1)
    expect(fixture.runs.findById('run-missing-compaction')).toMatchObject({ errorCode, status: 'failed' })
    expect(await fixture.eventLog.read('run-missing-compaction')).toEqual([
      expect.objectContaining({ payload: { errorCode }, type: 'run.failed' }),
    ])
  })
})

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-recovery-')))
  directories.push(root)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const eventLog = createRunEventLog({
    conversationsDirectory: join(root, 'conversations'),
    database,
  })
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const usageRepository = createUsageRepository(database)
  const usageService = new UsageService({ eventLog, repository: usageRepository })
  const lifecycle = new RunLifecycleService({ eventLog, repository: runs })
  const prepareTurn = (runId: string, userMessageId: string) => {
    prepareTestTurnRequest(database, {
      attachmentBindings: [],
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      model: 'claude-sonnet-4-5',
      spaceId: null,
      provider: 'anthropic',
      requestFingerprint: `fingerprint-${runId}`,
      requestId: `request-${runId}`,
      runInput: {
        attachmentIds: [],
        contextItems: [],
        prompt: 'Prompt',
        reasoning: null,
        serviceTier: null,
      },
      runId,
      title: null,
      userMessageContent: { text: 'Prompt' },
      userMessageId,
    })
  }
  const prepareCompletedTurn = () => {
    prepareTurn('run-source', 'message-source')
    database.prepare(`
      UPDATE runs
      SET status = 'completed', pi_session_file = ?, completed_at = ?
      WHERE id = 'run-source'
    `).run(join(root, 'session.jsonl'), '2026-08-15T00:00:01.000Z')
  }

  return {
    conversations,
    createRecoveryService(
      options: Partial<Pick<
        RunRecoveryServiceOptions,
        | 'conversations'
        | 'inspectCommittedCompaction'
        | 'lifecycle'
      >> = {},
    ) {
      return new RunRecoveryService({
        conversations,
        eventLog,
        lifecycle,
        ...options,
        repository: runs,
        usage: usageService,
      })
    },
    eventLog,
    lifecycle,
    prepareInterruptedCompaction(runId: string) {
      prepareCompletedTurn()
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
      database.prepare('UPDATE runs SET status = ? WHERE id = ?').run('running', runId)
    },
    prepareInterruptedTurn(runId: string, userMessageId: string) {
      prepareTurn(runId, userMessageId)
      database.prepare('UPDATE runs SET status = ? WHERE id = ?').run('running', runId)
    },
    runs,
    usageRepository,
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

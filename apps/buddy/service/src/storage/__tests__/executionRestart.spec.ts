import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createRunEventLog } from '../../events/createRunEventLog'
import { RunLifecycleService } from '../../runs/RunLifecycleService'
import { RunRecoveryService } from '../../runs/RunRecoveryService'
import { UsageService } from '../../usage/UsageService'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createExecutionRepository } from '../executionRepository'
import { createMailboxRepository } from '../mailboxRepository'
import { createRunRepository } from '../runRepository'
import { createUsageRepository } from '../usageRepository'
import { createExecutionStorageFixture, executionNow } from './executionFixture'

it('reopens an active root with a completed child and interrupts unknown work without consuming results or replaying tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-execution-restart-'))
  const databasePath = join(directory, 'buddy.sqlite3')
  const f = createExecutionStorageFixture(databasePath)
  let database = f.database
  let events = createRunEventLog({ database, conversationsDirectory: join(directory, 'conversations') })
  const changedFile = join(directory, 'changed.txt')
  try {
    f.conversations.createMessage({ id: 'goal', conversationId: 'conversation', branchId: 'branch', runId: null, role: 'user', content: { text: 'Original root goal' }, createdAt: executionNow })
    f.executions.admitChild(f.child('done'))
    await events.appendBatch([
      { runId: 'done', type: 'message.completed', payload: { messageId: 'private-answer', role: 'assistant', stopReason: 'completed', content: { text: 'Completed child evidence' } } },
      { runId: 'done', type: 'execution.mailbox.sent', payload: { messageId: 'result-done', kind: 'result', targetRunId: 'root', targetGeneration: 0, text: 'Completed child evidence' } },
      { runId: 'done', type: 'run.completed', payload: {} },
    ])
    f.executions.admitChild(f.child('unknown'))
    f.executions.claimWorking(f.fence('unknown'))
    f.runs.markRunning('unknown', executionNow)
    await events.append({ runId: 'unknown', type: 'tool.started', payload: { toolCallId: 'write-once', toolName: 'write', arguments: { path: changedFile } } })
    await writeFile(changedFile, 'Unresolved side effect remains intact')
    expect(createMailboxRepository(database).listPending('root')).toHaveLength(1)
    await events.close()
    database.close()
    database = openBuddyDatabase({ databasePath })
    events = createRunEventLog({ database, conversationsDirectory: join(directory, 'conversations') })
    const runs = createRunRepository(database)
    const executions = createExecutionRepository(database)
    const mailbox = createMailboxRepository(database)
    expect(runs.findById('done')?.status).toBe('completed')
    expect(mailbox.find('result-done')?.state).toBe('pending')
    const sourceFacts = await events.read('done')
    const usage = new UsageService({ eventLog: events, repository: createUsageRepository(database) })
    const recovery = new RunRecoveryService({ conversations: createConversationRepository(database), eventLog: events, lifecycle: new RunLifecycleService({ eventLog: events, repository: runs }), repository: runs, usage })
    expect(await recovery.recoverInterruptedRuns()).toBe(2)
    expect(runs.findById('root')).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_RESTARTED' })
    expect(runs.findById('unknown')).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_RESTARTED' })
    expect(runs.findById('done')?.status).toBe('completed')
    expect(mailbox.find('result-done')).toMatchObject({ state: 'undelivered', receipt: null, message: { text: 'Completed child evidence' } })
    expect(mailbox.listUnconsumed('root')).toEqual([])
    expect(runs.listIncomplete()).toEqual([])
    expect(executions.listTree('root').map(record => record.phase)).toEqual(['closed', 'closed', 'closed'])
    expect(await events.read('done')).toEqual(sourceFacts)
    expect((await events.read('unknown')).map(event => event.type)).toEqual(['tool.started', 'run.failed'])
    expect((await events.read('root')).map(event => event.type)).toEqual(['run.failed'])
    expect(await recovery.recoverInterruptedRuns()).toBe(0)
    await events.recoverAll({ force: true })
    expect(mailbox.find('result-done')?.state).toBe('undelivered')
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 3 })
    expect(database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'goal' }])
    expect(await readFile(changedFile, 'utf8')).toBe('Unresolved side effect remains intact')
    usage.dispose()
  }
  finally {
    await events.close()
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['branch', 'delete'] as const)('retains a late child result as undelivered after %s without publishing or injecting it', async (boundary) => {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-late-execution-'))
  const f = createExecutionStorageFixture()
  const events = createRunEventLog({ database: f.database, conversationsDirectory: directory })
  const mailbox = createMailboxRepository(f.database)
  try {
    f.executions.admitChild(f.child('late-child'))
    if (boundary === 'branch') {
      f.conversations.createBranch({ id: 'new-branch', conversationId: 'conversation', parentBranchId: null, forkedFromMessageId: null, createdAt: executionNow, activate: true })
    }
    else {
      f.conversations.markDeleted('conversation', executionNow)
    }
    await events.appendBatch([
      { runId: 'late-child', type: 'message.completed', payload: { messageId: 'late-answer', role: 'assistant', stopReason: 'completed', content: { text: 'PRIVATE_LATE_RESULT' } } },
      { runId: 'late-child', type: 'execution.mailbox.sent', payload: { messageId: 'late-result', kind: 'result', targetRunId: 'root', targetGeneration: 0, text: 'PRIVATE_LATE_RESULT' } },
      { runId: 'late-child', type: 'run.completed', payload: {} },
    ])
    expect(mailbox.find('late-result')).toMatchObject({ state: 'undelivered', receipt: null })
    expect(mailbox.listUnconsumed('root')).toEqual([])
    const message = mailbox.find('late-result')!.message
    await expect(events.append({ runId: 'root', type: 'execution.mailbox.accepted', payload: { messageId: message.messageId, sourceRunId: message.sourceRunId, payloadHash: message.payloadHash, contextEntryId: 'wrong-new-context' } })).rejects.toThrow('cannot accept')
    await events.replay('late-child')
    expect(mailbox.find('late-result')?.state).toBe('undelivered')
    expect(f.database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(f.database.prepare('SELECT count(*) AS count FROM execution_mailbox_receipts').get()).toEqual({ count: 0 })
    expect(f.runs.findById('root')).toMatchObject({ branchId: 'branch', status: 'running' })
    expect(f.runs.listTree('root')).toHaveLength(2)
  }
  finally {
    await events.close()
    f.database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

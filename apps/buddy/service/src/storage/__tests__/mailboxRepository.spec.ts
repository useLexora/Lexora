import type { ExecutionMailboxMessage, ExecutionMailboxReceipt } from '../../../../shared/executions/executionApi'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executionMailboxMessageSchema } from '../../../../shared/executions/executionApi'
import { createRunEventLog } from '../../events/createRunEventLog'
import { createMailboxRepository, hashExecutionMailboxMessage } from '../mailboxRepository'
import { createExecutionStorageFixture, executionNow } from './executionFixture'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse())
    await stop()
})

async function fixture() {
  const f = createExecutionStorageFixture()
  const directory = await mkdtemp(join(tmpdir(), 'lexora-mailbox-'))
  f.executions.admitChild(f.child('child'))
  const options = { database: f.database, conversationsDirectory: directory }
  const logs = [createRunEventLog(options)]
  cleanup.push(async () => {
    for (const log of logs)
      await log.close()
    f.database.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...f, log: logs[0]!, mailbox: createMailboxRepository(f.database), reopen() {
    const log = createRunEventLog(options)
    logs.push(log)
    return log
  } }
}

function receipt(message: ExecutionMailboxMessage): ExecutionMailboxReceipt {
  return { sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, contextEntryId: `entry-${message.messageId}` }
}

async function send(f: Awaited<ReturnType<typeof fixture>>, messageId = 'result-child') {
  const event = await f.log.append({ runId: 'child', type: 'execution.mailbox.sent', createdAt: executionNow, payload: { kind: 'result', messageId, targetRunId: 'root', targetGeneration: 0, text: 'Research result' } })
  return executionMailboxMessageSchema.parse(event.payload)
}

describe('durable execution mailbox projection', () => {
  it('preserves legacy hashes and the progress purpose across durable replay', async () => {
    const legacy = { messageId: 'legacy-progress', sourceRunId: 'child', sourceSequence: 1, targetRunId: 'root', targetGeneration: 0, kind: 'supplement' as const, text: 'Progress' }
    expect(hashExecutionMailboxMessage(legacy)).toBe('db90786754e201eb8e54e20117d71d2ea2a28989310ef5ccd149ababc4bc8055')
    const f = await fixture()
    const event = await f.log.append({ runId: 'child', type: 'execution.mailbox.sent', payload: { kind: 'supplement', purpose: 'progress', messageId: 'progress', targetRunId: 'root', targetGeneration: 0, text: 'Still working' } })
    const message = executionMailboxMessageSchema.parse(event.payload)
    expect(message).toMatchObject({ purpose: 'progress' })
    expect(message.payloadHash).not.toBe(hashExecutionMailboxMessage(executionMailboxMessageSchema.parse({ ...message, purpose: undefined })))
    await f.log.replay('child')
    expect(f.mailbox.listUnconsumed('root')).toEqual([message])
  })

  it('allocates the real source sequence inside serialized batches and keeps child messages out of ordinary answers', async () => {
    const f = await fixture()
    await f.log.append({ runId: 'child', type: 'audit.recorded', payload: {} })
    const events = await f.log.appendBatch([
      { runId: 'child', type: 'message.completed', payload: { role: 'assistant', messageId: 'private-answer', content: { text: 'Private result' }, stopReason: 'completed' } },
      { runId: 'child', type: 'execution.mailbox.sent', payload: { kind: 'result', messageId: 'result-child', targetRunId: 'root', targetGeneration: 0, text: 'Research result' } },
      { runId: 'child', type: 'run.completed', payload: {} },
    ])
    const message = executionMailboxMessageSchema.parse(events[1]!.payload)
    expect(message).toMatchObject({ sourceRunId: 'child', sourceSequence: 3 })
    expect(message.payloadHash).toBe(hashExecutionMailboxMessage(message))
    expect(f.mailbox.listPending('root')).toEqual([message])
    expect(f.database.prepare('SELECT 1 FROM messages WHERE id = ?').get('private-answer')).toBeUndefined()
    expect(f.executions.find('child')?.phase).toBe('closed')
    f.executions.recordCleanup('child', 'clean', null)
    expect(() => f.executions.beginClosing(f.fence('root'), 'success')).toThrow(expect.objectContaining({ code: 'pending' }))
    await f.log.appendBatch([
      { runId: 'root', type: 'execution.mailbox.accepted', payload: receipt(message) },
      { runId: 'root', type: 'execution.mailbox.consumed', payload: receipt(message) },
    ])
    expect(f.executions.beginClosing(f.fence('root'), 'success').phase).toBe('closing')
  })

  it.each(['parent-first', 'child-first', 'child-only'] as const)('preserves acknowledged results after %s replay', async (order) => {
    const f = await fixture()
    const message = await send(f)
    await f.log.append({ runId: 'root', type: 'execution.mailbox.accepted', payload: receipt(message) })
    expect(f.mailbox.listPending('root')).toEqual([])
    expect(f.mailbox.listUnconsumed('root')).toEqual([message])
    const replayOrder = order === 'parent-first' ? ['root', 'child'] : order === 'child-first' ? ['child', 'root'] : ['child']
    for (const runId of replayOrder)
      await f.log.replay(runId)
    expect(f.mailbox.find(message.messageId)).toMatchObject({ state: 'accepted', receipt: receipt(message) })
    expect(f.mailbox.listPending('root')).toEqual([])
    await f.log.append({ runId: 'root', type: 'execution.mailbox.consumed', payload: receipt(message) })
    for (const runId of replayOrder)
      await f.log.replay(runId)
    expect(f.mailbox.find(message.messageId)?.state).toBe('consumed')
    expect(f.mailbox.listUnconsumed('root')).toEqual([])
  })

  it('repairs a durable source whose SQL projection failed without losing the required delivery obligation', async () => {
    const f = await fixture()
    f.database.exec('CREATE TRIGGER reject_mailbox BEFORE INSERT ON execution_mailbox_sources BEGIN SELECT RAISE(ABORT, \'projection failed\'); END')
    await expect(f.log.appendBatch([
      { runId: 'child', type: 'execution.mailbox.sent', payload: { kind: 'result', messageId: 'result-child', targetRunId: 'root', targetGeneration: 0, text: 'Persisted result' } },
      { runId: 'child', type: 'run.completed', payload: {} },
    ])).rejects.toMatchObject({ code: 'EVENT_PROJECTION_FAILED', commitState: 'committed' })
    expect(f.mailbox.find('result-child')).toBeNull()
    expect(f.executions.find('child')?.resultMailboxId).toBe('result-child')
    expect(() => f.executions.beginClosing(f.fence('root'), 'success')).toThrow(expect.objectContaining({ code: 'pending' }))
    f.database.exec('DROP TRIGGER reject_mailbox')
    const recovered = f.reopen()
    await recovered.replay('child')
    expect(f.mailbox.find('result-child')).toMatchObject({ state: 'pending', message: { text: 'Persisted result' } })
    expect(f.executions.find('child')?.phase).toBe('closed')
  })

  it('allows target-first reconstruction when source projection is absent and never resets a receipt from source rebuild', async () => {
    const f = await fixture()
    const message = await send(f)
    await f.log.append({ runId: 'root', type: 'execution.mailbox.accepted', payload: receipt(message) })
    f.database.exec('DELETE FROM execution_mailbox_sources; DELETE FROM execution_mailbox_receipts')
    await f.log.replay('root')
    expect(f.database.prepare('SELECT context_entry_id FROM execution_mailbox_receipts WHERE mailbox_id = ?').get(message.messageId)?.context_entry_id).toBe(receipt(message).contextEntryId)
    await f.log.replay('child')
    expect(f.mailbox.find(message.messageId)?.state).toBe('accepted')
  })

  it('rejects source identity/hash and context-marker conflicts instead of silently overwriting facts', async () => {
    const f = await fixture()
    const message = await send(f)
    await f.log.append({ runId: 'root', type: 'execution.mailbox.accepted', payload: receipt(message) })
    await expect(f.log.append({ runId: 'root', type: 'execution.mailbox.accepted', payload: { ...receipt(message), contextEntryId: 'other-entry' } })).rejects.toThrow('marker conflicts')
    await expect(f.log.append({ runId: 'root', type: 'execution.mailbox.consumed', payload: { ...receipt(message), payloadHash: '0'.repeat(64) } })).rejects.toThrow('identity conflicts')
    await expect(f.log.append({ runId: 'child', type: 'execution.mailbox.sent', payload: { kind: 'result', messageId: message.messageId, targetRunId: 'root', targetGeneration: 0, text: 'Different result' } })).rejects.toThrow('identity conflicts')
    expect(f.mailbox.find(message.messageId)?.state).toBe('accepted')
  })

  it.each(['pending', 'accepted'] as const)('settles %s expired targets as undelivered without reviving them on replay', async (state) => {
    const f = await fixture()
    const message = await send(f)
    if (state === 'accepted')
      await f.log.append({ runId: 'root', type: 'execution.mailbox.accepted', payload: receipt(message) })
    f.executions.requestCancel('root', executionNow)
    expect(f.mailbox.listPending('root')).toEqual([])
    expect(f.mailbox.find(message.messageId)?.state).toBe('undelivered')
    await expect(f.log.append({ runId: 'root', type: 'execution.mailbox.accepted', payload: receipt(message) })).rejects.toThrow('cannot accept')
    if (state === 'pending')
      await f.log.append({ runId: 'root', type: 'execution.mailbox.rejected', payload: { sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, reason: 'cancelled' } })
    await f.log.replay('child')
    expect(f.mailbox.find(message.messageId)?.state).toBe('undelivered')
    expect(f.executions.find('root')?.run.status).toBe('running')
    expect(f.executions.find('root')?.cancelRequestedAt).toBe(executionNow)
  })
})

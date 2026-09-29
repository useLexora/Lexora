import type { DatabaseSync } from 'node:sqlite'
import type { ExtensionInvocationScope } from '../../plugins/extensionAgentHandlers'
import { afterEach, describe, expect, it } from 'vitest'
import { createConversationHistoryStore } from '../../storage/conversationHistoryRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionTaskContextRepository } from '../../storage/extensionTaskContextRepository'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { ConversationMetadataService } from '../ConversationMetadataService'
import { createExtensionTaskCapabilities } from '../extensionTaskCapabilities'
import { ExtensionTaskContext } from '../ExtensionTaskContext'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const tasks = createConversationRepository(database)
  const createdAt = '2026-09-28T00:00:00.000Z'
  tasks.create({ id: 'task', branchId: 'branch', title: 'Original', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt })
  tasks.createMessage({ id: 'input', conversationId: 'task', branchId: 'branch', runId: null, role: 'user', content: 'Initial goal', createdAt })
  tasks.setModelSelection({ id: 'task', modelSelection: { providerId: 'fixture', modelId: 'fixture', reasoning: null, serviceTier: null }, updatedAt: createdAt })
  const history = createExtensionTaskContextRepository(database, createConversationHistoryStore(database).lineage)
  const domain = new ExtensionTaskContext(tasks, history, createRunRepository(database), createRunInputRepository(database))
  const metadata = new ConversationMetadataService({ repository: tasks, resolveModelSelection: async value => value, sessions: { invalidateConversation: async () => ({ pending: 0, degraded: 0 }) } })
  const controller = new AbortController()
  function invocation(user = false) {
    const scope: ExtensionInvocationScope = { conversationId: 'task', runId: null, extensionId: 'tests.actions', invocationId: 'invocation', signal: controller.signal, action: { id: 'tests.actions.generate', cause: user ? { type: 'user' } : { type: 'task:input:committed', data: { conversationId: 'task', branchId: 'branch', runId: 'run', messageId: 'input', commitId: 'commit' } } } }
    return { handlers: createExtensionTaskCapabilities(metadata, history, domain.open(scope), scope), context: { ...scope, callNumber: 1 } }
  }
  return { database, tasks, metadata, controller, invocation, history, domain }
}

describe('invocation-owned task capabilities', () => {
  it('accepts completion after an in-run follow-up but rejects it after a newer run input', () => {
    const f = fixture()
    f.database.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, completed_at)
      VALUES ('run', 'task', 'branch', 'input', 'fixture', 'fixture', 'chat', 'completed', '2026-09-28T00:00:00.000Z', '2026-09-28T00:01:00.000Z')`).run()
    const cause = { type: 'task:turn:completed', data: { conversationId: 'task', branchId: 'branch', runId: 'run', triggeringMessageId: 'input', completedAt: '2026-09-28T00:01:00.000Z' } } as const
    expect(f.domain.valid('task', cause)).toBe(true)
    f.tasks.createMessage({ id: 'follow-up', conversationId: 'task', branchId: 'branch', runId: null, role: 'user', content: 'New goal in the same run', createdAt: '2026-09-28T00:00:30.000Z' })
    f.database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, run_id, created_at)
      VALUES ('follow-up', 'task', 'branch', 'request', 'fingerprint', ?, 'sent', 'run', '2026-09-28T00:00:30.000Z')`).run(JSON.stringify({ runInput: { prompt: 'New goal', attachmentIds: [], contextItems: [], reasoning: null, serviceTier: null } }))
    expect(f.domain.valid('task', cause)).toBe(true)
    f.tasks.createMessage({ id: 'later', conversationId: 'task', branchId: 'branch', runId: null, role: 'user', content: 'A different input after completion', createdAt: '2026-09-28T00:01:30.000Z' })
    expect(f.domain.valid('task', cause)).toBe(false)
  })

  it('protects historical titles and lets an explicit user action replace exactly the captured revision', async () => {
    const f = fixture()
    f.database.prepare('UPDATE conversations SET title_revision = 0 WHERE id = \'task\'').run()
    const auto = f.invocation()
    expect(await auto.handlers['task.get'](null, auto.context)).toEqual({ id: 'task', title: 'Original', titleSource: 'legacy' })
    expect(await auto.handlers['task.rename']({ title: 'Automatic' }, auto.context)).toEqual({ applied: false })
    const user = f.invocation(true)
    expect(await user.handlers['task.rename']({ title: 'Requested' }, user.context)).toEqual({ applied: true })
    expect(f.tasks.getTitleState('task')).toEqual({ title: 'Requested', source: 'generated', revision: 1 })
    expect(await user.handlers['task.rename']({ title: 'Second write' }, user.context)).toEqual({ applied: false })
  })

  it('keeps a manual change even when the plugin rereads the latest title', async () => {
    const f = fixture()
    const invocation = f.invocation(true)
    f.metadata.rename({ id: 'task', title: 'User wins' })
    expect(await invocation.handlers['task.get'](null, invocation.context)).toEqual({ id: 'task', title: 'User wins', titleSource: 'manual' })
    expect(await invocation.handlers['task.rename']({ title: 'Stale result' }, invocation.context)).toEqual({ applied: false })
    expect(f.tasks.findById('task')?.title).toBe('User wins')
  })

  it.each(['new input', 'branch', 'delete', 'abort'])('rejects writes and message reads after %s', async (change) => {
    const f = fixture()
    const invocation = f.invocation(true)
    if (change === 'new input')
      f.tasks.createMessage({ id: 'next', conversationId: 'task', branchId: 'branch', runId: null, role: 'user', content: 'New goal', createdAt: '2026-09-28T00:00:01.000Z' })
    if (change === 'branch')
      f.tasks.createBranch({ id: 'other', conversationId: 'task', parentBranchId: 'branch', forkedFromMessageId: 'input', createdAt: '2026-09-28T00:00:01.000Z', activate: true })
    if (change === 'delete')
      f.tasks.markDeleted('task', '2026-09-28T00:00:01.000Z')
    if (change === 'abort')
      f.controller.abort()
    await expect(invocation.handlers['task.rename']({ title: 'Late' }, invocation.context)).rejects.toThrow()
    await expect(invocation.handlers['task.messages'](null, invocation.context)).rejects.toThrow()
    expect(f.tasks.findById('task')?.title).toBe('Original')
  })

  it('returns bounded visible text while excluding tool output and inactive branches', () => {
    const f = fixture()
    f.tasks.createBranch({ id: 'hidden', conversationId: 'task', parentBranchId: 'branch', forkedFromMessageId: 'input', createdAt: '2026-09-28T00:00:01.000Z', activate: false })
    for (let index = 0; index < 30; index++)
      f.tasks.createMessage({ id: `reply-${index}`, conversationId: 'task', branchId: 'branch', runId: null, role: 'assistant', content: { text: 'x'.repeat(3000) }, createdAt: new Date(Date.UTC(2026, 8, 28, 0, 1, index)).toISOString() })
    f.tasks.createMessage({ id: 'tool', conversationId: 'task', branchId: 'branch', runId: null, role: 'tool', content: 'tool-private', createdAt: '2026-09-28T00:02:00.000Z' })
    f.tasks.createMessage({ id: 'hidden-message', conversationId: 'task', branchId: 'hidden', runId: null, role: 'user', content: 'hidden-private', createdAt: '2026-09-28T00:02:00.000Z' })
    const messages = f.history.messages('task', 'branch')
    expect(messages).toHaveLength(16)
    expect(messages[0]).toEqual({ role: 'user', text: 'Initial goal' })
    expect(messages.every(message => message.text.length <= 1500)).toBe(true)
    expect(JSON.stringify(messages)).not.toContain('private')
  })
})

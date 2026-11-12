import type { ExtensionAgentDescriptor } from '../../../../shared/extensions/extensionAgent'
import type { ExtensionAgentRuntime } from '../ExtensionAgentRuntime'
import { deferred } from '@buddy-tests/deferred'
import { expect, it } from 'vitest'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionInvocationRepository } from '../../storage/extensionInvocationRepository'
import { ExtensionActionService } from '../ExtensionActionService'

it('drains cancelled task actions before deletion without waiting for unrelated tasks', async () => {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const conversations = createConversationRepository(database)
  for (const id of ['one', 'two'])
    conversations.create({ id, branchId: `branch-${id}`, title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: new Date().toISOString() })
  const plugin: ExtensionAgentDescriptor = { id: 'tests.drain', name: 'Drain', revision: 'package', configurationRevision: 'config', agent: { instructions: '', tools: [], actions: [{ id: 'tests.drain.manual', title: 'Manual', triggers: ['user'] }] } }
  const gates = new Map(['one', 'two'].map(id => [id, deferred<void>()]))
  const signals = new Map<string, AbortSignal>()
  const entered = deferred<void>()
  const runtime: Pick<ExtensionAgentRuntime, 'descriptors' | 'invoke'> = {
    descriptors: async () => [plugin],
    invoke: async (_plugin, _request, scope, signal) => {
      signals.set(scope.conversationId, signal)
      if (signals.size === 2)
        entered.resolve()
      await gates.get(scope.conversationId)!.promise
      return { status: 'completed' }
    },
  }
  const service = new ExtensionActionService({ runtime, repository: createExtensionInvocationRepository(database), capture: conversationId => ({ branchId: `branch-${conversationId}`, sourceMessageId: null }) })
  try {
    const actions = ['one', 'two'].map(conversationId => service.invoke({ conversationId, extensionId: plugin.id, actionId: 'tests.drain.manual' }))
    await entered.promise
    let drained = false
    const draining = service.cancelAndWait('one').then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(signals.get('one')!.aborted).toBe(true)
    expect(signals.get('two')!.aborted).toBe(false)
    expect(drained).toBe(false)
    gates.get('one')!.resolve()
    await draining
    expect(database.prepare('SELECT conversation_id, status FROM extension_invocations ORDER BY conversation_id').all()).toEqual([
      { conversation_id: 'one', status: 'cancelled' },
      { conversation_id: 'two', status: 'running' },
    ])
    gates.get('two')!.resolve()
    await Promise.all(actions)
  }
  finally {
    for (const gate of gates.values()) gate.resolve()
    await service.dispose()
    database.close()
  }
})

import type { ConversationCleanup, ConversationCleanupItem } from '../../../shared/conversation/conversationCleanupApi'
import { expect, it } from 'vitest'
import { createExtensionTaskCleanup } from '../createExtensionTaskCleanup'

function fixture() {
  const records = new Map<string, ConversationCleanupItem & { scope: string, internalPath: string }>([
    ['removed', { conversationId: 'removed', scope: 'legacy_removed', title: 'Removed task', removedAt: '2026-01-01T00:00:00Z', expectedRevision: 4, estimatedBytes: null, canDelete: true, blockedReason: null, internalPath: '/private/removed' }],
    ['active', { conversationId: 'active', scope: 'active', title: 'Active task', removedAt: '', expectedRevision: 1, estimatedBytes: null, canDelete: false, blockedReason: null, internalPath: '/private/active' }],
  ])
  const cleanup: ConversationCleanup = {
    list: async input => ({ items: [...records.values()].filter(item => item.scope === input.scope).slice(0, input.limit), nextCursor: null }),
    delete: async (input) => {
      const item = records.get(input.conversationId)
      if (!item || item.scope !== input.scope || item.expectedRevision !== input.expectedRevision)
        return { status: 'failed', errorCode: 'SOURCE_CHANGED' }
      records.delete(input.conversationId)
      return { status: 'deleted' }
    },
  }
  return { records, adapter: createExtensionTaskCleanup(cleanup) }
}

it('restricts the domain listing to legacy removals and projects only public metadata', async () => {
  const { adapter } = fixture()
  expect(await adapter.list({ limit: 50 })).toEqual({
    items: [{ conversationId: 'removed', title: 'Removed task', removedAt: '2026-01-01T00:00:00Z', expectedRevision: 4, estimatedBytes: null, canDelete: true, blockedReason: null }],
    nextCursor: null,
  })
  await expect(adapter.list({ scope: 'active' } as never)).rejects.toThrow()
})

it('preserves the exact target and revision without letting the plugin expand the cleanup scope', async () => {
  const { adapter, records } = fixture()
  await expect(adapter.delete({ conversationId: 'active', expectedRevision: 1 })).resolves.toEqual({ status: 'failed', errorCode: 'SOURCE_CHANGED' })
  await expect(adapter.delete({ conversationId: 'removed', expectedRevision: 3 })).resolves.toEqual({ status: 'failed', errorCode: 'SOURCE_CHANGED' })
  await expect(adapter.delete({ conversationId: 'active', expectedRevision: 1, scope: 'active' } as never)).rejects.toThrow()
  expect([...records.keys()]).toEqual(['removed', 'active'])
  await expect(adapter.delete({ conversationId: 'removed', expectedRevision: 4 })).resolves.toEqual({ status: 'deleted' })
  expect([...records.keys()]).toEqual(['active'])
})

it('keeps accepted cleanup separate from completion and preserves failure diagnostics', async () => {
  const adapter = createExtensionTaskCleanup({
    list: async () => ({ items: [], nextCursor: null }),
    delete: async input => input.conversationId === 'pending' ? { status: 'pending' } : { status: 'failed', errorCode: 'CONVERSATION_FILES_REFERENCED' },
  })
  await expect(adapter.delete({ conversationId: 'pending', expectedRevision: 4 })).resolves.toEqual({ status: 'pending' })
  await expect(adapter.delete({ conversationId: 'failed', expectedRevision: 4 })).resolves.toEqual({ status: 'failed', errorCode: 'CONVERSATION_FILES_REFERENCED' })
})

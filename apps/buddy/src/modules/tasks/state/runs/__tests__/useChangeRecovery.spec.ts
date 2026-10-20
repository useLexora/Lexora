import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { ChangeRecoveryResolveRequest, LocalChangeRecoveryItem } from '@buddy-shared/changes/changeApi'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useChangeRecovery } from '../useChangeRecovery'

const disposals: (() => void)[] = []
afterEach(() => disposals.splice(0).forEach(dispose => dispose()))

function item(invocationId = 'old-operation'): LocalChangeRecoveryItem {
  return { invocationId, runId: 'old-run', conversationId: 'old-task', taskTitle: 'Earlier task', occurredAt: '2026-10-15T00:00:00.000Z', affectedResources: ['/workspace/example'], reason: 'MUTATION_INTERRUPTED', status: 'unknown', revision: 'revision-1' }
}

function setup() {
  const conversationId = shallowRef<string | null>('new-task')
  const ready = shallowRef(false)
  const recovery: LocalChatApi['changes']['recovery'] = {
    list: vi.fn(async () => [item()]),
    recheck: vi.fn(async () => [item()]),
    resolve: vi.fn(async () => []),
  }
  const scope = effectScope()
  disposals.push(() => scope.stop())
  const state = scope.run(() => useChangeRecovery({
    conversationId,
    ready,
    api: {
      changes: { recovery, onChanged: () => () => {} },
      chat: { onRunEvent: () => () => {} },
    },
  }))!
  return { conversationId, ready, recovery, state }
}

describe('task change recovery', () => {
  it('loads actual older blockers for the requesting task without transforming their ownership', async () => {
    const f = setup()
    f.ready.value = true
    await vi.waitFor(() => expect(f.state.items.value).toEqual([item()]))
    await f.state.recheck()
    expect(f.state.items.value[0]?.conversationId).toBe('old-task')
    expect(vi.mocked(f.recovery.recheck).mock.calls[0]?.[0]).toEqual({ conversationId: 'new-task', invocationIds: ['old-operation'] })
  })

  it('does not apply a late response from the previous task', async () => {
    const f = setup()
    const late = deferred<readonly LocalChangeRecoveryItem[]>()
    vi.mocked(f.recovery.list).mockImplementation(async input => input.conversationId === 'new-task' ? late.promise : [item('second-task-operation')])
    f.ready.value = true
    f.conversationId.value = 'second-task'
    await vi.waitFor(() => expect(f.state.items.value[0]?.invocationId).toBe('second-task-operation'))
    late.resolve([item()])
    await late.promise
    expect(f.state.items.value[0]?.invocationId).toBe('second-task-operation')
  })

  it('applies the server list without clearing new or active blockers outside the fixed decision', async () => {
    const f = setup()
    f.ready.value = true
    await vi.waitFor(() => expect(f.state.items.value).toHaveLength(1))
    const additional = { ...item('additional-operation'), status: 'active' as const }
    vi.mocked(f.recovery.resolve).mockResolvedValue([additional])
    const decision: ChangeRecoveryResolveRequest = {
      conversationId: 'new-task',
      items: [{ invocationId: 'old-operation', revision: 'revision-1' }],
      decision: 'waived',
    }
    expect(await f.state.resolve(decision)).toBe(true)
    expect(f.state.items.value).toEqual([additional])
    expect(f.state.waived.value).toBe(true)
    expect(vi.mocked(f.recovery.resolve).mock.calls[0]?.[0]).toEqual(decision)
  })

  it('retains protection and reports failure when the selected revision cannot be resolved', async () => {
    const f = setup()
    f.ready.value = true
    await vi.waitFor(() => expect(f.state.items.value).toHaveLength(1))
    vi.mocked(f.recovery.resolve).mockRejectedValue(new Error('stale revision'))
    expect(await f.state.resolve({ conversationId: 'new-task', items: [{ invocationId: 'old-operation', revision: 'revision-1' }], decision: 'waived' })).toBe(false)
    expect(f.state.items.value).toEqual([item()])
    expect(f.state.waived.value).toBe(false)
    expect(f.state.error.value).toBe('resolveFailed')
  })

  it('does not mark another task as waived when a pending decision completes after navigation', async () => {
    const f = setup()
    const pending = deferred<readonly LocalChangeRecoveryItem[]>()
    f.ready.value = true
    await vi.waitFor(() => expect(f.state.items.value).toHaveLength(1))
    vi.mocked(f.recovery.resolve).mockReturnValue(pending.promise)
    const resolution = f.state.resolve({ conversationId: 'new-task', items: [{ invocationId: 'old-operation', revision: 'revision-1' }], decision: 'waived' })
    f.conversationId.value = 'another-task'
    pending.resolve([])
    expect(await resolution).toBe(false)
    expect(f.state.waived.value).toBe(false)
    expect(f.state.busy.value).toBe(false)
  })
})

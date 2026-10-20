import { describe, expect, it } from 'vitest'
import { changeRecoveryItemSchema, changesRecoveryRpc } from '../changeApi'

describe('change recovery user decisions', () => {
  const selection = { conversationId: 'task', items: [{ invocationId: 'invocation', revision: 'revision-1' }], decision: 'waived' }

  it('requires a fixed, versioned, unique selection and rejects broad or unrecognized decisions', () => {
    expect(changesRecoveryRpc.resolve.input.parse(selection)).toEqual(selection)
    for (const invalid of [
      { ...selection, all: true },
      { ...selection, items: [] },
      { ...selection, items: [{ invocationId: 'invocation' }] },
      { ...selection, items: [{ invocationId: 'invocation', revision: '' }] },
      { ...selection, items: [selection.items[0], selection.items[0]] },
      { ...selection, decision: 'released' },
    ])
      expect(changesRecoveryRpc.resolve.input.safeParse(invalid).success).toBe(false)
  })

  it('rechecks only an explicit nonempty set and does not require user decisions to inspect', () => {
    expect(changesRecoveryRpc.list.input.parse({ conversationId: 'task' })).toEqual({ conversationId: 'task' })
    expect(changesRecoveryRpc.recheck.input.parse({ conversationId: 'task', invocationIds: ['first', 'second'] })).toEqual({ conversationId: 'task', invocationIds: ['first', 'second'] })
    for (const invocationIds of [[], ['first', 'first']])
      expect(changesRecoveryRpc.recheck.input.safeParse({ conversationId: 'task', invocationIds }).success).toBe(false)
  })

  it('preserves deleted-task provenance and rejects internal process details from the public projection', () => {
    const item = {
      invocationId: 'old-operation',
      runId: 'old-run',
      conversationId: null,
      taskTitle: '',
      occurredAt: '2026-10-15T00:00:00.000Z',
      affectedResources: ['/workspace/example'],
      reason: 'MUTATION_INTERRUPTED',
      status: 'unknown',
      revision: 'revision-1',
    }
    expect(changeRecoveryItemSchema.parse(item)).toEqual(item)
    expect(changeRecoveryItemSchema.safeParse({ ...item, pid: 1234 }).success).toBe(false)
  })
})

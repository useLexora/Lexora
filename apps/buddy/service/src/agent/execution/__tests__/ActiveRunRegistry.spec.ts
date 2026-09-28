import type { RunRecord } from '../../../storage/runRecord'
import type { BuddySessionIdentity } from '../../sessions/BuddySessionBlueprint'
import type { ExecutionSettled } from '../ActiveRunRegistry'
import { describe, expect, it } from 'vitest'
import { ActiveRunRegistry } from '../ActiveRunRegistry'

const identity: BuddySessionIdentity = {
  conversationId: 'conversation-1',
  branchId: 'branch-1',
  canonicalRoot: '/workspace',
  scratchRoot: '/scratch',
  approvalPolicy: 'policy',
  executionProfile: 'workspace_write',
  sessionMode: 'interactive',
  spaceId: null,
  grantRevision: 'grants-1',
  resourceRevision: 'resources-1',
}

describe('execution settlement', () => {
  it('releases the slot before publishing once and isolates observers from completion', async () => {
    const registry = new ActiveRunRegistry()
    const gate = Promise.withResolvers<RunRecord>()
    const received: ExecutionSettled[] = []
    registry.onDidSettle(() => {
      throw new Error('Observer unavailable')
    })
    registry.onDidSettle((event) => {
      expect(registry.hasActiveExecution(identity.conversationId)).toBe(false)
      received.push(event)
    })
    const handle = registry.start({ identity, runId: 'run-1', execute: () => gate.promise })
    expect(registry.hasActiveExecution(identity.conversationId)).toBe(true)
    expect(received).toEqual([])
    const record = { id: 'run-1', status: 'running' } as RunRecord
    gate.resolve(record)
    expect(await handle.completion).toBe(record)
    expect(received).toEqual([expect.objectContaining({ runId: 'run-1', cleanup: 'completed', stopping: false })])
    expect(received[0]!.executionId).toBeTruthy()
    await registry.dispose()
  })

  it('reports degraded release without manufacturing a durable terminal', async () => {
    const registry = new ActiveRunRegistry()
    const received: ExecutionSettled[] = []
    registry.onDidSettle(event => received.push(event))
    const failure = new Error('Cleanup failed')
    const handle = registry.start({ identity, runId: 'run-1', execute: async () => {
      throw failure
    } })
    await expect(handle.completion).rejects.toBe(failure)
    expect(registry.hasActiveExecution(identity.conversationId)).toBe(false)
    expect(received).toEqual([expect.objectContaining({ cleanup: 'degraded' })])
    expect(received[0]).not.toHaveProperty('status')
    await registry.dispose()
  })
})

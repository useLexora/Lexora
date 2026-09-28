import type { CredentialChange } from '../HostCredentialStore'
import type { ProviderCommit } from '../ProviderState'
import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../../../shared/events/Emitter'
import { BuddySessionRegistry } from '../../agent/sessions/BuddySessionRegistry'
import { ProviderDependents } from '../ProviderDependents'

function identity() {
  return { approvalPolicy: 'policy' as const, branchId: 'branch', canonicalRoot: '/workspace', conversationId: 'conversation', executionProfile: 'workspace_write' as const, grantRevision: 'grant', resourceRevision: 'resource', scratchRoot: '/scratch', sessionMode: 'interactive' as const, spaceId: null }
}
function source() {
  const commits = new Emitter<ProviderCommit>(() => {})
  const credentials = new Emitter<CredentialChange>(() => {})
  return { commits, onDidCommit: commits.event, onDidChangeCredential: credentials.event, snapshot: { revision: 0, catalogRevision: 0, models: [], providers: [], defaultModel: null } }
}
function commit(executionChanged: boolean): ProviderCommit {
  return { revision: 1, catalogRevision: 0, commitId: 'commit', reason: 'configuration', providers: [{ providerId: 'fixture', kind: 'changed', executionChanged, enabled: true }], models: [], defaultModelChanged: false, defaultModel: null }
}

describe('provider dependency reconciliation', () => {
  it('keeps consumers connected while a source drains a final accepted commit', async () => {
    const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void>, getModelUsage: () => { providerId: string, modelId: string } }>()
    const events = source()
    const gate = Promise.withResolvers<void>()
    let attempts = 0
    const sourceWithDrain = { ...events, quiesce: async () => {
      await gate.promise
      events.commits.fire(commit(true))
    } }
    const consumer = new ProviderDependents({ source: sourceWithDrain, sessions, automations: { blockPinnedModel: () => [] }, record: () => {}, resources: { reconcileInvalidation: async (input) => {
      if (++attempts === 1)
        throw new Error('one failed invalidation read')
      return sessions.invalidateMatching(input.matches, { sessionIds: input.sessionIds ?? [] })
    } } })
    await sessions.getOrCreate(identity(), null, async () => ({ piSessionFile: '/sessions/fixture', session: { shutdown: async () => {}, getModelUsage: () => ({ providerId: 'fixture', modelId: 'model' }) } }))
    const stopping = consumer.dispose()
    gate.resolve()
    await stopping
    expect(sessions.snapshot()).toEqual([])
    expect(consumer.snapshot.status).toBe('stopped')
    await sessions.dispose()
  })

  it('leaves presentation alone and keeps applied state pending until the active session really releases', async () => {
    const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void>, getModelUsage: () => { providerId: string, modelId: string } }>()
    const events = source()
    const consumer = new ProviderDependents({ source: events, sessions, automations: { blockPinnedModel: () => [] }, record: () => {}, resources: { reconcileInvalidation: input => sessions.invalidateMatching(input.matches, { sessionIds: input.sessionIds ?? [] }) } })
    await sessions.getOrCreate(identity(), null, async () => ({ piSessionFile: '/sessions/fixture', session: { shutdown: async () => {}, getModelUsage: () => ({ providerId: 'fixture', modelId: 'model' }) } }))
    events.commits.fire(commit(false))
    await consumer.whenIdle()
    expect(sessions.snapshot()).toHaveLength(1)
    const gate = Promise.withResolvers<void>()
    const running = sessions.withConversationRun(identity(), 'run', undefined, () => gate.promise)
    await vi.waitFor(() => expect(sessions.getActiveRun(identity())).not.toBeNull())
    events.commits.fire(commit(true))
    await consumer.whenIdle()
    expect(consumer.snapshot.status).toBe('pending')
    expect(sessions.snapshot()[0]?.invalidationPending).toBe(true)
    gate.resolve()
    await running
    expect(consumer.snapshot.status).toBe('ready')
    expect(sessions.snapshot()).toEqual([])
    await consumer.dispose()
    await sessions.dispose()
  })

  it('does not invalidate a replacement session with a delayed request for its predecessor', async () => {
    const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void>, getModelUsage: () => { providerId: string, modelId: string } }>()
    const events = source()
    const gate = Promise.withResolvers<void>()
    const consumer = new ProviderDependents({ source: events, sessions, automations: { blockPinnedModel: () => [] }, record: () => {}, resources: { reconcileInvalidation: async (input) => {
      await gate.promise
      return sessions.invalidateMatching(input.matches, { sessionIds: input.sessionIds ?? [] })
    } } })
    const create = () => sessions.getOrCreate(identity(), null, async () => ({ piSessionFile: '/sessions/fixture', session: { shutdown: async () => {}, getModelUsage: () => ({ providerId: 'fixture', modelId: 'model' }) } }))
    await create()
    const previous = sessions.snapshot()[0]!.id
    events.commits.fire(commit(true))
    await sessions.invalidateMatching(() => true)
    await create()
    const current = sessions.snapshot()[0]!.id
    expect(current).not.toBe(previous)
    gate.resolve()
    await consumer.whenIdle()
    expect(sessions.snapshot()[0]!.id).toBe(current)
    expect(consumer.snapshot.status).toBe('ready')
    await consumer.dispose()
    await sessions.dispose()
  })
})

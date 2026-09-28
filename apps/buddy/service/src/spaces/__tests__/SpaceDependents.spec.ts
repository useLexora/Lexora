import type { BuddySessionIdentity } from '../../agent/sessions/BuddySessionBlueprint'
import type { SpaceCommit } from '../SpaceService'
import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../../../shared/events/Emitter'
import { BuddySessionRegistry } from '../../agent/sessions/BuddySessionRegistry'
import { SpaceDependents } from '../SpaceDependents'

function identity(spaceId: string): BuddySessionIdentity {
  return { approvalPolicy: 'policy', branchId: 'branch', canonicalRoot: '/workspace', conversationId: `conversation-${spaceId}`, executionProfile: 'workspace_write', grantRevision: 'grant-1', resourceRevision: 'resource-1', scratchRoot: '/scratch', sessionMode: 'interactive', spaceId }
}

function fixture() {
  const changes = new Emitter<SpaceCommit>(() => {})
  const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void> }>()
  const blocks: string[] = []
  let blockFails = false
  const consumer = new SpaceDependents({
    source: { quiesce: async () => {}, onDidCommit: changes.event, list: () => [], revision: 1 },
    grants: { quiesce: async () => {}, onDidCommit: new Emitter<never>(() => {}).event },
    sessions,
    resources: {
      reconcileInvalidation: input => sessions.invalidateMatching(input.matches, { sessionIds: input.sessionIds ?? [] }),
      resync: async () => {},
      snapshot: () => [],
    },
    automations: { blockSpace: (id) => {
      if (blockFails)
        throw new Error('dependency unavailable')
      blocks.push(id)
      return []
    } },
    record: () => {},
  })
  return { consumer, sessions, blocks, failBlocks(value: boolean) {
    blockFails = value
  }, commit(facets: SpaceCommit['facets'], kind: SpaceCommit['kind'] = 'updated') {
    changes.fire({ sourceId: 'source', revision: 1, spaceId: 'a', kind, facets, directories: [], revokedDirectoryIds: [] })
  } }
}

describe('space dependency reactions', () => {
  it('ignores presentation changes and tracks deferred cleanup only for the affected Space', async () => {
    const f = fixture()
    const activeIdentity = identity('a')
    await f.sessions.getOrCreate(activeIdentity, null, async () => ({ piSessionFile: '/sessions/a', session: { shutdown: async () => {} } }))
    await f.sessions.getOrCreate(identity('b'), null, async () => ({ piSessionFile: '/sessions/b', session: { shutdown: async () => {} } }))
    const gate = Promise.withResolvers<void>()
    const running = f.sessions.withConversationRun(activeIdentity, 'run', undefined, () => gate.promise)
    await vi.waitFor(() => expect(f.sessions.getActiveRun(activeIdentity)).not.toBeNull())
    f.commit(['presentation'])
    await f.consumer.whenIdle()
    expect(f.sessions.snapshot().some(session => session.invalidationPending)).toBe(false)
    f.commit(['directories'])
    await f.consumer.whenIdle()
    expect(f.consumer.snapshot).toMatchObject({ status: 'pending' })
    expect(f.sessions.snapshot().find(session => session.identity.spaceId === 'b')?.invalidationPending).toBe(false)
    gate.resolve()
    await running
    expect(f.consumer.snapshot.status).toBe('ready')
    expect(f.sessions.getReady('conversation-b', 'branch')).not.toBeNull()
    await f.consumer.dispose()
    await f.sessions.dispose()
  })

  it('continues session invalidation after an automation reaction fails and retries only captured session identities', async () => {
    const f = fixture()
    await f.sessions.getOrCreate(identity('a'), null, async () => ({ piSessionFile: '/sessions/a', session: { shutdown: async () => {} } }))
    f.failBlocks(true)
    f.commit(['availability'], 'deleted')
    await f.consumer.whenIdle()
    expect(f.consumer.snapshot.status).toBe('degraded')
    expect(f.sessions.getReady('conversation-a', 'branch')).toBeNull()
    const replacement = { shutdown: async () => {} }
    await f.sessions.getOrCreate(identity('a'), null, async () => ({ piSessionFile: '/sessions/new', session: replacement }))
    f.failBlocks(false)
    f.consumer.resync()
    await f.consumer.whenIdle()
    expect(f.blocks).toEqual(['a'])
    expect(f.sessions.getReady('conversation-a', 'branch')).toBe(replacement)
    expect(f.consumer.snapshot.status).toBe('ready')
    await f.consumer.dispose()
    await f.sessions.dispose()
  })
})

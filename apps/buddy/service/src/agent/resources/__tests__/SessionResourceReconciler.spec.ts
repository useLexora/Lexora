import type { SkillEvent } from '../../../skills/skillEvents'
import type { BuddySkillResolution } from '../../../skills/SkillService'
import type { BuddySessionIdentity } from '../../sessions/BuddySessionBlueprint'
import type { SessionResourceChange } from '../SessionResourceReconciler'
import { describe, expect, it, vi } from 'vitest'
import { Emitter, filterEvent } from '../../../../../shared/events/Emitter'
import { BuddySessionRegistry } from '../../sessions/BuddySessionRegistry'
import { SessionResourceReconciler } from '../SessionResourceReconciler'

class Skills {
  quiesce = async () => {}
  readonly events = new Emitter<SkillEvent>(() => {})
  readonly onDidCommitInstallation = filterEvent(this.events.event, (event): event is Extract<SkillEvent, { type: 'installation' }> => event.type === 'installation')
  readonly onDidChangeResources = filterEvent(this.events.event, (event): event is Extract<SkillEvent, { type: 'resources' }> => event.type === 'resources')
  readonly resolutions = new Map<string | null, BuddySkillResolution>()
  sequence = 0
  loadForSpace = async (spaceId: string | null): Promise<BuddySkillResolution> => this.resolutions.get(spaceId)!
  resourceSnapshots() {
    return [...this.resolutions].map(([spaceId, resolution]) => ({ spaceId, resolution }))
  }

  accept(spaceId: string | null, revision: string) {
    const previousRevision = this.resolutions.get(spaceId)?.revision ?? null
    this.resolutions.set(spaceId, { revision, skills: [], references: [], paths: [], readRoots: [], diagnostics: [] })
    this.events.fire({ type: 'resources', sourceId: 'source', sequence: ++this.sequence, generation: this.sequence, spaceId, resourceRevision: revision, previousRevision, skillIds: [] })
  }

  commit(spaceId: string | null) {
    this.events.fire({ type: 'installation', sourceId: 'source', sequence: ++this.sequence, generation: this.sequence, spaceId, reason: 'enabled', installationIds: ['skill'], operationId: 'operation' })
  }
}

describe('sessionResourceReconciler', () => {
  it('distinguishes desired resources, deferred invalidation, actual cleanup and a newly applied session', async () => {
    const skills = new Skills()
    skills.accept('space-a', 'skills-1')
    skills.accept('space-b', 'skills-b')
    const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void> }>()
    const reconciler = new SessionResourceReconciler({ skills, sessions })
    const events: SessionResourceChange[] = []
    reconciler.onDidChange(event => events.push(event))
    const cleanup = Promise.withResolvers<void>()
    const firstIdentity = identity('space-a', 'skills-1')
    await sessions.getOrCreate(firstIdentity, null, async () => ({ piSessionFile: '/sessions/a', session: { shutdown: () => cleanup.promise } }))
    await sessions.getOrCreate(identity('space-b', 'skills-b'), null, async () => ({ piSessionFile: '/sessions/b', session: { shutdown: async () => {
      throw new Error('Other scope must stay active')
    } } }))
    await reconciler.whenIdle()
    const gate = Promise.withResolvers<void>()
    const run = sessions.withConversationRun(firstIdentity, 'run', undefined, () => gate.promise)
    await vi.waitFor(() => expect(sessions.getActiveRun(firstIdentity)?.runId).toBe('run'))
    skills.accept('space-a', 'skills-2')
    await reconciler.whenIdle()
    expect(reconciler.snapshot().find(scope => scope.spaceId === 'space-a')).toMatchObject({ skillRevision: 'skills-2', status: 'pending', pending: 1 })
    expect(sessions.snapshot().find(session => session.identity.spaceId === 'space-a')?.invalidationPending).toBe(true)
    expect(events.filter(event => event.type === 'applied').map(event => event.skillRevision)).toEqual(['skills-1', 'skills-b'])
    gate.resolve()
    await vi.waitFor(() => expect(sessions.snapshot().find(session => session.identity.spaceId === 'space-a')?.cleanup).toBe('pending'))
    expect(reconciler.snapshot().find(scope => scope.spaceId === 'space-a')?.status).toBe('pending')
    cleanup.resolve()
    await run
    expect(reconciler.snapshot().find(scope => scope.spaceId === 'space-a')?.status).toBe('current')
    expect(sessions.getReady('conversation-space-b', 'branch')).not.toBeNull()
    await sessions.getOrCreate(identity('space-a', 'skills-2'), null, async () => ({ piSessionFile: '/sessions/a', session: { shutdown: async () => {} } }))
    await reconciler.whenIdle()
    expect(events.at(-1)).toMatchObject({ type: 'applied', skillRevision: 'skills-2', resourceRevision: 'resource-skills-2' })
    await reconciler.dispose()
    await expect(sessions.dispose()).rejects.toThrow('Session shutdown failed')
  })

  it('retains a degraded scope after cleanup failure without claiming that a new resource revision was applied', async () => {
    const skills = new Skills()
    skills.accept(null, 'skills-1')
    const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void> }>()
    const reconciler = new SessionResourceReconciler({ skills, sessions })
    await sessions.getOrCreate(identity(null, 'skills-1'), null, async () => ({ piSessionFile: '/sessions/a', session: { shutdown: async () => {
      throw new Error('shutdown unavailable')
    } } }))
    const events: SessionResourceChange[] = []
    reconciler.onDidChange(event => events.push(event))
    skills.accept(null, 'skills-2')
    await reconciler.whenIdle()
    expect(reconciler.snapshot()[0]).toMatchObject({ status: 'degraded', pending: 0, degraded: 1 })
    expect(events.some(event => event.type === 'applied')).toBe(false)
    expect(await sessions.invalidateConversationWithResult('conversation-null')).toEqual({ matched: 1, pending: 0, degraded: 1 })
    await reconciler.dispose()
    await sessions.dispose()
  })

  it('drains and accepts pending discovery before removing source subscriptions', async () => {
    const skills = new Skills()
    skills.accept(null, 'skills-1')
    const sessions = new BuddySessionRegistry<{ shutdown: () => Promise<void> }>()
    const reconciler = new SessionResourceReconciler({ skills, sessions })
    await reconciler.whenIdle()
    const entered = Promise.withResolvers<void>()
    const resolution = Promise.withResolvers<BuddySkillResolution>()
    let loads = 0
    skills.loadForSpace = () => {
      loads++
      entered.resolve()
      return resolution.promise
    }
    const events: SessionResourceChange[] = []
    reconciler.onDidChange(event => events.push(event))
    skills.commit(null)
    await entered.promise
    const disposed = reconciler.dispose()
    resolution.resolve({ revision: 'late', skills: [], references: [], paths: [], readRoots: [], diagnostics: [] })
    await disposed
    skills.commit(null)
    skills.accept(null, 'later')
    expect(events.some(event => event.type === 'desired' && event.scope.skillRevision === 'late')).toBe(true)
    expect(loads).toBe(1)
    expect(reconciler.snapshot()[0]?.skillRevision).toBe('late')
    await sessions.dispose()
  })
})

function identity(spaceId: string | null, skillRevision: string): BuddySessionIdentity {
  return { approvalPolicy: 'policy', branchId: 'branch', canonicalRoot: '/workspace', conversationId: `conversation-${spaceId}`, executionProfile: 'workspace_write', grantRevision: 'grant-1', resourceRevision: `resource-${skillRevision}`, skillRevision, scratchRoot: '/scratch', sessionMode: 'interactive', spaceId }
}

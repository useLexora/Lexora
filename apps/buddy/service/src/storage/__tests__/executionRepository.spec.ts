import { afterEach, describe, expect, it } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { hashChildAdmissionRequest } from '../executionRepository'
import { createTaskMarkRepository } from '../taskMarkRepository'
import { createExecutionStorageFixture, executionNow } from './executionFixture'

const fixtures: ReturnType<typeof createExecutionStorageFixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.database.close()))
function fixture() {
  const f = createExecutionStorageFixture()
  fixtures.push(f)
  return f
}

function rehash<T extends Parameters<typeof hashChildAdmissionRequest>[0]>(input: T) {
  return { ...input, requestHash: hashChildAdmissionRequest(input) }
}

describe('execution admission and fences', () => {
  it('accepts one durable queued child per request and retains the accepted snapshot after definition changes', () => {
    const f = fixture()
    const request = f.child('npc-1')
    const first = f.executions.admitChild(request)
    expect(first).toMatchObject({ created: true, execution: { phase: 'queued', run: { rootRunId: 'root', parentRunId: 'root', executionKind: 'npc_child', status: 'queued', actorSnapshot: request.run.actorSnapshot } } })
    expect(f.database.prepare('SELECT prompt FROM run_inputs WHERE run_id = ?').get('npc-1')?.prompt).toBe(request.initialInput.prompt)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0)
    const npc = f.buddies.get(f.npc.id)
    f.buddies.update({ buddyId: npc.id, expectedRevision: npc.revision, settings: buddySettingsSchema.parse({ ...npc.settings, instructions: 'Changed later' }) })
    expect(f.executions.admitChild({ ...request, run: { ...request.run, id: 'duplicate' } })).toMatchObject({ created: false, execution: { run: { id: 'npc-1' } } })
    expect(f.runs.findById('duplicate')).toBeNull()
    expect(f.runs.findById('npc-1')?.actorSnapshot?.settings.instructions).toBe(request.run.actorSnapshot.settings.instructions)
    expect(() => f.executions.admitChild(rehash({ ...request, initialInput: { ...request.initialInput, prompt: 'Conflicting goal' } }))).toThrow(expect.objectContaining({ code: 'conflict' }))
  })

  it.each(['cancel', 'close', 'branch', 'definition'] as const)('rejects stale %s admission without creating a child or thread', (change) => {
    const f = fixture()
    const request = f.child('rejected')
    const before = f.database.prepare('SELECT COUNT(*) AS count FROM execution_threads').get()?.count
    if (change === 'cancel')
      f.executions.requestCancel('root', executionNow)
    if (change === 'close')
      f.executions.beginClosing(f.fence('root'), 'success')
    if (change === 'branch')
      f.database.prepare('UPDATE conversations SET active_branch_id = ? WHERE id = ?').run('other', 'conversation')
    if (change === 'definition')
      f.buddies.update({ buddyId: f.npc.id, expectedRevision: f.npc.revision, enabled: false })
    expect(() => f.executions.admitChild(request)).toThrow()
    expect(f.runs.findById('rejected')).toBeNull()
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM execution_threads').get()?.count).toBe(before)
  })

  it('keeps ordinary active/timeline/unread queries on roots while recovery sees every child', () => {
    const f = fixture()
    f.executions.admitChild(f.child('private-child'))
    f.runs.reconcileTerminal('private-child', 'completed', executionNow, null)
    expect(f.runs.findActiveForConversation('conversation')?.id).toBe('root')
    expect(f.runs.listForConversation('conversation').map(run => run.id)).toEqual(['root'])
    expect(f.runs.listForTimeline('conversation', 'branch', [], ['root', 'private-child']).map(run => run.id)).toEqual(['root'])
    expect(f.runs.listTree('root').map(run => run.id).sort()).toEqual(['private-child', 'root'])
    expect(createTaskMarkRepository(f.database).getState('conversation')).toMatchObject({ resultRunId: null, unread: false })
    f.executions.admitChild(f.child('queued-child'))
    expect(f.runs.listIncomplete().map(run => run.id)).toContain('queued-child')
  })

  it('counts only working NPCs against the captured cap and releases waiting permits without invalidating descendants', () => {
    const f = fixture()
    for (let index = 1; index <= 6; index++)
      f.executions.admitChild(f.child(`npc-${index}`))
    for (let index = 1; index <= 5; index++)
      f.executions.claimWorking(f.fence(`npc-${index}`))
    expect(f.runs.findById('npc-1')?.status).toBe('queued')
    expect(() => f.executions.claimWorking(f.fence('npc-6'))).toThrow(expect.objectContaining({ code: 'busy' }))
    f.executions.markWaiting(f.fence('root'))
    f.executions.markWaiting(f.fence('npc-1'))
    expect(f.executions.claimWorking(f.fence('npc-6')).phase).toBe('working')
    expect(() => f.executions.claimWorking(f.fence('npc-1'))).toThrow(expect.objectContaining({ code: 'busy' }))
  })

  it('applies an ancestor actor lower cap and leaves actor calls outside NPC accounting', () => {
    const f = fixture()
    const actor = f.buddies.get(f.actor.id)
    f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: buddySettingsSchema.parse({ ...actor.settings, npcConcurrency: { mode: 'limited', limit: 1 } }) })
    f.executions.admitChild(f.child('actor-child', actor.id))
    f.executions.claimWorking(f.fence('actor-child'))
    f.executions.admitChild(f.child('actor-npc-1', f.npc.id, 'actor-child'))
    f.executions.admitChild(f.child('actor-npc-2', f.npc.id, 'actor-child'))
    f.executions.claimWorking(f.fence('actor-npc-1'))
    expect(() => f.executions.claimWorking(f.fence('actor-npc-2'))).toThrow(expect.objectContaining({ code: 'busy' }))
    f.executions.markWaiting(f.fence('actor-child'))
    f.executions.markWaiting(f.fence('actor-npc-1'))
    expect(f.executions.claimWorking(f.fence('actor-npc-2')).phase).toBe('working')
  })

  it('permits unlimited NPC work and rejects actor thread reentry before creating deadlocked children', () => {
    const f = fixture()
    const root = f.buddies.get('default')
    f.buddies.update({ buddyId: root.id, expectedRevision: root.revision, settings: buddySettingsSchema.parse({ ...root.settings, npcConcurrency: { mode: 'unlimited' } }) })
    f.database.prepare('UPDATE runs SET actor_snapshot_json = ? WHERE id = ?').run(JSON.stringify(f.snapshot('default')), 'root')
    for (let index = 0; index < 8; index++) {
      f.executions.admitChild(f.child(`unlimited-${index}`))
      expect(f.executions.claimWorking(f.fence(`unlimited-${index}`)).phase).toBe('working')
    }
    f.executions.admitChild(f.child('actor-child', f.actor.id))
    expect(() => f.executions.admitChild(f.child('duplicate-actor', f.actor.id))).toThrow(expect.objectContaining({ code: 'busy' }))
    expect(() => f.executions.admitChild(f.child('ancestor-actor', 'default'))).toThrow(expect.objectContaining({ code: 'busy' }))
    expect(f.runs.findById('duplicate-actor')).toBeNull()
  })

  it('requires explicit task membership for new actor work and preserves accepted work after removal', () => {
    const f = fixture()
    const outsider = f.buddies.create({ name: 'Not yet added' })
    const request = f.child('outsider', outsider.id)
    expect(() => f.executions.admitChild(request)).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    expect(f.runs.findById('outsider')).toBeNull()
    f.conversations.addMember({ id: 'conversation', buddyId: outsider.id, updatedAt: executionNow })
    f.executions.admitChild(request)
    f.conversations.removeMember({ id: 'conversation', buddyId: outsider.id, updatedAt: executionNow })
    expect(f.executions.admitChild(request).created).toBe(false)
    expect(f.executions.claimWorking(f.fence('outsider')).phase).toBe('working')
    expect(() => f.executions.admitChild(f.child('new-call', outsider.id))).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    expect(f.runs.findById('new-call')).toBeNull()
    expect(f.conversations.listMembers('conversation').some(member => member.actorId === outsider.id)).toBe(false)
  })

  it('checks live captured authorization rather than treating initial execution profile as a permanent ceiling', () => {
    const f = fixture()
    f.database.prepare('UPDATE runs SET execution_profile = ? WHERE id = ?').run('read_only', 'root')
    const elevated = f.child('elevated')
    elevated.authorization.executionProfile = 'full_access'
    elevated.run.executionProfile = 'full_access'
    expect(f.executions.admitChild(rehash(elevated)).created).toBe(true)
    f.executions.setFileAccessCeiling('root')
    expect(() => f.executions.admitChild(rehash(f.child('blocked')))).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    const readonly = f.child('readonly')
    readonly.run.executionProfile = 'read_only'
    expect(f.executions.admitChild(rehash(readonly)).execution.fileAccessCeiling).toBe('read_only')
  })

  it('seals only its own generation and cancels pending preparation before it can take a working permit', () => {
    const f = fixture()
    f.executions.admitChild(f.child('child'))
    const before = f.fence('child')
    f.executions.beginPreparing(before)
    const prepared = f.fence('child')
    const cancelled = f.executions.requestCancel('root', executionNow)
    expect(cancelled.find(record => record.run.id === 'root')?.run.generation).toBe(1)
    expect(f.runs.findById('child')?.generation).toBe(0)
    expect(() => f.executions.claimWorking(prepared)).toThrow(expect.objectContaining({ code: 'stale' }))
    expect(f.executions.find('child')?.cancelRequestedAt).toBe(executionNow)
    f.executions.beginClosing(f.fence('child'), 'cancel')
    expect(f.runs.findById('child')?.generation).toBe(1)
    expect(f.runs.findById('root')?.generation).toBe(1)
  })

  it('keeps degraded cleanup per execution when a sibling reports successful cleanup', () => {
    const f = fixture()
    f.executions.admitChild(f.child('bad'))
    f.executions.admitChild(f.child('good'))
    for (const id of ['bad', 'good'])
      f.runs.reconcileTerminal(id, 'cancelled', executionNow, null)
    f.executions.recordCleanup('bad', 'degraded', 'PROCESS_STOP_FAILED')
    f.executions.recordCleanup('good', 'clean', null)
    expect(f.executions.listUnfinishedTree('root').map(record => record.run.id)).toContain('bad')
    expect(f.executions.find('bad')).toMatchObject({ cleanupState: 'degraded', cleanupErrorCode: 'PROCESS_STOP_FAILED' })
  })
})

import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { createComposerDraftRepository } from '../composerDraftRepository'
import { openBuddyMigrationCandidate } from '../database'
import { createDraftOwnershipRepository } from '../draftOwnershipRepository'

const databases: DatabaseSync[] = []
const now = '2026-11-07T00:00:00.000Z'
afterEach(() => {
  for (const db of databases.splice(0))
    db.close()
})
function fixture() {
  const db = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  databases.push(db)
  db.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  db.prepare('INSERT INTO storage_actors VALUES (\'device-1\', \'device\', \'active\', ?)').run(now)
  return { db, local: createComposerDraftRepository(db), device: createComposerDraftRepository(db, 'device-1'), slots: createDraftOwnershipRepository(db, 'desktop-local') }
}
const openInput = (draftId: string) => ({ draftId, scope: { kind: 'global' as const }, initialContent: createBuddyUserContent(draftId), initialModelSelection: null, initialExecutionConfig: { approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const }, now })

describe('owned drafts and independent current slots', () => {
  it('opens one current draft per trusted actor and prevents other actors from mutating it', () => {
    const f = fixture()
    const own = f.local.open(openInput('desktop-draft'))
    const remote = f.device.open(openInput('device-draft'))
    expect(f.local.findByScope({ kind: 'global' })).toEqual(own)
    expect(f.device.findByScope({ kind: 'global' })).toEqual(remote)
    expect(f.local.findById(remote.draftId)).toBeNull()
    expect(f.device.findById(own.draftId)).toBeNull()
    expect(f.local.list().map(d => d.draftId)).toEqual(['desktop-draft'])
    expect(() => f.device.discard({ draftId: own.draftId, expectedRevision: 0 })).toThrow()
    expect(() => f.device.save({ draftId: own.draftId, expectedRevision: 0, content: createBuddyUserContent('replacement'), modelSelection: null, executionConfig: own.executionConfig, now })).toThrow()
    expect(f.local.findById(own.draftId)).toEqual(own)
    expect(() => f.db.exec('UPDATE composer_drafts SET owner_actor_id = \'device-1\' WHERE id = \'desktop-draft\'')).toThrow('IMMUTABLE')
    f.db.exec('UPDATE storage_actors SET state = \'revoked\' WHERE id = \'device-1\'')
    expect(() => f.device.open(openInput('another-device-draft'))).toThrow('OWNER_UNAVAILABLE')
  })

  it('retains detached drafts and uses slot revision rather than draft revision to select the current draft', () => {
    const f = fixture()
    const first = f.local.open(openInput('first'))
    const initial = f.slots.findSlot(first.scope)!
    const detached = f.slots.select(first.scope, null, initial.slotRevision)
    expect(f.local.findByScope(first.scope)).toBeNull()
    expect(f.local.findById(first.draftId)).toEqual({ ...first, slotRevision: detached.slotRevision })
    const second = f.local.open(openInput('second'))
    expect(f.slots.findSlot(first.scope)?.slotRevision).toBe(detached.slotRevision + 1)
    expect(() => f.slots.select(first.scope, first.draftId, detached.slotRevision)).toThrow('REVISION_CONFLICT')
    const slot = f.slots.findSlot(first.scope)!
    const selected = f.slots.select(first.scope, first.draftId, slot.slotRevision)
    expect(f.local.findByScope(first.scope)).toEqual({ ...first, slotRevision: selected.slotRevision })
    expect(f.local.findById(second.draftId)).toEqual({ ...second, slotRevision: selected.slotRevision })
    expect(f.local.list()).toHaveLength(2)
  })
})

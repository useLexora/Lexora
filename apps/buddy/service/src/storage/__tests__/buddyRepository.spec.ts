import type { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { buddyCatalogSchema } from '../../../../shared/buddies/buddyApi'
import { buddySettingsSchema, DEFAULT_BUDDY_SETTINGS } from '../../../../shared/buddies/buddySettings'
import { createBuddyRepository } from '../buddyRepository'
import { openBuddyDatabase } from '../database'

let database: DatabaseSync | undefined
afterEach(() => {
  database?.close()
  database = undefined
})

it('reads equivalent UTC timestamps without rewriting history or bypassing deletion and configuration validation', () => {
  database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createBuddyRepository(database)
  const npc = repository.create({ name: 'Explorer', kind: 'npc' })
  const stored = '2026-10-12T09:32:40.123456+00:00'
  const canonical = '2026-10-12T09:32:40.123456Z'
  database.prepare('UPDATE buddies SET created_at = ?, updated_at = ? WHERE id = ?').run(stored, stored, npc.id)
  expect(repository.get(npc.id)).toMatchObject({ createdAt: canonical, updatedAt: canonical, deletedAt: null, revision: npc.revision, settings: npc.settings })
  expect(buddyCatalogSchema.parse(repository.list()).buddies.find(buddy => buddy.id === npc.id)?.updatedAt).toBe(canonical)
  const actor = repository.get('default')
  expect(repository.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: { ...buddySettingsSchema.parse(actor.settings), npcIds: [npc.id] } }).settings.npcIds).toEqual([npc.id])
  expect(database.prepare('SELECT created_at, updated_at FROM buddies WHERE id = ?').get(npc.id)).toEqual({ created_at: stored, updated_at: stored })

  database.prepare('UPDATE buddies SET deleted_at = ? WHERE id = ?').run(stored, npc.id)
  expect(repository.get(npc.id).deletedAt).toBe(canonical)
  expect(() => repository.update({ buddyId: npc.id, expectedRevision: npc.revision, name: 'Changed' })).toThrow(expect.objectContaining({ code: 'BUDDY_DELETED' }))
  database.prepare('UPDATE buddies SET updated_at = ? WHERE id = ?').run('not-a-date+00:00', npc.id)
  expect(() => repository.get(npc.id)).toThrow()
  database.prepare('UPDATE buddies SET updated_at = ?, settings_json = ? WHERE id = ?').run(stored, JSON.stringify({ ...npc.settings, limits: { fileAccess: 'unsupported' } }), npc.id)
  expect(() => repository.get(npc.id)).toThrow()
})

it('protects default eligibility, NPC bindings and deleted definition history', () => {
  database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createBuddyRepository(database)
  const actor = repository.create({ name: 'Coordinator' })
  let npc = repository.create({ name: 'Explorer', kind: 'npc' })
  expect(npc).toMatchObject({ kind: 'npc', enabled: true, settings: { tools: { mode: 'none' } } })
  expect(() => repository.setDefault({ buddyId: npc.id, expectedCatalogRevision: repository.state().revision })).toThrow(expect.objectContaining({ code: 'BUDDY_NOT_ACTOR' }))
  expect(() => repository.update({ buddyId: 'default', expectedRevision: repository.get('default').revision, enabled: false })).toThrow(expect.objectContaining({ code: 'BUDDY_DEFAULT_PROTECTED' }))
  const disabled = repository.update({ buddyId: actor.id, expectedRevision: actor.revision, enabled: false })
  expect(() => repository.setDefault({ buddyId: actor.id, expectedCatalogRevision: repository.state().revision })).toThrow(expect.objectContaining({ code: 'BUDDY_DISABLED' }))
  expect(() => repository.update({ buddyId: npc.id, expectedRevision: npc.revision, settings: { ...DEFAULT_BUDDY_SETTINGS, npcIds: [npc.id] } })).toThrow(expect.objectContaining({ code: 'BUDDY_INVALID_NPC_BINDING' }))
  expect(() => repository.update({ buddyId: actor.id, expectedRevision: disabled.revision, settings: { ...DEFAULT_BUDDY_SETTINGS, npcIds: [actor.id] } })).toThrow(expect.objectContaining({ code: 'BUDDY_INVALID_NPC_BINDING' }))
  const bound = repository.update({ buddyId: actor.id, expectedRevision: disabled.revision, settings: { ...DEFAULT_BUDDY_SETTINGS, npcIds: [npc.id, npc.id] } })
  expect(bound.settings.npcIds).toEqual([npc.id])
  npc = repository.delete({ buddyId: npc.id, expectedRevision: npc.revision })
  expect(repository.get(npc.id)).toEqual(npc)
  expect(repository.get(actor.id).settings.npcIds).toEqual([npc.id])
  expect(() => repository.update({ buddyId: actor.id, expectedRevision: bound.revision, settings: { ...buddySettingsSchema.parse(bound.settings), npcIds: [npc.id] } })).toThrow(expect.objectContaining({ code: 'BUDDY_INVALID_NPC_BINDING' }))
  expect(repository.update({ buddyId: actor.id, expectedRevision: bound.revision, settings: { ...DEFAULT_BUDDY_SETTINGS, npcIds: [] } }).settings.npcIds).toEqual([])
})

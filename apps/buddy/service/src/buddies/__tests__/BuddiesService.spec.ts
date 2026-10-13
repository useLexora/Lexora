import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_BUDDY_ID } from '../../../../shared/buddies/buddyApi'
import { buddySettingsSchema, DEFAULT_BUDDY_SETTINGS } from '../../../../shared/buddies/buddySettings'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { openBuddyDatabase } from '../../storage/database'
import { BuddiesService } from '../BuddiesService'

let database: DatabaseSync
let service: BuddiesService
let initialCatalog: ReturnType<BuddiesService['list']>

function setup() {
  database = openBuddyDatabase({ databasePath: ':memory:' })
  service = new BuddiesService(createBuddyRepository(database))
  initialCatalog = service.list()
  return service.get(BUILTIN_BUDDY_ID)
}

afterEach(() => {
  service?.dispose()
  database?.close()
})

describe('companion profiles', () => {
  it('preserves preset identities and rejects unknown presets and invalid gallery images', async () => {
    const initial = setup()
    const updated = await service.update({ buddyId: initial.id, expectedRevision: initial.revision, avatar: 'preset:actor-classic', customAvatars: [] })
    expect(service.get(initial.id)).toMatchObject({ avatar: 'preset:actor-classic', customAvatars: [] })
    for (const patch of [{ avatar: 'preset:unknown' }, { customAvatars: ['https://example.com/avatar.png'] }, { customAvatars: ['data:image/png;base64,AAAA'] }])
      await expect(service.update({ buddyId: initial.id, expectedRevision: updated.revision, ...patch })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(service.get(initial.id)).toEqual(updated)
  })

  it('persists preferences independently of basic-profile restoration and rejects stale or malformed settings', async () => {
    const initial = setup()
    const settings = buddySettingsSchema.parse({ ...DEFAULT_BUDDY_SETTINGS, instructions: 'Prefer concise answers', model: { providerId: 'fixture', modelId: 'unavailable-model', reasoning: 'high', serviceTier: null }, tools: { mode: 'none' } })
    const updated = await service.update({ buddyId: initial.id, expectedRevision: initial.revision, settings, name: 'Custom' })
    expect(updated.settings).toEqual(settings)
    expect(service.resetProfile({ buddyId: initial.id, expectedRevision: updated.revision }).settings).toEqual(settings)
    const current = service.get(initial.id)
    await expect(service.update({ buddyId: initial.id, expectedRevision: current.revision, settings: { ...settings, tools: { mode: 'selected', ids: ['[\"builtin\",\"core\",\"read\"]', '[\"builtin\",\"core\",\"read\"]'] } } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    service.dispose()
    service = new BuddiesService(createBuddyRepository(database))
    expect(service.get(initial.id).settings).toEqual(settings)
    expect(service.list().buddies.find(buddy => buddy.id === initial.id)?.settings).toEqual(settings)
    const other = await service.create({ name: 'Other' })
    expect(other.settings).toEqual(DEFAULT_BUDDY_SETTINGS)
    const selected = await service.update({ buddyId: other.id, expectedRevision: other.revision, settings })
    service.delete({ buddyId: other.id, expectedRevision: selected.revision })
    expect(service.get(other.id).settings).toEqual(settings)
  })

  it('preserves the identity and profile when the service is recreated', async () => {
    const initial = setup()
    const updated = await service.update({ buddyId: initial.id, expectedRevision: initial.revision, name: '小海' })
    service.dispose()
    service = new BuddiesService(createBuddyRepository(database))
    expect(service.list()).toEqual({ buddies: initialCatalog.buddies.map(buddy => buddy.id === initial.id ? updated : buddy), defaultBuddyId: BUILTIN_BUDDY_ID, revision: initialCatalog.revision + 1 })
    expect(updated).toMatchObject({ id: initial.id, name: '小海', revision: initial.revision + 1, avatar: null })
  })

  it('rejects stale updates and only publishes committed changes', async () => {
    const initial = setup()
    const changes: unknown[] = []
    service.onDidChange(event => changes.push(event))
    await service.update({ buddyId: initial.id, expectedRevision: initial.revision, name: 'Changed in chat' })
    await expect(service.update({ buddyId: initial.id, expectedRevision: initial.revision, name: 'Stale editor' })).rejects.toMatchObject({ code: 'BUDDY_CONFLICT' })
    expect(service.get(initial.id).name).toBe('Changed in chat')
    await service.update({ buddyId: initial.id, expectedRevision: initial.revision + 1, name: 'Changed in chat' })
    expect(changes).toEqual([{ buddyId: initial.id, catalogRevision: initialCatalog.revision + 1 }])
  })

  it('keeps built-in identity, default selection and profile restoration independent', async () => {
    const initial = setup()
    const second = await service.create({ name: 'Lexora', description: 'Another companion' })
    expect(second.id).not.toBe(initial.id)
    expect(service.list().buddies).toHaveLength(initialCatalog.buddies.length + 1)
    expect(() => service.delete({ buddyId: initial.id, expectedRevision: initial.revision })).toThrow(expect.objectContaining({ code: 'BUDDY_BUILTIN_PROTECTED' }))
    const selected = service.setDefault({ buddyId: second.id, expectedCatalogRevision: service.list().revision })
    expect(selected.defaultBuddyId).toBe(second.id)
    expect(service.get(second.id).revision).toBe(1)
    expect(() => service.delete({ buddyId: second.id, expectedRevision: 1 })).toThrow(expect.objectContaining({ code: 'BUDDY_DEFAULT_PROTECTED' }))
    expect(() => service.resetProfile({ buddyId: second.id, expectedRevision: 1 })).toThrow(expect.objectContaining({ code: 'BUDDY_RESET_UNAVAILABLE' }))
    const updated = await service.update({ buddyId: initial.id, expectedRevision: initial.revision, name: 'Custom', description: 'Custom introduction' })
    expect(() => service.setDefault({ buddyId: initial.id, expectedCatalogRevision: selected.revision })).toThrow(expect.objectContaining({ code: 'BUDDY_CONFLICT' }))
    const restored = service.resetProfile({ buddyId: initial.id, expectedRevision: updated.revision })
    expect(restored).toMatchObject({ id: 'default', name: 'Lexora', avatar: null, description: '', revision: initial.revision + 2 })
    expect(service.list().defaultBuddyId).toBe(second.id)
    const before = service.list().revision
    service.setDefault({ buddyId: second.id, expectedCatalogRevision: before })
    service.resetProfile({ buddyId: initial.id, expectedRevision: restored.revision })
    expect(service.list().revision).toBe(before)
  })

  it('removes companions from selection while retaining readable profiles across restart', async () => {
    setup()
    const second = await service.create({ name: 'Writer', description: 'Retained introduction' })
    const updated = await service.update({ buddyId: second.id, expectedRevision: 1, name: 'Changed' })
    expect(() => service.delete({ buddyId: second.id, expectedRevision: 1 })).toThrow(expect.objectContaining({ code: 'BUDDY_CONFLICT' }))
    const deleted = service.delete({ buddyId: second.id, expectedRevision: updated.revision })
    expect(deleted).toMatchObject({ name: 'Changed', description: 'Retained introduction', deletedAt: expect.any(String), revision: 3 })
    expect(service.list().buddies).toEqual(initialCatalog.buddies)
    await expect(service.update({ buddyId: second.id, expectedRevision: 3, name: 'Revived' })).rejects.toMatchObject({ code: 'BUDDY_DELETED' })
    expect(() => service.setDefault({ buddyId: second.id, expectedCatalogRevision: service.list().revision })).toThrow(expect.objectContaining({ code: 'BUDDY_DELETED' }))
    service.dispose()
    service = new BuddiesService(createBuddyRepository(database))
    expect(service.get(second.id)).toEqual(deleted)
    expect(service.list().defaultBuddyId).toBe('default')
    expect(service.list().buddies).toEqual(initialCatalog.buddies)
    await expect(service.update({ buddyId: 'missing', expectedRevision: 1, name: 'Lost' })).rejects.toMatchObject({ code: 'BUDDY_NOT_FOUND' })
  })

  it('rejects invalid mutations, external avatar URLs, and writes after shutdown', async () => {
    const initial = setup()
    for (const patch of [{}, { name: '  ' }, { avatar: 'https://example.com/avatar.png' }, { avatar: 'data:image/svg+xml;base64,AAAA' }]) {
      await expect(service.update({ buddyId: initial.id, expectedRevision: initial.revision, ...patch })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    const controller = new AbortController()
    controller.abort()
    await expect(service.update({ buddyId: initial.id, expectedRevision: initial.revision, name: 'Cancelled' }, controller.signal)).rejects.toThrow()
    service.dispose()
    await expect(service.update({ buddyId: initial.id, expectedRevision: initial.revision, name: 'Stopped' })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(service.get(initial.id)).toEqual(initial)
  })
})

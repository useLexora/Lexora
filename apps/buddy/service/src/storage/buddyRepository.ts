import type { DatabaseSync } from 'node:sqlite'
import type { BuddyCatalog, BuddyCreate, BuddyDefaultUpdate, BuddyMutation, BuddyUpdate, LocalBuddy } from '../../../shared/buddies/buddyApi'
import { randomUUID } from 'node:crypto'
import { buddySchema, BUILTIN_BUDDY_ID } from '../../../shared/buddies/buddyApi'
import { buddySettingsSchema, DEFAULT_BUDDY_SETTINGS } from '../../../shared/buddies/buddySettings'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { withTransaction } from './database'

export function createBuddyRepository(database: DatabaseSync) {
  const select = 'SELECT id, kind, enabled, name, avatar, description, settings_json, deleted_at AS deletedAt, revision, created_at AS createdAt, updated_at AS updatedAt FROM buddies'

  function get(id: string): LocalBuddy {
    const row = database.prepare(`${select} WHERE id = ?`).get(id)
    if (!row)
      throw new BuddyServiceError('BUDDY_NOT_FOUND')
    return toBuddy(row)
  }

  function state() {
    return database.prepare('SELECT default_buddy_id AS defaultBuddyId, revision FROM buddy_catalog WHERE id = 1').get() as { defaultBuddyId: string, revision: number }
  }

  function list(): BuddyCatalog {
    return { ...state(), buddies: database.prepare(`${select} WHERE deleted_at IS NULL ORDER BY created_at, id`).all().map(toBuddy) }
  }

  function active(id: string) {
    const buddy = get(id)
    if (buddy.deletedAt)
      throw new BuddyServiceError('BUDDY_DELETED')
    return buddy
  }

  function writable(input: BuddyMutation) {
    const buddy = active(input.buddyId)
    if (buddy.revision !== input.expectedRevision)
      throw new BuddyServiceError('BUDDY_CONFLICT')
    return buddy
  }

  function changed() {
    database.prepare('UPDATE buddy_catalog SET revision = revision + 1 WHERE id = 1').run()
  }

  function updateProfile(input: BuddyUpdate): LocalBuddy {
    const current = writable(input)
    const name = input.name ?? current.name
    const avatar = input.avatar === undefined ? current.avatar : input.avatar
    const description = input.description ?? current.description
    const enabled = input.enabled ?? current.enabled
    if (!enabled && state().defaultBuddyId === current.id)
      throw new BuddyServiceError('BUDDY_DEFAULT_PROTECTED')
    const parsedSettings = buddySettingsSchema.parse(input.settings ?? current.settings)
    const npcIds = [...new Set(parsedSettings.npcIds)]
    if (current.kind === 'npc' && npcIds.length)
      throw new BuddyServiceError('BUDDY_INVALID_NPC_BINDING')
    if (input.settings) {
      for (const id of npcIds) {
        const npc = get(id)
        if (id === current.id || npc.kind !== 'npc' || !npc.enabled || npc.deletedAt)
          throw new BuddyServiceError('BUDDY_INVALID_NPC_BINDING')
      }
    }
    const settings = JSON.stringify({ ...parsedSettings, npcIds })
    if (enabled === current.enabled && name === current.name && avatar === current.avatar && description === current.description && settings === JSON.stringify(current.settings))
      return current
    database.prepare('UPDATE buddies SET name = ?, avatar = ?, description = ?, settings_json = ?, enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(name, avatar, description, settings, Number(enabled), new Date().toISOString(), current.id)
    changed()
    return get(current.id)
  }

  return {
    get,
    state,
    list,
    create(input: BuddyCreate): LocalBuddy {
      return withTransaction(database, () => {
        const id = randomUUID()
        const now = new Date().toISOString()
        const kind = input.kind ?? 'actor'
        const settings = { ...DEFAULT_BUDDY_SETTINGS, tools: { mode: kind === 'npc' ? 'none' : 'all' } }
        database.prepare('INSERT INTO buddies (id, kind, name, avatar, description, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, kind, input.name, input.avatar ?? null, input.description ?? '', JSON.stringify(settings), now, now)
        changed()
        return get(id)
      })
    },
    update: (input: BuddyUpdate) => withTransaction(database, () => updateProfile(input)),
    resetProfile(input: BuddyMutation): LocalBuddy {
      return withTransaction(database, () => {
        writable(input)
        if (input.buddyId !== BUILTIN_BUDDY_ID)
          throw new BuddyServiceError('BUDDY_RESET_UNAVAILABLE')
        return updateProfile({ ...input, name: 'Lexora', avatar: null, description: '' })
      })
    },
    delete(input: BuddyMutation): LocalBuddy {
      return withTransaction(database, () => {
        const current = writable(input)
        if (current.id === BUILTIN_BUDDY_ID)
          throw new BuddyServiceError('BUDDY_BUILTIN_PROTECTED')
        if (state().defaultBuddyId === current.id)
          throw new BuddyServiceError('BUDDY_DEFAULT_PROTECTED')
        const now = new Date().toISOString()
        database.prepare('UPDATE buddies SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now, now, current.id)
        changed()
        return get(current.id)
      })
    },
    setDefault(input: BuddyDefaultUpdate): BuddyCatalog {
      return withTransaction(database, () => {
        const buddy = active(input.buddyId)
        if (buddy.kind !== 'actor')
          throw new BuddyServiceError('BUDDY_NOT_ACTOR')
        if (!buddy.enabled)
          throw new BuddyServiceError('BUDDY_DISABLED')
        const current = state()
        if (input.expectedCatalogRevision !== current.revision)
          throw new BuddyServiceError('BUDDY_CONFLICT')
        if (current.defaultBuddyId !== input.buddyId) {
          database.prepare('UPDATE buddy_catalog SET default_buddy_id = ?, revision = revision + 1 WHERE id = 1').run(input.buddyId)
        }
        return list()
      })
    },
  }
}

export type BuddyRepository = ReturnType<typeof createBuddyRepository>

function toBuddy(row: Record<string, unknown>): LocalBuddy {
  const { settings_json: settings, enabled, ...value } = row
  return buddySchema.parse({
    ...value,
    createdAt: normalizeStoredUtcTimestamp(value.createdAt),
    updatedAt: normalizeStoredUtcTimestamp(value.updatedAt),
    deletedAt: normalizeStoredUtcTimestamp(value.deletedAt),
    enabled: enabled === 1,
    settings: JSON.parse(settings as string),
  })
}

function normalizeStoredUtcTimestamp(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\+00:00$/, 'Z') : value
}

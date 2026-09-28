import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB_SETTINGS, webSettingsSchema } from '../../../../shared/network/webProtocol'
import { BUDDY_SCHEMA_MIGRATIONS } from '../../storage/schema'
import { createWorkspaceRepository } from '../../storage/workspaceRepository'
import { WebSettingsService } from '../WebSettingsService'

function fixture() {
  const database = new DatabaseSync(':memory:')
  for (const migration of BUDDY_SCHEMA_MIGRATIONS)
    database.exec(migration.sql)
  let key: string | null = null
  let failing = false
  const service = new WebSettingsService(createWorkspaceRepository(database), {
    request: async (method, input) => {
      if (method === 'host.secrets.read')
        return { ok: true, value: key }
      if (failing)
        throw new Error('fixture-private-credential-failure')
      key = method === 'host.secrets.delete' ? null : (input as { value: string }).value
      return { ok: true }
    },
  })
  return { service, database, fail: () => {
    failing = true
  } }
}

describe('web settings ownership', () => {
  it('publishes the durable disable before a credential mutation fails', async () => {
    const { service, database, fail } = fixture()
    try {
      await service.saveCredential({ key: 'fixture-private-credential' })
      const settings = service.get()
      settings.fetch.remote = true
      await service.save(settings)
      const changes: unknown[] = []
      service.onDidChange(change => changes.push(change))
      fail()
      await expect(service.saveCredential({ key: null })).rejects.toThrow('fixture-private-credential-failure')
      expect(service.get().fetch.remote).toBe(false)
      expect(changes).toMatchObject([{ kind: 'settings-committed', settings: { fetch: { remote: false } } }, { kind: 'credential-failed', tavilyKeyConfigured: null }])
      expect(JSON.stringify(changes)).not.toContain('fixture-private')
      await service.dispose()
    }
    finally { database.close() }
  })
  it('fences a late credential read and suppresses unchanged read observations', async () => {
    const { service, database } = fixture()
    const delayed = Promise.withResolvers<unknown>()
    const original = service.peer.request
    let delay = true
    service.peer.request = (method, input) => {
      if (method === 'host.secrets.read' && delay) {
        delay = false
        return delayed.promise
      }
      return original(method, input)
    }
    try {
      const changes: unknown[] = []
      service.onDidChange(change => changes.push(change))
      const reading = service.getTavilyKey()
      await service.saveCredential({ key: 'fixture-only-key' })
      const revision = service.state.revision
      delayed.resolve({ ok: true, value: null })
      await reading
      expect(service.state).toMatchObject({ revision, tavilyKeyConfigured: true })
      await service.getTavilyKey()
      expect(service.state.revision).toBe(revision)
      expect(JSON.stringify(changes)).not.toContain('fixture-only-key')
      await service.dispose()
    }
    finally { database.close() }
  })

  it('saving credentials grants no usage, clearing them revokes both uses, readding does not reenable', async () => {
    const { service, database } = fixture()
    try {
      const unauthorized = service.get()
      unauthorized.fetch.remote = true
      await expect(service.save(unauthorized)).rejects.toThrow()
      expect(service.get().fetch.remote).toBe(false)
      expect(await service.saveCredential({ key: 'fixture-only-key' })).toMatchObject({ settings: DEFAULT_WEB_SETTINGS, tavilyKeyConfigured: true })
      const settings = service.get()
      settings.search.find(source => source.provider === 'tavily')!.enabled = true
      settings.fetch.remote = true
      await service.save(settings)
      expect(await service.saveCredential({ key: null })).toMatchObject({ tavilyKeyConfigured: false, settings: { fetch: { remote: false } } })
      const saved = await service.saveCredential({ key: 'replacement-fixture-key' })
      expect(saved.settings.search.find(source => source.provider === 'tavily')!.enabled).toBe(false)
      expect(saved.settings.fetch.remote).toBe(false)
    }
    finally { database.close() }
  })
  it('preserves previous switches and fixed priority during the one-time settings migration', () => {
    const database = new DatabaseSync(':memory:')
    try {
      for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(m => m.version <= 7))
        database.exec(migration.sql)
      const repository = createWorkspaceRepository(database)
      repository.set('buddy.web', { search: { native: false, tavily: true, bing: true, brave: false }, fetch: { local: true, render: false, tavily: true } }, '2026-09-05T00:00:00Z')
      for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(m => m.version > 7))
        database.exec(migration.sql)
      expect(repository.get('buddy.web')).toEqual({
        search: [
          { provider: 'native', enabled: false },
          { provider: 'tavily', enabled: true },
          { provider: 'bing', enabled: true },
          { provider: 'brave', enabled: false },
        ],
        fetch: { render: false, remote: true },
      })
    }
    finally { database.close() }
  })

  it('appends new catalog sources when reading without resetting saved order or permissions', async () => {
    const { service, database } = fixture()
    try {
      const repository = createWorkspaceRepository(database)
      const previous = {
        search: [{ provider: 'brave', enabled: false }, { provider: 'tavily', enabled: true }, { provider: 'native', enabled: false }, { provider: 'bing', enabled: true }],
        fetch: { render: false, remote: true },
      }
      repository.set('buddy.web', previous, '2026-09-05T00:00:00Z')
      const expected = { ...previous, search: [...previous.search, { provider: 'google', enabled: true }, { provider: 'duckduckgo', enabled: true }] }
      expect(service.get()).toEqual(expected)
      expect(repository.get('buddy.web')).toEqual(previous)
      expect(webSettingsSchema.safeParse(service.get()).success).toBe(true)
      await service.saveCredential({ key: 'fixture-only-key' })
      await service.save(expected)
      expect(repository.get('buddy.web')).toEqual(expected)
      expect(service.get()).toEqual(expected)
    }
    finally { database.close() }
  })
})

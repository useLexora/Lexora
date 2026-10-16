import type { FastifyInstance } from 'fastify'
import type { OAuthProviders } from '../auth/providers.ts'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { hashToken } from '../auth/service.ts'
import { readConfig } from '../config.ts'
import { createDatabase } from '../database.ts'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('TEST_DATABASE_URL must point to a disposable database ending in _test')
const db = createDatabase(databaseUrl)
const origin = 'http://localhost:5173'
const headers = { origin, 'x-lexora-request': 'community' }
const providers: OAuthProviders = Object.fromEntries(['github', 'google', 'linux-do'].map(provider => [provider, {
  authorize: async ({ state }: { state: string }) => `https://identity.example/authorize?state=${state}`,
  exchange: async (url: URL) => ({ subject: url.searchParams.get('code')!, name: 'Same display name' }),
}]))
let app: FastifyInstance
const input = {
  manifest: { schemaVersion: 1, id: 'alice.weather', name: 'Weather', version: '1.0.0', description: 'Local weather', apiVersion: 3, engines: { lexora: '>=0.10.0' }, categories: ['tools'], tags: [], permissions: { network: { origins: ['https://example.com'] } }, contributes: { commands: [{ id: 'forecast', title: 'Forecast' }] } },
  repository: 'https://github.com/example/weather',
  artifact: { url: 'https://github.com/example/weather/releases/download/v1.0.0/weather.zip', sha256: 'a'.repeat(64), size: 1024 },
  notes: 'First release',
}
async function actor(subject: string, handle?: string) {
  const user = await db.user.create({ data: { name: 'Same display name', accounts: { create: { provider: 'github', subject } }, ...(handle ? { publisher: { create: { handle, displayName: 'Same display name' } } } : {}) } })
  const token = randomUUID()
  await db.session.create({ data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 60000) } })
  return { user, headers: { ...headers, cookie: `lexora_session=${token}` } }
}
async function start(provider = 'github', extra: Record<string, string> = {}, link = false) {
  const response = await app.inject({ method: 'POST', url: `/api/auth/${provider}/start`, headers: { ...headers, ...extra }, payload: { link } })
  expect(response.statusCode).toBe(200)
  const state = new URL(response.json().url).searchParams.get('state')!
  const cookie = response.cookies.map(item => `${item.name}=${item.value}`).join('; ')
  return { state, cookie, url: `/api/auth/${provider}/callback?state=${state}&code=subject-1` }
}

beforeAll(async () => {
  await db.$connect()
  app = createApp(db, readConfig({ DATABASE_URL: databaseUrl, PUBLIC_ORIGIN: origin, LEXORA_ADMIN_IDENTITIES: 'github:admin' }), { providers })
})
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "PluginRelease", "Plugin", "Publisher", "OAuthFlow", "Session", "OAuthAccount", "User" CASCADE')
})
afterAll(async () => {
  await app?.close()
  await db.$disconnect()
})

describe('community identity and publication boundaries', () => {
  it('requires same-origin mutation headers and an authenticated publisher', async () => {
    expect((await app.inject({ method: 'POST', url: '/publisher', payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/releases', headers, payload: input })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/auth/github/start', headers: { ...headers, origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403)
  })
  it('allows duplicate display names but reserves unique, immutable publisher handles', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const create = (auth: typeof alice, handle: string) => app.inject({ method: 'POST', url: '/api/publisher', headers: auth.headers, payload: { handle, displayName: 'Same display name' } })
    expect((await create(alice, 'alice')).statusCode).toBe(200)
    expect((await create(bob, 'alice')).statusCode).toBe(409)
    expect((await create(bob, 'bob')).statusCode).toBe(200)
    expect((await create(alice, 'renamed')).json().errorCode).toBe('HANDLE_IMMUTABLE')
  })
  it('binds OAuth state to its browser and consumes it once', async () => {
    const flow = await start()
    expect((await app.inject({ url: flow.url })).json().errorCode).toBe('OAUTH_STATE_INVALID')
    const response = await app.inject({ url: flow.url, headers: { cookie: flow.cookie } })
    expect(response.statusCode).toBe(302)
    const cookie = response.cookies.filter(item => item.name === 'lexora_session').map(item => `${item.name}=${item.value}`).join('; ')
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json().user.accounts).toEqual([{ provider: 'github', subject: 'subject-1' }])
    expect((await app.inject({ url: flow.url, headers: { cookie: flow.cookie } })).statusCode).toBe(400)
  })
  it('rejects expired flows and simultaneous replay', async () => {
    const expired = await start()
    await db.oAuthFlow.update({ where: { state: expired.state }, data: { expiresAt: new Date(0) } })
    expect((await app.inject({ url: expired.url, headers: { cookie: expired.cookie } })).statusCode).toBe(400)
    const fresh = await start()
    const responses = await Promise.all([app.inject({ url: fresh.url, headers: { cookie: fresh.cookie } }), app.inject({ url: fresh.url, headers: { cookie: fresh.cookie } })])
    expect(responses.map(response => response.statusCode).sort()).toEqual([302, 400])
    expect(await db.session.count()).toBe(1)
  })
  it('does not merge accounts by matching names and prevents stealing a linked identity', async () => {
    for (const provider of ['github', 'google']) {
      const flow = await start(provider)
      expect((await app.inject({ url: flow.url, headers: { cookie: flow.cookie } })).statusCode).toBe(302)
    }
    expect(await db.user.count()).toBe(2)
    const other = await actor('other')
    const flow = await start('github', other.headers, true)
    const response = await app.inject({ url: flow.url, headers: { cookie: `${other.headers.cookie}; ${flow.cookie}` } })
    expect(response.json().errorCode).toBe('ACCOUNT_ALREADY_LINKED')
    expect((await db.oAuthAccount.findUniqueOrThrow({ where: { provider_subject: { provider: 'github', subject: 'subject-1' } } })).userId).not.toBe(other.user.id)
  })
  it('requires the initiating session when linking accounts', async () => {
    const user = await actor('alice')
    const flow = await start('google', user.headers, true)
    expect((await app.inject({ url: flow.url, headers: { cookie: flow.cookie } })).statusCode).toBe(401)
    const response = await app.inject({ url: flow.url, headers: { cookie: `${user.headers.cookie}; ${flow.cookie}` } })
    expect(response.statusCode).toBe(302)
    expect(await db.oAuthAccount.count({ where: { userId: user.user.id } })).toBe(2)
    expect((await app.inject({ url: '/api/session', headers: user.headers })).json().user).toBeNull()
  })
  it('keeps pending releases private and preserves immutable manifests and artifacts', async () => {
    const alice = await actor('alice', 'alice')
    const admin = await actor('admin')
    const response = await app.inject({ method: 'POST', url: '/api/releases', headers: alice.headers, payload: input })
    expect(response.statusCode).toBe(201)
    const release = response.json()
    expect(release.manifest).toEqual(input.manifest)
    expect((await app.inject({ url: '/api/plugins' })).json().total).toBe(0)
    expect((await app.inject({ url: '/api/plugins/alice.weather' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/catalog/v1/index.json' })).json().plugins).toEqual([])
    expect((await app.inject({ method: 'POST', url: '/api/releases', headers: alice.headers, payload: { ...input, notes: 'changed' } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `/api/reviews/${release.id}`, headers: alice.headers, payload: { action: 'publish', reason: 'Self approval' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/reviews/${release.id}`, headers: admin.headers, payload: { action: 'publish', reason: 'Verified' } })).statusCode).toBe(200)
    const catalog = (await app.inject({ url: '/api/catalog/v1/index.json' })).json()
    expect(catalog).toEqual({ schemaVersion: 1, plugins: [{ manifest: input.manifest, repository: input.repository, artifact: input.artifact }] })
    const listing = await app.inject({ url: '/api/plugins' })
    expect(listing.json().items[0].release.manifest).not.toHaveProperty('permissions')
    expect(listing.json().items[0].release.manifest).not.toHaveProperty('contributes')
    expect((await app.inject({ url: '/api/plugins', headers: { 'if-none-match': listing.headers.etag! } })).statusCode).toBe(304)
    expect((await app.inject({ url: '/api/plugins?q=missing' })).json().total).toBe(0)
    expect((await app.inject({ url: '/api/categories' })).json()).toEqual(input.manifest.categories)
    expect((await app.inject({ url: '/api/plugins?category=missing' })).json().total).toBe(0)
    expect((await app.inject({ url: `/api/plugins?category=${encodeURIComponent(input.manifest.categories[0]!)}` })).json().total).toBe(1)
    expect((await app.inject({ method: 'POST', url: `/api/reviews/${release.id}`, headers: admin.headers, payload: { action: 'reject', reason: 'Stale review' } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `/api/reviews/${release.id}`, headers: admin.headers, payload: { action: 'yank', reason: 'Withdrawn' } })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/plugins' })).json().total).toBe(0)
    expect((await app.inject({ method: 'POST', url: '/api/releases', headers: alice.headers, payload: input })).statusCode).toBe(409)
  })
  it('rejects namespace squatting, reserved IDs and cross-publisher updates', async () => {
    const alice = await actor('alice', 'alice')
    const bob = await actor('bob', 'bob')
    expect((await app.inject({ method: 'POST', url: '/api/releases', headers: bob.headers, payload: input })).json().errorCode).toBe('PLUGIN_NAMESPACE_REQUIRED')
    expect((await app.inject({ method: 'POST', url: '/api/releases', headers: alice.headers, payload: input })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: '/api/releases', headers: bob.headers, payload: { ...input, manifest: { ...input.manifest, version: '1.1.0' } } })).json().errorCode).toBe('PLUGIN_OWNED_BY_ANOTHER_PUBLISHER')
    expect((await app.inject({ method: 'POST', url: '/api/releases', headers: bob.headers, payload: { ...input, manifest: { ...input.manifest, id: 'lexora.weather' } } })).json().errorCode).toBe('PLUGIN_ID_RESERVED')
  })
  it('rejects unsafe URLs, invalid checksums and oversized metadata', async () => {
    const alice = await actor('alice', 'alice')
    for (const artifact of [{ ...input.artifact, url: 'javascript:alert(1)' }, { ...input.artifact, url: 'https://user:secret@example.com/file.zip' }, { ...input.artifact, sha256: 'invalid' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/releases', headers: alice.headers, payload: { ...input, artifact } })).statusCode).toBe(400)
    }
    expect((await app.inject({ method: 'POST', url: '/api/releases', headers: alice.headers, payload: { ...input, notes: 'a'.repeat(300000) } })).statusCode).toBe(413)
  })
})

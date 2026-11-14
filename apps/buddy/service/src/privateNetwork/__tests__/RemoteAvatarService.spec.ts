import type { TrustedCommandPrincipal } from '../../commands/CommandAdmissionService'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { PrivateNetworkError } from '../../../../shared/privateNetwork/pairing'
import { RemoteAvatarService } from '../RemoteAvatarService'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aU1cAAAAASUVORK5CYII=', 'base64')
const hash = createHash('sha256').update(image).digest('hex')
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE buddies (id TEXT PRIMARY KEY, avatar TEXT, settings_json TEXT, deleted_at TEXT)')
  const set = (id: string, avatar: string | null, deleted = false) => database.prepare('INSERT OR REPLACE INTO buddies VALUES (?, ?, ?, ?)').run(id, avatar, '{"private":"not-public"}', deleted ? '2026-01-01' : null)
  set('custom', `data:image/png;base64,${image.toString('base64')}`)
  cleanups.push(() => database.close())
  return { database, set }
}

it('serves authenticated exact image versions and rejects changed, reset, or revoked access', async () => {
  const f = fixture()
  let active = true
  const principal = { assertAuthenticated: () => {
    if (!active)
      throw new PrivateNetworkError('NOT_AUTHORIZED')
  } } as TrustedCommandPrincipal
  const service = new RemoteAvatarService(f.database)
  const server = createServer((request, response) => {
    try {
      if (!service.bytes(request, response, principal)) {
        response.statusCode = 404
        response.end()
      }
    }
    catch (error) {
      response.statusCode = 409
      response.end((error as Error).message)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/avatars/custom/${hash}`
  const response = await fetch(url)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(response.headers.get('etag')).toBe(`"${hash}"`)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(image)
  expect((await fetch(url, { method: 'HEAD' })).headers.get('content-length')).toBe(String(image.length))
  expect((await fetch(url.replace(hash, 'a'.repeat(64)))).status).toBe(409)
  active = false
  expect((await fetch(url)).status).toBe(409)
  active = true
  f.set('custom', null)
  expect((await fetch(url)).status).toBe(409)
})

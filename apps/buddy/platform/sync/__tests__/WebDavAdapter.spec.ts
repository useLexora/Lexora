import type { SyncTransport } from '../SyncAdapter'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { probeSyncConnection } from '../probeSyncConnection'
import { WebDavAdapter } from '../WebDavAdapter'

const connection = { id: randomUUID(), name: 'Fixture', adapter: 'webdav' as const, endpoint: 'https://dav.example.invalid/dav/', username: 'fixture', directory: 'lexora-test' }
const signal = new AbortController().signal
function fixture(options: { denied?: string, corrupt?: boolean, cleanupDenied?: boolean, uncertainWrite?: boolean, occupied?: boolean } = {}) {
  const retainedKey = `/dav/lexora-test/lexora-backups-v1/objects/${'a'.repeat(64)}`
  const retained = new Uint8Array([4, 2])
  const objects = new Map<string, Uint8Array>([[retainedKey, retained]])
  const directories = new Set(['/dav/', '/dav/lexora-test/'])
  const transport: SyncTransport = async (url, input) => {
    input.signal.throwIfAborted()
    const path = new URL(url).pathname
    if (input.method === options.denied)
      return new Response(null, { status: 403 })
    if (input.method === 'MKCOL') {
      if (directories.has(path) || options.occupied)
        return new Response(null, { status: 405 })
      directories.add(path)
      return new Response(null, { status: 201 })
    }
    if (input.method === 'PROPFIND') {
      if (!directories.has(path))
        return new Response(null, { status: 404 })
      return new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${path}</d:href><d:propstat><d:prop><d:resourcetype>${options.occupied ? '' : '<d:collection/>'}</d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`, { status: 207 })
    }
    if (input.method === 'PUT') {
      expect(input.headers['If-None-Match']).toBe('*')
      if (objects.has(path))
        return new Response(null, { status: 412 })
      objects.set(path, input.body!)
      if (options.uncertainWrite)
        throw new Error('synthetic lost acknowledgement')
      return new Response(null, { status: 201 })
    }
    if (input.method === 'GET')
      return new Response(options.corrupt ? new Uint8Array([0]) : objects.get(path), { status: 200 })
    if (input.method === 'DELETE') {
      if (options.cleanupDenied)
        return new Response(null, { status: 403 })
      objects.delete(path)
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected fixture request')
  }
  const adapter = new WebDavAdapter(connection, 'synthetic-secret', transport)
  return { adapter, objects, retainedKey, retained }
}

it('checks the selected directory end to end and removes only its own temporary object', async () => {
  const f = fixture()
  await probeSyncConnection(f.adapter, signal)
  expect([...f.objects]).toEqual([[f.retainedKey, f.retained]])
})

it.each([[401, 'SYNC_AUTHENTICATION_FAILED'], [403, 'SYNC_PERMISSION_DENIED'], [404, 'SYNC_ENDPOINT_MISSING']] as const)('distinguishes endpoint failure %s', async (status, code) => {
  const adapter = new WebDavAdapter(connection, 'synthetic-secret', async () => new Response(null, { status }))
  await expect(probeSyncConnection(adapter, signal)).rejects.toThrow(code)
})

it.each(['MKCOL', 'PUT'])('does not report a readable but unwritable directory as usable when %s is denied', async (denied) => {
  const f = fixture({ denied })
  await expect(probeSyncConnection(f.adapter, signal)).rejects.toThrow('SYNC_PERMISSION_DENIED')
  expect([...f.objects]).toEqual([[f.retainedKey, f.retained]])
})

it.each([{ corrupt: true }, { uncertainWrite: true }])('cleans its object after a failed read or lost upload acknowledgement: %j', async (options) => {
  const f = fixture(options)
  await expect(probeSyncConnection(f.adapter, signal)).rejects.toThrow()
  expect([...f.objects]).toEqual([[f.retainedKey, f.retained]])
})

it('reports cleanup failure and preserves unrelated backup objects', async () => {
  const f = fixture({ cleanupDenied: true })
  await expect(probeSyncConnection(f.adapter, signal)).rejects.toThrow('SYNC_TEST_CLEANUP_FAILED')
  expect(f.objects.get(f.retainedKey)).toEqual(f.retained)
  expect(f.objects.size).toBe(2)
})

it('rejects an existing file in place of the backup directory', async () => {
  const f = fixture({ occupied: true })
  await expect(probeSyncConnection(f.adapter, signal)).rejects.toThrow('SYNC_REMOTE_DIRECTORY_INVALID')
  expect([...f.objects]).toEqual([[f.retainedKey, f.retained]])
})

it('cleans its temporary object with a fresh deadline after the test is cancelled', async () => {
  const f = fixture()
  const controller = new AbortController()
  const adapter = {
    test: (signal: AbortSignal) => f.adapter.test(signal),
    prepare: (signal: AbortSignal) => f.adapter.prepare(signal),
    list: (signal: AbortSignal) => f.adapter.list(signal),
    write: (key: string, bytes: Uint8Array, signal: AbortSignal) => f.adapter.write(key, bytes, signal),
    read: async () => {
      controller.abort(new Error('synthetic cancellation'))
      throw controller.signal.reason
    },
    remove: (key: string, signal: AbortSignal) => f.adapter.remove(key, signal),
  }
  await expect(probeSyncConnection(adapter, controller.signal)).rejects.toThrow('synthetic cancellation')
  expect([...f.objects]).toEqual([[f.retainedKey, f.retained]])
})

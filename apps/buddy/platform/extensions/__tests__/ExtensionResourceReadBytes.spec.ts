import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionResourceStore } from '../ExtensionResourceStore'

const extensionId = 'tests.read-bytes'
const chunkSize = 128 * 1024

afterEach(() => vi.restoreAllMocks())

async function fixture(size = 256 * 1024) {
  const root = await createTemporaryDirectory('lexora-resource-read-bytes-')
  const path = join(root, 'selected.bin')
  const bytes = Buffer.alloc(size).map((_, index) => index % 251)
  await writeFile(path, bytes)
  const store = new ExtensionResourceStore(join(root, 'extensions'))
  const [resource] = await store.grant(extensionId, [path], () => {})
  const controller = new AbortController()
  const read = (offset = 0, length = chunkSize, allowLocal = true) => store.readBytes(extensionId, resource!.id, offset, length, controller.signal, allowLocal)
  return { root, path, bytes, store, resource: resource!, controller, read }
}

it('reads exact chunks through one protected GET per call, never HEAD plus GET', async () => {
  const f = await fixture(2 * chunkSize + 17)
  const response = vi.spyOn(f.store, 'response')
  const chunks: Buffer[] = []
  for (let offset = 0; offset < f.bytes.length; offset += chunkSize) {
    response.mockClear()
    const result = await f.read(offset)
    const bytes = Buffer.from(result.base64, 'base64')
    expect(bytes).toEqual(f.bytes.subarray(offset, offset + chunkSize))
    expect(result).toMatchObject({ size: f.bytes.length, eof: offset + bytes.length === f.bytes.length })
    expect(bytes.length).toBeLessThanOrEqual(chunkSize)
    expect(response).toHaveBeenCalledExactlyOnceWith(extensionId, f.resource.id, expect.any(Request), f.controller.signal, true)
    const request = response.mock.calls[0]![2]
    expect(request.method).toBe('GET')
    expect(request.headers.get('range')).toBe(`bytes=${offset}-${offset + chunkSize - 1}`)
    chunks.push(bytes)
  }
  expect(Buffer.concat(chunks)).toEqual(f.bytes)
  expect(await readFile(f.path)).toEqual(f.bytes)
})

it.each([
  { size: 13, offset: 3, length: 4 },
  { size: 13, offset: 12, length: 1 },
  { size: 13, offset: 12, length: 17 },
  { size: 13, offset: 13, length: 17 },
  { size: 13, offset: 50, length: 17 },
  { size: 13, offset: Number.MAX_SAFE_INTEGER, length: chunkSize },
  { size: 0, offset: 0, length: 1 },
  { size: 0, offset: 50, length: chunkSize },
])('reports stable size and EOF for $size bytes at $offset + $length', async ({ size, offset, length }) => {
  const f = await fixture(size)
  const response = vi.spyOn(f.store, 'response')
  const expected = { base64: Buffer.from(f.bytes.subarray(offset, offset + length)).toString('base64'), size, eof: offset + length >= size }
  for (let attempt = 0; attempt < 2; attempt++) {
    response.mockClear()
    expect(await f.read(offset, length)).toEqual(expected)
    expect(response).toHaveBeenCalledTimes(1)
    const request = response.mock.calls[0]![2]
    const end = offset + Math.min(length - 1, Number.MAX_SAFE_INTEGER - offset)
    expect(request.headers.get('range')).toBe(`bytes=${offset}-${end}`)
  }
})

it.each([
  [-1, 1],
  [0.5, 1],
  [Number.NaN, 1],
  [Number.POSITIVE_INFINITY, 1],
  [Number.MAX_SAFE_INTEGER + 1, 1],
  [0, 0],
  [0, -1],
  [0, 1.5],
  [0, Number.NaN],
  [0, chunkSize + 1],
])('rejects an invalid offset/length (%s, %s) before requesting a resource', async (offset, length) => {
  const f = await fixture(13)
  const response = vi.spyOn(f.store, 'response')
  await expect(f.read(offset, length)).rejects.toThrow('EXTENSION_RESOURCE_RANGE_INVALID')
  expect(response).not.toHaveBeenCalled()
})

it('rejects forged, foreign, unpermitted and revoked handles even at EOF', async () => {
  const f = await fixture(13)
  await expect(f.store.readBytes(extensionId, randomUUID(), 13, 1, f.controller.signal)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(f.store.readBytes('tests.other', f.resource.id, 13, 1, f.controller.signal)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(f.read(13, 1, false)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await f.store.revoke(extensionId, f.resource.id)
  await expect(f.read(0, 1)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(f.read(13, 1)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
})

it('rechecks directory authorization for each chunk', async () => {
  const f = await fixture(13)
  const folder = join(f.root, 'directory')
  await mkdir(folder)
  await writeFile(join(folder, 'child.bin'), f.bytes)
  const directory = await f.store.grantDirectory(extensionId, folder, () => {})
  const [resource] = await f.store.scanDirectory(extensionId, { id: directory.id, extensions: [], recursive: true }, () => {})
  expect(await f.store.readBytes(extensionId, resource!.id, 0, 1, f.controller.signal)).toMatchObject({ size: 13, eof: false })
  await f.store.revokeDirectory(extensionId, directory.id, () => {})
  await expect(f.store.readBytes(extensionId, resource!.id, 13, 1, f.controller.signal)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
})

it('reads private assets without local permission and honors release', async () => {
  const f = await fixture(13)
  const resource = await f.store.import(extensionId, 'private.bin', 'application/octet-stream', new Response(f.bytes), f.controller.signal, () => {})
  const response = vi.spyOn(f.store, 'response')
  expect(await f.store.readBytes(extensionId, resource.id, 10, 10, f.controller.signal, false)).toEqual({ base64: Buffer.from(f.bytes.subarray(10)).toString('base64'), size: 13, eof: true })
  expect(response).toHaveBeenCalledExactlyOnceWith(extensionId, resource.id, expect.any(Request), f.controller.signal, false)
  await f.store.release(extensionId, resource.id, () => {})
  await expect(f.store.readBytes(extensionId, resource.id, 0, 1, f.controller.signal, false)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
})

it('rejects revocation after opening a range and before returning its bytes', async () => {
  const f = await fixture()
  const response = f.store.response.bind(f.store)
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    await f.store.revoke(extensionId, f.resource.id)
    return result
  })
  await expect(f.read()).rejects.toThrow('EXTENSION_RESOURCE_REVOKED')
  await expect(f.read()).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
})

it.each(['resize', 'rewrite', 'replace'] as const)('revalidates file identity after %s between calls, including EOF', async (change) => {
  const f = await fixture(13)
  expect(await f.read(0, 1)).toMatchObject({ size: 13, eof: false })
  const before = await stat(f.path)
  if (change === 'replace') {
    await rename(f.path, `${f.path}.old`)
    await writeFile(f.path, f.bytes)
    await utimes(f.path, before.atime, before.mtime)
  }
  else if (change === 'rewrite') {
    await writeFile(f.path, Buffer.alloc(13, 42))
    await utimes(f.path, before.atime, new Date(before.mtimeMs + 60000))
  }
  else {
    await truncate(f.path, 12)
  }
  await expect(f.read(0, 1)).rejects.toThrow('EXTENSION_RESOURCE_CHANGED')
  await expect(f.read(13, 1)).rejects.toThrow('EXTENSION_RESOURCE_CHANGED')
})

it('rejects truncation during an open range instead of returning a short successful read', async () => {
  const f = await fixture()
  const response = f.store.response.bind(f.store)
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    await truncate(f.path, 0)
    return result
  })
  await expect(f.read()).rejects.toThrow('RESOURCE_FILE_CHANGED')
})

it('does not open a resource for an already aborted read', async () => {
  const f = await fixture(13)
  const response = vi.spyOn(f.store, 'response')
  f.controller.abort(new Error('READ_CANCELLED'))
  await expect(f.read()).rejects.toThrow('READ_CANCELLED')
  expect(response).not.toHaveBeenCalled()
})

it.each([0, 256 * 1024])('rejects abort after the protected response, including EOF at %i', async (offset) => {
  const f = await fixture()
  const response = f.store.response.bind(f.store)
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    f.controller.abort(new Error('READ_CANCELLED'))
    return result
  })
  await expect(f.read(offset)).rejects.toThrow('READ_CANCELLED')
})

it('rejects lifetime cancellation while consuming the protected range body', async () => {
  const f = await fixture()
  const response = f.store.response.bind(f.store)
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    const arrayBuffer = result.arrayBuffer.bind(result)
    vi.spyOn(result, 'arrayBuffer').mockImplementationOnce(() => {
      const pending = arrayBuffer()
      f.controller.abort(new Error('READ_CANCELLED'))
      return pending
    })
    return result
  })
  await expect(f.read()).rejects.toThrow('EXTENSION_RESOURCE_REVOKED')
})

it('rejects cancellation after body consumption instead of returning completed bytes', async () => {
  const f = await fixture(13)
  const response = f.store.response.bind(f.store)
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    const arrayBuffer = result.arrayBuffer.bind(result)
    vi.spyOn(result, 'arrayBuffer').mockImplementationOnce(async () => {
      const bytes = await arrayBuffer()
      f.controller.abort(new Error('READ_CANCELLED'))
      return bytes
    })
    return result
  })
  await expect(f.read()).rejects.toThrow('READ_CANCELLED')
})

it.each([
  { range: null },
  { range: 'invalid' },
  { range: 'bytes 0-3/*' },
  { range: 'bytes 0-3/9007199254740992' },
  { range: 'bytes 1-4/262144' },
  { range: 'bytes 0-4/262144' },
  { range: 'bytes 0-2/262144' },
  { range: 'bytes 0-3/0' },
  { range: 'bytes 0-3/262144', contentLength: '262144' },
])('cancels malformed partial metadata without consuming the body: $range / $contentLength', async ({ range, contentLength }) => {
  const f = await fixture()
  const response = f.store.response.bind(f.store)
  const consume = vi.fn()
  const cancel = vi.fn()
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    if (range === null)
      result.headers.delete('content-range')
    else
      result.headers.set('content-range', range)
    if (contentLength)
      result.headers.set('content-length', contentLength)
    const arrayBuffer = result.arrayBuffer.bind(result)
    vi.spyOn(result, 'arrayBuffer').mockImplementation(() => {
      consume()
      return arrayBuffer()
    })
    const cancelBody = result.body!.cancel.bind(result.body!)
    vi.spyOn(result.body!, 'cancel').mockImplementation(async () => {
      cancel()
      await cancelBody()
    })
    return result
  })
  await expect(f.read(0, 4)).rejects.toThrow('EXTENSION_RESOURCE_RANGE_INVALID')
  expect(consume).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
})

it('cancels an unexpected full response instead of buffering the file', async () => {
  const f = await fixture()
  const response = f.store.response.bind(f.store)
  const consume = vi.fn()
  const cancel = vi.fn()
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (id, resourceId, _request, ...args) => {
    const result = await response(id, resourceId, new Request('https://resource.invalid/'), ...args)
    const arrayBuffer = result.arrayBuffer.bind(result)
    vi.spyOn(result, 'arrayBuffer').mockImplementation(() => {
      consume()
      return arrayBuffer()
    })
    const cancelBody = result.body!.cancel.bind(result.body!)
    vi.spyOn(result.body!, 'cancel').mockImplementation(async () => {
      cancel()
      await cancelBody()
    })
    return result
  })
  await expect(f.read(0, 4)).rejects.toThrow('EXTENSION_RESOURCE_RANGE_INVALID')
  expect(consume).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
})

it.each([
  { range: null },
  { range: 'invalid' },
  { range: 'bytes */9007199254740992' },
  { range: 'bytes */100' },
  { range: 'bytes */13', contentLength: '1' },
])('rejects invalid 416 metadata rather than inventing size or EOF: $range / $contentLength', async ({ range, contentLength }) => {
  const f = await fixture(13)
  const response = f.store.response.bind(f.store)
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    expect(result.status).toBe(416)
    if (range === null)
      result.headers.delete('content-range')
    else
      result.headers.set('content-range', range)
    if (contentLength)
      result.headers.set('content-length', contentLength)
    return result
  })
  await expect(f.read(13, 1)).rejects.toThrow('EXTENSION_RESOURCE_RANGE_INVALID')
})

it.each([3, 5])('rejects a body length of %i when the protected range promised 4 bytes', async (length) => {
  const f = await fixture(13)
  const response = f.store.response.bind(f.store)
  vi.spyOn(f.store, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    vi.spyOn(result, 'arrayBuffer').mockResolvedValueOnce(new ArrayBuffer(length))
    return result
  })
  await expect(f.read(0, 4)).rejects.toThrow('EXTENSION_RESOURCE_RANGE_INVALID')
})

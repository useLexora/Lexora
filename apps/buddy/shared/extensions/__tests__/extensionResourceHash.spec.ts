import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createExtensionResourceClient } from '../extensionResourceClient'
import { extensionResourceHashRequestSchema, extensionResourceHashSchema } from '../extensionResources'

const emptyHash = { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', size: 0 }

it('keeps the resource hash protocol narrow and validates complete digest results', () => {
  const request = { id: randomUUID(), resourceId: randomUUID() }
  expect(extensionResourceHashRequestSchema.parse(request)).toEqual(request)
  expect(extensionResourceHashRequestSchema.safeParse({ ...request, path: '/private/file' }).success).toBe(false)
  expect(extensionResourceHashRequestSchema.safeParse({ resourceId: request.resourceId }).success).toBe(false)
  expect(extensionResourceHashSchema.parse(emptyHash)).toEqual(emptyHash)
  for (const invalid of [{ ...emptyHash, sha256: 'ABC' }, { ...emptyHash, size: -1 }, { ...emptyHash, size: Number.MAX_SAFE_INTEGER + 1 }])
    expect(extensionResourceHashSchema.safeParse(invalid).success).toBe(false)
})

it('honors pre-aborted and synchronous in-flight cancellation even if a late host result succeeds', async () => {
  const controller = new AbortController()
  const resource = { id: randomUUID(), name: 'model.bin', path: '/not-a-capability' }
  const calls: Array<{ method: string, params: unknown }> = []
  const client = createExtensionResourceClient(async (method, params) => {
    calls.push({ method, params })
    if (method === 'resources.hash')
      controller.abort(new Error('CANCELLED'))
    return emptyHash
  })
  await expect(client.hash(resource, { signal: controller.signal })).rejects.toThrow('CANCELLED')
  expect(calls).toEqual([
    { method: 'resources.hash', params: { id: expect.any(String), resourceId: resource.id } },
    { method: 'network.cancel', params: { id: (calls[0]!.params as { id: string }).id } },
  ])
  calls.length = 0
  await expect(client.hash(resource, { signal: controller.signal })).rejects.toThrow('CANCELLED')
  expect(calls).toEqual([])
})

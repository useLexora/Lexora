import type { ExtensionWorkerConstructor } from '../extensionWorkers'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createExtensionWorkers as createWorkers } from '../extensionWorkers'

const root = new URL('lexora-extension://session-one/__package/')
const blobs = new Set<string>()
const fetchSource = vi.fn<typeof fetch>()
let NativeWorker: ExtensionWorkerConstructor<TestWorker>
const createExtensionWorkers = (root: URL, owner: AbortSignal) => createWorkers(root, owner, NativeWorker)

class TestWorker extends EventTarget {
  terminations = 0

  terminate() {
    this.terminations++
  }
}

beforeEach(() => {
  fetchSource.mockReset().mockResolvedValue(new Response('postMessage("loaded")'))
  vi.stubGlobal('fetch', fetchSource)
  NativeWorker = TestWorker
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:fixture-${blobs.size}`
    blobs.add(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => void blobs.delete(url))
})

afterEach(() => {
  blobs.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('creates a classic package worker and releases its URL on explicit termination', async () => {
  const owner = new AbortController()
  const api = createExtensionWorkers(root, owner.signal)
  const worker = await api.create('workers/decoder.js', { name: 'decoder' })
  worker.terminate()
  owner.abort()
  worker.terminate()
  expect(worker.terminations).toBe(1)
  expect(blobs.size).toBe(0)
})

it.each([
  'https://example.invalid/worker.js',
  'lexora-extension://session-two/__package/worker.js',
  'lexora-extension://user@session-one/__package/worker.js',
  '../__view.js',
  '/__package-other/worker.js',
  '%2e%2e/__host.js',
  'nested/%252e%252e/worker.js',
  'worker.js?token=other',
  'worker.js#other',
  'asset.wasm',
])('rejects entries outside the session package: %s', async (entry) => {
  await expect(createExtensionWorkers(root, new AbortController().signal).create(entry)).rejects.toThrow('EXTENSION_WORKER_ENTRY_INVALID')
  expect(blobs.size).toBe(0)
  expect(fetchSource).not.toHaveBeenCalled()
})

it('isolates invocation cancellation from other workers and releases the remainder with its owner', async () => {
  const owner = new AbortController()
  const invocation = new AbortController()
  const api = createExtensionWorkers(root, owner.signal)
  const a = await api.create('first.mjs', { type: 'module', signal: invocation.signal })
  const b = await api.create('second.mjs', { type: 'module' })
  invocation.abort()
  expect(a.terminations).toBe(1)
  expect(b.terminations).toBe(0)
  expect(blobs.size).toBe(1)
  owner.abort()
  expect(b.terminations).toBe(1)
  expect(blobs.size).toBe(0)
  await expect(api.create('late.js')).rejects.toMatchObject({ name: 'AbortError' })
})

it('does not create a late worker when its owner closes during package loading', async () => {
  const response = deferred<Response>()
  fetchSource.mockReturnValue(response.promise)
  const owner = new AbortController()
  const creating = createExtensionWorkers(root, owner.signal).create('worker.js')
  owner.abort()
  response.resolve(new Response('postMessage("late")'))
  await expect(creating).rejects.toMatchObject({ name: 'AbortError' })
  expect(blobs.size).toBe(0)
})

it('rejects missing package code without executing an error page', async () => {
  fetchSource.mockResolvedValue(new Response('denied', { status: 403 }))
  await expect(createExtensionWorkers(root, new AbortController().signal).create('worker.js')).rejects.toThrow('EXTENSION_WORKER_LOAD_FAILED')
  expect(blobs.size).toBe(0)
})

it('cleans up worker construction and execution failures without a page fallback', async () => {
  const owner = new AbortController()
  const worker = await createExtensionWorkers(root, owner.signal).create('worker.js')
  worker.dispatchEvent(new Event('error'))
  expect(worker.terminations).toBe(1)
  expect(blobs.size).toBe(0)
  NativeWorker = class extends TestWorker {
    constructor() {
      super()
      throw new Error('Worker unavailable')
    }
  }
  await expect(createExtensionWorkers(root, owner.signal).create('worker.mjs', { type: 'module' })).rejects.toThrow('Worker unavailable')
  expect(blobs.size).toBe(0)
})

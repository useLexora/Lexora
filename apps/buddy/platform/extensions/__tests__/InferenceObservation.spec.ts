import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { Buffer } from 'node:buffer'
import { rm } from 'node:fs/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { inferenceDiagnosticSchema } from '../../../shared/diagnostics/inferenceDiagnostic'
import { inferenceBindingSchema } from '../../../shared/extensions/extensionInference'
import { ExtensionInference } from '../ExtensionInference'
import { NativeInferenceProcess } from '../NativeInferenceProcess'
import { createStore, manifest } from './fixtures'
import { invocation, memoryInference } from './inferenceFixtures'

async function fixture(record?: ApplicationDiagnosticReporter) {
  const { root, store } = await createStore()
  const owner = 'fixture.inference'
  const contribution = manifest({ id: owner, apiVersion: 3, permissions: { inference: true }, contributes: { inference: {
    runtimes: ['first', 'second'].map(id => ({ id, entry: 'native/fixture.mjs', platforms: ['linux-x64'], idleTimeoutMs: 60000 })),
    capabilities: ['first', 'second'].map(runtime => ({ id: runtime, runtime, title: runtime, kind: 'chat.completion' })),
  } } })
  await store.install((await store.reviewFiles(new Map([
    ['extension.json', Buffer.from(JSON.stringify(contribution))],
    ['extension.js', Buffer.from('export function activate() {}')],
    ['native/fixture.mjs', Buffer.from('export function initialize() {}')],
  ]))).token)
  const pkg = store.installed[owner]!.current
  const native: ReturnType<typeof memoryInference>[] = []
  vi.spyOn(NativeInferenceProcess, 'start').mockImplementation(async (options) => {
    const current = memoryInference({ record: options.record })
    native.push(current)
    return current.worker
  })
  const runtime = new ExtensionInference(store, pkg, { bootstrap: '', executable: '', admit: async () => async () => {}, record }, {
    response: async () => { throw new Error('Unexpected download') },
    openReference: async () => { throw new Error('Unexpected resource') },
  }, () => {})
  onTestFinished(async () => {
    await runtime.dispose()
    await Promise.all(native.map(item => item.reading))
    await rm(root, { recursive: true, force: true })
  })
  for (const id of ['first', 'second'])
    await runtime.bind(inferenceBindingSchema.parse({ runtime: id, resources: [] }))
  const invoke = (id = 'first') => runtime.invoke(pkg.manifest.contributes.inference!.capabilities.find(item => item.id === id)!, invocation({ capability: id }))
  const observation = () => runtime.status()[0]!.instances[0]?.observation
  const emit = (data: unknown, index = 0) => native[index]!.stderr.write(`${JSON.stringify(data)}\n`)
  return { runtime, native, invoke, observation, emit }
}

it('projects validated incremental diagnostics per instance and forwards the original report', async () => {
  const records: unknown[] = []
  const f = await fixture(event => records.push(event))
  await f.invoke()
  expect(f.observation()).toBeUndefined()
  f.emit({ event: 'chat.gpu.start', backend: { requested: 'cuda', observed: [] }, context: { requested: 4096 }, raw: 'private' })
  f.emit({ event: 'chat.gpu.ready', device: [{ backend: 'cuda', index: 0, name: 'private' }], context: { actual: 2048, train: 32768 }, loadMs: 25, offload: { layers: 12, total: 24 }, degraded: true })
  f.emit({ event: 'chat.gpu.timings', timings: { prompt: { tokens: 4, ms: 2 } } })
  f.emit({ event: 'chat.gpu.timings', timings: { decode: { tokens: 8, ms: 10 } }, decode: { tokens: 8, ms: 10 } })
  expect(f.observation()).toEqual({
    observedAt: expect.any(Number),
    backend: { requested: 'cuda', observed: [] },
    context: { requested: 4096, actual: 2048, train: 32768 },
    device: [{ backend: 'cuda', index: 0 }],
    offload: { layers: 12, total: 24 },
    degraded: true,
    loadMs: 25,
    timings: { prompt: { tokens: 4, ms: 2 }, decode: { tokens: 8, ms: 10 } },
    decode: { tokens: 8, ms: 10 },
  })
  expect(records).toHaveLength(4)
  expect(records[0]).toMatchObject({ event: 'chat.gpu.start', operationId: f.native[0]!.worker.instanceId })
  const copy = f.observation()!
  copy.context!.actual = 1
  expect(f.observation()!.context!.actual).toBe(2048)
  await f.invoke('second')
  f.emit({ event: 'chat.gpu.ready', backend: { requested: 'cpu', observed: ['cpu'] } }, 1)
  expect(f.observation()!.backend!.requested).toBe('cuda')
  f.emit({ event: 'chat.gpu.ready', loadMs: -1 })
  expect(f.observation()!.loadMs).toBe(25)
  f.emit({ event: 'chat.gpu.error', code: 'EXTENSION_INFERENCE_PROCESS_FAILED' })
  expect(f.observation()!.error).toBe('EXTENSION_INFERENCE_PROCESS_FAILED')
  f.emit({ event: 'chat.gpu.start', context: { requested: 1024 } })
  expect(f.observation()).toEqual({ context: { requested: 1024 }, observedAt: expect.any(Number) })
})

it('observes without a log subscriber and clears on stop, rebind and restart', async () => {
  const f = await fixture()
  await f.invoke()
  f.emit({ event: 'chat.gpu.ready', context: { actual: 2048 }, loadMs: 5 })
  expect(f.observation()!.context!.actual).toBe(2048)
  const stopping = f.runtime.stop({ runtime: 'first' })
  await Promise.resolve()
  expect(f.observation()).toBeUndefined()
  await stopping
  await f.invoke()
  expect(f.observation()).toBeUndefined()
  f.emit({ event: 'chat.gpu.ready', loadMs: 10 }, 1)
  expect(f.observation()!.loadMs).toBe(10)
  await f.runtime.bind(inferenceBindingSchema.parse({ runtime: 'first', resources: [], configuration: { context: 4096 } }))
  expect(f.runtime.status()[0]!.instances).toEqual([])
  await f.invoke()
  expect(f.observation()).toBeUndefined()
})

it('does not report a stopped inner engine as live or retain a recovered request error', async () => {
  const f = await fixture()
  await f.invoke()
  f.emit({ event: 'chat.gpu.ready', backend: { requested: 'cuda', observed: ['cuda'] }, context: { actual: 65536 }, offload: { layers: 25, total: 25 } })
  f.emit({ event: 'chat.gpu.error', code: 'EXTENSION_INFERENCE_RESOURCE_EXHAUSTED' })
  expect(f.observation()!.error).toBe('EXTENSION_INFERENCE_RESOURCE_EXHAUSTED')
  f.emit({ event: 'chat.gpu.invoke' })
  expect(f.observation()!.error).toBeUndefined()
  expect(f.observation()!.context!.actual).toBe(65536)
  f.emit({ event: 'chat.gpu.exit', code: 0, backend: { requested: 'cuda', observed: ['cuda'] }, context: { actual: 65536 } })
  expect(f.observation()).toBeUndefined()
  f.emit({ event: 'chat.gpu.exit', code: 'EXTENSION_INFERENCE_PROCESS_FAILED', context: { actual: 65536 } })
  expect(f.observation()).toEqual({ error: 'EXTENSION_INFERENCE_PROCESS_FAILED', observedAt: expect.any(Number) })
})

it('keeps legacy diagnostics compatible while bounding context counts and stripping unknown data', () => {
  expect(inferenceDiagnosticSchema.parse({ loadMs: 2 })).toEqual({ loadMs: 2 })
  expect(inferenceDiagnosticSchema.parse({ context: { actual: 1024, secret: 'private' } })).toEqual({ context: { actual: 1024 } })
  for (const actual of [0, -1, 1.5, 2147483648, Number.NaN])
    expect(inferenceDiagnosticSchema.safeParse({ context: { actual } }).success).toBe(false)
})

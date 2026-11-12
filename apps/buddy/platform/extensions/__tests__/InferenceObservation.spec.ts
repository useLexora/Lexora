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
  const reports: ApplicationDiagnosticReporter[] = []
  const changes: unknown[] = []
  vi.spyOn(NativeInferenceProcess, 'start').mockImplementation(async (options) => {
    reports.push(options.record!)
    const current = memoryInference({ record: options.record })
    native.push(current)
    return current.worker
  })
  const runtime = new ExtensionInference(store, pkg, { bootstrap: '', executable: '', admit: async () => async () => {}, record }, {
    response: async () => { throw new Error('Unexpected download') },
    openReference: async () => { throw new Error('Unexpected resource') },
  }, () => {}, () => changes.push('models-changed'))
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
  return { runtime, native, invoke, observation, emit, reports, changes }
}

it('projects successful deployment declarations without changing bindings, and retains sparse fields until the binding changes', async () => {
  const f = await fixture()
  const binding = inferenceBindingSchema.parse({ runtime: 'first', resources: [], models: [{
    id: 'local',
    title: 'Local',
    capability: 'first',
    tools: 'auto',
    reasoning: 'auto',
    contextWindow: 8192,
    maxTokens: 512,
    metadata: { toolCall: true, reasoningOptions: ['off', 'medium'], input: ['text', 'image'], contextWindow: 32768, maxTokens: 1024 },
  }] })
  await f.runtime.bind(binding)
  const before = (await f.runtime.models())[0]!
  await f.invoke()
  f.emit({ event: 'chat.gpu.ready', context: { actual: 16384 }, modelMetadata: { toolCall: false, contextWindow: 4096 } })
  const expected = { ...before, metadata: { ...before.metadata, toolCall: false, contextWindow: 4096 } }
  expect(await f.runtime.models()).toEqual([expected])
  expect(f.changes).toEqual(['models-changed'])
  f.emit({ event: 'chat.gpu.ready', modelMetadata: { reasoningOptions: [] } })
  expected.metadata.reasoningOptions = []
  expect(await f.runtime.models()).toEqual([expected])
  expect(f.changes).toHaveLength(2)
  f.emit({ event: 'chat.gpu.ready', modelMetadata: { reasoningOptions: [] } })
  f.emit({ event: 'chat.gpu.error', code: 'EXTENSION_INFERENCE_PROCESS_FAILED', modelMetadata: { toolCall: true } })
  f.emit({ event: 'chat.gpu.ready', modelMetadata: { toolCall: 'unknown' } })
  f.emit({ event: 'chat.gpu.ready', context: { actual: 65536, train: 262144 } })
  expect(await f.runtime.models()).toEqual([expected])
  expect(f.changes).toHaveLength(2)
  expect(f.native).toHaveLength(1)
  expect(binding.models[0]!.metadata?.toolCall).toBe(true)
  expect((await f.runtime.models())[0]!.bindingRevision).toBe(before.bindingRevision)
  await f.runtime.bind(binding)
  await f.invoke()
  expect(await f.runtime.models()).toEqual([expected])
  expect(f.native).toHaveLength(1)
  await f.runtime.stop({ runtime: 'first' })
  expect(await f.runtime.models()).toEqual([expected])
  await f.invoke()
  f.reports[0]!({ component: 'models.inference', extensionId: 'fixture.inference', event: 'chat.gpu.ready', level: 'info', inference: { modelMetadata: { toolCall: true } } })
  expect(await f.runtime.models()).toEqual([expected])
  f.emit({ event: 'chat.gpu.ready', modelId: 'local', modelMetadata: { input: ['text'] } }, 1)
  expected.metadata.input = ['text']
  expect(await f.runtime.models()).toEqual([expected])
  await f.runtime.bind({ ...binding, configuration: { engine: 'replacement' } })
  const replaced = (await f.runtime.models())[0]!
  expect(replaced.metadata).toEqual(before.metadata)
  expect(replaced.bindingRevision).not.toBe(before.bindingRevision)
  f.reports[1]!({ component: 'models.inference', extensionId: 'fixture.inference', event: 'chat.gpu.ready', level: 'info', inference: { modelId: 'local', modelMetadata: { toolCall: false } } })
  expect((await f.runtime.models())[0]).toEqual(replaced)
  await f.invoke()
  f.emit({ event: 'chat.gpu.ready', context: { actual: 4096 } }, 2)
  expect((await f.runtime.models())[0]).toEqual(replaced)
})

it('requires an exact model ID for multi-model deployment declarations and never changes sibling capabilities', async () => {
  const f = await fixture()
  const binding = inferenceBindingSchema.parse({ runtime: 'first', resources: [], models: ['one', 'two'].map(id => ({ id, title: id, capability: 'first', contextWindow: 8192, maxTokens: 512, tools: false })) })
  await f.runtime.bind(binding)
  const before = await f.runtime.models()
  await f.invoke()
  f.emit({ event: 'chat.gpu.ready', modelMetadata: { toolCall: true } })
  f.emit({ event: 'chat.gpu.ready', modelId: 'unknown', modelMetadata: { toolCall: true } })
  expect(await f.runtime.models()).toEqual(before)
  expect(f.changes).toEqual([])
  f.emit({ event: 'chat.gpu.ready', modelId: 'two', modelMetadata: { toolCall: true } })
  expect(await f.runtime.models()).toEqual([before[0], { ...before[1], metadata: { toolCall: true } }])
  await f.runtime.unbind({ runtime: 'first' })
  await f.runtime.bind(binding)
  expect(await f.runtime.models()).toEqual(before)
})

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

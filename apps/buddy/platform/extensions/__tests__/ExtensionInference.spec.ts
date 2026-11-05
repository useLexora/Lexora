import type { ExtensionInferencePorts } from '../ExtensionInference'
import type { InferenceResourceLease, InferenceResourceSource } from '../ExtensionInferenceResources'
import type { InferenceInvocation } from '../NativeInferenceProcess'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { inferenceBindingSchema } from '../../../shared/extensions/extensionInference'
import { ExtensionInference } from '../ExtensionInference'
import { ExtensionInferenceCredentials } from '../ExtensionInferenceCredentials'
import { NativeInferenceProcess } from '../NativeInferenceProcess'
import { createStore, manifest } from './fixtures'
import { invocation, memoryInference } from './inferenceFixtures'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

async function fixture(options: { idleTimeoutMs?: number, admit?: ExtensionInferencePorts['admit'] } = {}) {
  const { root, store } = await createStore()
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const owner = 'tests.models'
  const contribution = manifest({
    id: owner,
    apiVersion: 3,
    permissions: { inference: true, inferenceNetwork: ['https://service.invalid'] },
    contributes: {
      inference: {
        runtimes: ['local', 'api'].map(id => ({ id, entry: 'native/fixture.mjs', platforms: ['linux-x64'], capacity: 1, idleTimeoutMs: options.idleTimeoutMs ?? 40 })),
        capabilities: ['local', 'api'].map(runtime => ({ id: runtime, title: runtime, kind: 'speech.transcribe', runtime })),
      },
    },
  })
  await store.install((await store.reviewFiles(new Map([
    ['extension.json', Buffer.from(JSON.stringify(contribution))],
    ['extension.js', Buffer.from('export function activate() {}')],
    ['native/fixture.mjs', Buffer.from('export function initialize() {}')],
  ]))).token)
  const pkg = store.installed[owner]!.current
  const bytes = Buffer.from('synthetic model')
  const source: InferenceResourceSource = {
    response: async () => new Response(bytes),
    openReference: async () => { throw new Error('No external references') },
  }
  const resource = await store.inference.prepare(owner, { id: 'model', kind: 'model', files: [{ path: 'model.bin', sha256: createHash('sha256').update(bytes).digest('hex'), source: { url: 'https://example.test/model' } }] }, source, new AbortController().signal, () => {})
  const native: ReturnType<typeof memoryInference>[] = []
  const leases: InferenceResourceLease[] = []
  vi.spyOn(NativeInferenceProcess, 'start').mockImplementation(async (_options, _store, _pkg, _runtime, _binding, acquired) => {
    const f = memoryInference()
    native.push(f)
    leases.push(...acquired)
    return f.worker
  })
  const secrets = new Map<string, unknown>()
  const credentials = new ExtensionInferenceCredentials({
    read: async id => secrets.get(id) ?? null,
    write: async (id, value) => { secrets.set(id, value) },
    delete: async (id) => { secrets.delete(id) },
  })
  await credentials.set(owner, { id: 'service', origin: 'https://service.invalid', token: 'synthetic-token' }, () => {})
  const runtime = new ExtensionInference(store, pkg, { sandbox: '', executable: '', bootstrap: '', credentials, admit: options.admit ?? (async () => async () => {}) }, source, () => {})
  const pending: Promise<void>[] = []
  cleanups.push(async () => {
    for (const f of native) f.close()
    await runtime.dispose()
    await Promise.allSettled(pending)
    await Promise.all(native.map(f => f.reading))
  })
  const bindings = ['local', 'api'].map(id => inferenceBindingSchema.parse({
    runtime: id,
    resources: [{ mount: 'model', id: resource.id, revision: resource.revision }],
    endpoints: id === 'api' ? [{ id: 'service', url: 'https://service.invalid/transcribe', contentType: 'application/json', credential: 'service' }] : [],
  }))
  for (const binding of bindings) await runtime.bind(binding)
  const invoke = (id: string, input: Partial<InferenceInvocation> = {}) => {
    const capability = pkg.manifest.contributes.inference!.capabilities.find(item => item.id === id)!
    const call = runtime.invoke(capability, invocation({ id: randomUUID(), capability: id, ...input }))
    pending.push(call)
    void call.catch(() => {})
    return call
  }
  return { runtime, native, leases, bindings, invoke, credentials, owner }
}

it('does not install an idle timer across admission of a second active call', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const admitting = Promise.withResolvers<void>()
  const admission = Promise.withResolvers<() => Promise<void>>()
  const f = await fixture({ admit: (_owner, id) => {
    if (id === 'second') {
      admitting.resolve()
      return admission.promise
    }
    return Promise.resolve(async () => {})
  } })
  const firstReady = Promise.withResolvers<void>()
  const firstGate = Promise.withResolvers<void>()
  const first = f.invoke('local', { ready: () => {
    firstReady.resolve()
    return firstGate.promise
  } })
  await firstReady.promise
  const secondReady = Promise.withResolvers<void>()
  const secondGate = Promise.withResolvers<void>()
  const events: unknown[] = []
  const second = f.invoke('local', {
    id: 'second',
    ready: () => {
      secondReady.resolve()
      return secondGate.promise
    },
    event(data) { events.push(data) },
  })
  await admitting.promise
  const worker = f.native[0]!.worker
  vi.spyOn(worker, 'stopped', 'get').mockImplementationOnce(() => {
    admission.resolve(async () => {})
    return false
  })
  firstGate.resolve()
  await first
  await secondReady.promise
  await vi.advanceTimersByTimeAsync(80)
  expect(f.runtime.status()[0]!.instances).toEqual([{ id: worker.instanceId, state: 'ready', active: 1, pending: 0, cancelling: 0 }])
  expect(f.leases[0]!.files[0]!.handle.fd).toBeGreaterThanOrEqual(0)
  secondGate.resolve()
  await second
  expect(events).toEqual([{ size: 0, input: {} }])
  await vi.advanceTimersByTimeAsync(40)
  expect(worker.stopped).toBe(true)
  await f.runtime.stop({ runtime: 'local' })
  expect(f.runtime.status()[0]).toMatchObject({ configured: true, instances: [] })
  expect(f.leases[0]!.files[0]!.handle.fd).toBe(-1)
  const resumed: unknown[] = []
  await f.invoke('local', {
    event(data) { resumed.push(data) },
  })
  expect(resumed).toEqual([{ size: 0, input: {} }])
  expect(f.native[1]!.worker.instanceId).not.toBe(worker.instanceId)
})

it.each(['stop', 'unbind', 'replace credential', 'remove credential'] as const)('%s drains only the targeted runtime and its queued calls', async (operation) => {
  const f = await fixture()
  const localReady = Promise.withResolvers<void>()
  const apiReady = Promise.withResolvers<void>()
  const localGate = Promise.withResolvers<void>()
  const apiGate = Promise.withResolvers<void>()
  const events: unknown[] = []
  const local = f.invoke('local', {
    ready: () => {
      localReady.resolve()
      return localGate.promise
    },
    event(data) { events.push(data) },
  })
  const api = f.invoke('api', { ready: () => {
    apiReady.resolve()
    return apiGate.promise
  } })
  const apiCancelled = expect(api).rejects.toThrow('EXTENSION_INFERENCE_CANCELLED')
  await Promise.all([localReady.promise, apiReady.promise])
  const queuedLocal = f.invoke('local', {
    event(data) { events.push(data) },
  })
  const queuedApi = f.invoke('api')
  const queuedCancelled = expect(queuedApi).rejects.toThrow('EXTENSION_INFERENCE_CANCELLED')
  await vi.waitFor(() => expect(f.runtime.status().map(item => item.instances[0]?.pending)).toEqual([1, 1]))
  const localId = f.runtime.status()[0]!.instances[0]!.id
  if (operation === 'unbind') {
    await f.runtime.unbind({ runtime: 'api' })
  }
  else if (operation === 'replace credential' || operation === 'remove credential') {
    await f.runtime.withStoppedCredential('service', async () => {
      await expect(f.invoke('api')).rejects.toThrow('EXTENSION_INFERENCE_STOPPING')
      await expect(f.runtime.bind(f.bindings[1]!)).rejects.toThrow('EXTENSION_INFERENCE_STOPPING')
      expect(f.runtime.status()[0]!.instances[0]).toMatchObject({ id: localId, active: 1 })
      if (operation === 'remove credential')
        await f.credentials.remove(f.owner, 'service', () => {})
      else
        await f.credentials.set(f.owner, { id: 'service', origin: 'https://service.invalid', token: 'replacement-token' }, () => {})
    })
  }
  else {
    await f.runtime.stop({ runtime: 'api' })
  }
  await Promise.all([apiCancelled, queuedCancelled])
  expect(f.runtime.status()[0]!.instances[0]).toMatchObject({ id: localId, state: 'ready', active: 1, pending: 1 })
  expect(f.runtime.status()[1]).toMatchObject({ configured: operation !== 'unbind', instances: [] })
  if (operation === 'unbind') {
    await expect(f.invoke('api')).rejects.toThrow('EXTENSION_INFERENCE_SETUP_REQUIRED')
    await f.runtime.bind(f.bindings[1]!)
  }
  if (operation === 'remove credential') {
    await expect(f.invoke('api')).rejects.toThrow('EXTENSION_INFERENCE_CREDENTIAL_UNAVAILABLE')
    await f.credentials.set(f.owner, { id: 'service', origin: 'https://service.invalid', token: 'restored-token' }, () => {})
  }
  localGate.resolve()
  await Promise.all([local, queuedLocal])
  expect(events).toEqual([{ size: 0, input: {} }, { size: 0, input: {} }])
  const resumed: unknown[] = []
  await f.invoke('api', {
    event(data) { resumed.push(data) },
  })
  expect(resumed).toEqual([{ size: 0, input: {} }])
})

it('rejects an old binding after waiting for a retiring instance during rebind', async () => {
  const admitted = Promise.withResolvers<void>()
  const f = await fixture({ idleTimeoutMs: 0, admit: async (_owner, id) => {
    if (id === 'waiting')
      admitted.resolve()
    return async () => {}
  } })
  const ready = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const first = f.invoke('local', { ready: () => {
    ready.resolve()
    return finish.promise
  } })
  await ready.promise
  const worker = f.native[0]!.worker
  const stop = worker.stop.bind(worker)
  const stopping = Promise.withResolvers<void>()
  const releaseStop = Promise.withResolvers<void>()
  vi.spyOn(worker, 'stop').mockImplementation(async () => {
    stopping.resolve()
    await releaseStop.promise
    await stop()
  })
  finish.resolve()
  await stopping.promise
  const waiting = f.invoke('local', { id: 'waiting' })
  const rejected = expect(waiting).rejects.toThrow('EXTENSION_INFERENCE_CONFIGURATION_CHANGED')
  await admitted.promise
  await Promise.resolve()
  const binding = { ...f.bindings[0]!, configuration: { revision: 'new' } }
  const rebind = f.runtime.bind(binding)
  await vi.waitFor(() => expect(f.runtime.status()[0]!.configured).toBe(false))
  releaseStop.resolve()
  await Promise.all([first, rebind, rejected])
  expect(f.runtime.status()[0]).toMatchObject({ configured: true, instances: [] })
  expect(f.native).toHaveLength(1)
  const events: unknown[] = []
  await f.invoke('local', {
    input: { revision: 'new' },
    event(data) { events.push(data) },
  })
  expect(events).toEqual([{ size: 0, input: { revision: 'new' } }])
})

import type { InferenceBinding, InferenceCapability, InferenceHardware, InferenceObservation, InferenceRuntimeReference } from '../../shared/extensions/extensionInference'
import type { DiscoveredModelMetadata } from '../../shared/providers/providerDiscovery'
import type { ExtensionInferenceCredentials } from './ExtensionInferenceCredentials'
import type { InferenceResourceLease, InferenceResourceSource } from './ExtensionInferenceResources'
import type { ExtensionPackage, ExtensionPackageStore } from './ExtensionPackageStore'
import type { InferenceInvocation, NativeInferenceOptions } from './NativeInferenceProcess'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import process from 'node:process'
import { safeDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import { inferenceDiagnosticCodeSchema, inferenceStderrDiagnosticSchema } from '../../shared/diagnostics/inferenceDiagnostic'
import { inferenceBindingSchema, inferenceLimits, inferenceNetworkOptionsSchema, inferenceObservationSchema } from '../../shared/extensions/extensionInference'
import { ExtensionInvocationQueue } from '../../shared/extensions/ExtensionInvocationQueue'
import { supportsInferenceRuntime } from '../../shared/extensions/inferencePlatform'
import { NativeInferenceProcess, waitForInference } from './NativeInferenceProcess'

export interface ExtensionInferencePorts extends NativeInferenceOptions {
  hardware?: (includeGpu: boolean) => Promise<InferenceHardware | undefined>
  credentials?: ExtensionInferenceCredentials
  request?: (url: string, input: { method: 'POST', headers: Record<string, string>, body: Uint8Array, signal: AbortSignal }) => Promise<Response>
  admit: (extensionId: string, invocationId: string, signal: AbortSignal, parentInvocationId?: string) => Promise<() => Promise<void>>
}
interface Instance {
  abort: AbortController
  runtime: string
  ready: Promise<NativeInferenceProcess>
  worker?: NativeInferenceProcess
  observation: { current?: InferenceObservation }
  capacity: ExtensionInvocationQueue
  waiters: number
  active: number
  leases: InferenceResourceLease[]
  idle?: ReturnType<typeof setTimeout>
  stopping?: Promise<void>
}
interface RuntimeLifetime {
  abort: AbortController
  stopping?: Promise<void>
}
export class ExtensionInference {
  readonly #bindings = new Map<string, InferenceBinding>()
  readonly #modelMetadata = new WeakMap<InferenceBinding, Map<string, DiscoveredModelMetadata>>()
  readonly #modelsChanged: () => void
  readonly #instances = new Map<string, Instance>()
  readonly #calls = new Set<Promise<void>>()
  readonly #rebinding = new Set<string>()
  readonly #runtimeLifetimes = new Map<string, RuntimeLifetime>()
  readonly #credentialChanges = new Set<string>()
  #resourceChange = false
  #epoch = 0
  #resetting: Promise<void> | undefined
  readonly #stop = new AbortController()
  readonly store: ExtensionPackageStore
  readonly pkg: ExtensionPackage
  readonly ports: ExtensionInferencePorts
  readonly source: InferenceResourceSource
  readonly assertCurrent: () => void
  constructor(store: ExtensionPackageStore, pkg: ExtensionPackage, ports: ExtensionInferencePorts, source: InferenceResourceSource, assertCurrent: () => void, modelsChanged: () => void = () => {}) {
    this.store = store
    this.pkg = pkg
    this.ports = ports
    this.source = source
    this.assertCurrent = assertCurrent
    this.#modelsChanged = modelsChanged
  }

  async prepareResources(...[files, options, signal, event]: Parameters<NonNullable<InferenceResourceSource['prepare']>>): Promise<void> {
    const preparation = this.pkg.manifest.contributes.inference?.preparation
    if (!preparation)
      throw new Error('EXTENSION_INFERENCE_PREPARATION_UNAVAILABLE')
    this.assertCurrent()
    const lifetime = AbortSignal.any([signal, this.#stop.signal])
    const binding = inferenceBindingSchema.parse({ runtime: 'prepare', resources: [{ mount: 'inputs', id: 'inputs', revision: '0'.repeat(64) }] })
    const worker = await NativeInferenceProcess.start({ ...this.ports, network: undefined }, this.store, this.pkg, { ...preparation, id: 'prepare', gpu: false, capacity: 1 }, binding, [{ files, release: async () => {} }], AbortSignal.any([lifetime, AbortSignal.timeout(inferenceLimits.startTimeoutMs)]))
    try {
      const bytes = Buffer.from(JSON.stringify(options))
      await worker.invoke({
        id: randomUUID(),
        capability: 'resources.prepare',
        input: {},
        signal: lifetime,
        event,
        chunks: (async function* () {
          for (let offset = 0; offset < bytes.length; offset += inferenceLimits.chunkBytes)
            yield bytes.subarray(offset, offset + inferenceLimits.chunkBytes)
        })(),
      })
      this.assertCurrent()
    }
    finally { await worker.stop() }
  }

  async bind(raw: InferenceBinding): Promise<void> {
    const binding = inferenceBindingSchema.parse(raw)
    if (!this.pkg.manifest.contributes.inference?.runtimes.some(runtime => runtime.id === binding.runtime))
      throw new Error('EXTENSION_INFERENCE_RUNTIME_UNAVAILABLE')
    this.assertCurrent()
    if (binding.endpoints.some(endpoint => !this.pkg.manifest.permissions.inferenceNetwork.includes(new URL(endpoint.url).origin)))
      throw new Error('EXTENSION_INFERENCE_NETWORK_DENIED')
    const capabilities = this.pkg.manifest.contributes.inference!.capabilities
    for (const [field, kind] of [['models', 'chat.completion'], ['imageModels', 'image.generate'], ['imageReaders', 'image.read']] as const) {
      const models = binding[field]
      const ids = new Set(models.map(model => model.id))
      if (ids.size !== models.length || models.some(model => !capabilities.some(capability => capability.kind === kind && capability.id === model.capability && capability.runtime === binding.runtime)) || [...this.#bindings.values()].some(current => current.runtime !== binding.runtime && current[field].some(model => ids.has(model.id))))
        throw new Error('EXTENSION_INFERENCE_MODEL_INVALID')
    }
    if (this.#rebinding.has(binding.runtime) || this.#resourceChange || this.#resetting || this.#runtimeLifetimes.get(binding.runtime)?.stopping)
      throw new Error('EXTENSION_INFERENCE_STOPPING')
    this.#rebinding.add(binding.runtime)
    try {
      const resources = await this.store.inference.list(this.pkg.manifest.id)
      this.assertCurrent()
      if (binding.resources.some(item => !resources.some(resource => resource.id === item.id && resource.revision === item.revision)))
        throw new Error('EXTENSION_INFERENCE_NOT_CONFIGURED')
      this.#assertCredentialStable(binding)
      if (JSON.stringify(this.#bindings.get(binding.runtime)) === JSON.stringify(binding))
        return
      this.#bindings.delete(binding.runtime)
      await Promise.all([...this.#instances].filter(([, instance]) => instance.runtime === binding.runtime).map(([key, instance]) => this.#retire(key, instance, new Error('EXTENSION_INFERENCE_CONFIGURATION_CHANGED'))))
      this.#stop.signal.throwIfAborted()
      this.assertCurrent()
      this.#assertCredentialStable(binding)
      this.#bindings.set(binding.runtime, binding)
    }
    finally {
      this.#rebinding.delete(binding.runtime)
    }
  }

  async #availableResources() {
    const id = this.pkg.manifest.id
    const local = this.pkg.manifest.permissions.localResources
    const [files, directories] = await Promise.all([this.store.resources.list(id, local), local ? this.store.resources.directories(id) : []])
    return this.store.inference.available(id, new Set(files.map(file => file.id)), new Set(directories.map(directory => directory.id)))
  }

  async #availableBindings() {
    const resources = await this.#availableResources()
    const bindings = await Promise.all([...this.#bindings.values()].map(async (binding) => {
      const runtime = this.pkg.manifest.contributes.inference!.runtimes.find(runtime => runtime.id === binding.runtime)
      if (!runtime || !supportsInferenceRuntime(runtime, process.platform, process.arch))
        return []
      if (binding.resources.some(item => !resources.some(resource => resource.id === item.id && resource.revision === item.revision)))
        return []
      try {
        await this.#assertCredentials(binding)
        return [binding]
      }
      catch { return [] }
    }))
    this.assertCurrent()
    return bindings.flat().filter(binding => this.#bindings.get(binding.runtime) === binding)
  }

  async speechModels() {
    return (await this.#availableBindings()).flatMap(binding => this.pkg.manifest.contributes.inference!.capabilities
      .filter(capability => capability.runtime === binding.runtime && (capability.kind === 'speech.transcribe' || capability.kind === 'speech.synthesize'))
      .map(capability => ({ ...capability, bindingRevision: createHash('sha256').update(JSON.stringify(binding)).digest('hex') })))
  }

  async models() {
    return (await this.#availableBindings()).flatMap(binding => binding.models.map((model) => {
      const declared = this.#modelMetadata.get(binding)?.get(model.id)
      const metadata = model.metadata || declared ? { ...model.metadata, ...declared } : undefined
      if (metadata?.contextWindow !== undefined && metadata.maxTokens !== undefined)
        metadata.maxTokens = Math.min(metadata.maxTokens, metadata.contextWindow)
      return { ...model, ...(metadata ? { metadata: structuredClone(metadata) } : {}), bindingRevision: createHash('sha256').update(JSON.stringify(binding)).digest('hex') }
    }))
  }

  #acceptModelMetadata(binding: InferenceBinding, observation: InferenceObservation): void {
    const model = observation.modelId === undefined
      ? binding.models.length === 1 ? binding.models[0] : undefined
      : binding.models.find(model => model.id === observation.modelId)
    if (!model || !observation.modelMetadata)
      return
    this.assertCurrent()
    const models = this.#modelMetadata.get(binding) ?? new Map<string, DiscoveredModelMetadata>()
    const previous = models.get(model.id)
    const metadata = { ...previous }
    for (const [key, value] of Object.entries(observation.modelMetadata)) {
      if (value !== undefined)
        Object.assign(metadata, { [key]: value })
    }
    if (!Object.keys(metadata).length || JSON.stringify(previous) === JSON.stringify(metadata))
      return
    models.set(model.id, metadata)
    this.#modelMetadata.set(binding, models)
    this.#modelsChanged()
  }

  async imageModels() {
    return (await this.#availableBindings()).flatMap(binding => binding.imageModels.map(model => ({ ...model, bindingRevision: createHash('sha256').update(JSON.stringify(binding)).digest('hex') })))
  }

  async imageReaders() {
    return (await this.#availableBindings()).flatMap(binding => binding.imageReaders.map(model => ({ ...model, bindingRevision: createHash('sha256').update(JSON.stringify(binding)).digest('hex') })))
  }

  async assertConfigured(runtime: string): Promise<void> {
    const binding = this.#bindings.get(runtime)
    if (!binding)
      throw new Error('EXTENSION_INFERENCE_NOT_CONFIGURED')
    const resources = await this.#availableResources()
    this.assertCurrent()
    if (this.#bindings.get(runtime) !== binding || binding.resources.some(item => !resources.some(resource => resource.id === item.id && resource.revision === item.revision)))
      throw new Error('EXTENSION_INFERENCE_NOT_CONFIGURED')
    await this.#assertCredentials(binding)
  }

  async #assertCredentials(binding: InferenceBinding) {
    this.#assertCredentialStable(binding)
    for (const endpoint of binding.endpoints) {
      if (endpoint.credential && !await this.ports.credentials?.has(this.pkg.manifest.id, { id: endpoint.credential, origin: new URL(endpoint.url).origin }))
        throw new Error('EXTENSION_INFERENCE_CREDENTIAL_UNAVAILABLE')
    }
  }

  #assertCredentialStable(binding: InferenceBinding): void {
    if (binding.endpoints.some(endpoint => endpoint.credential && this.#credentialChanges.has(endpoint.credential)))
      throw new Error('EXTENSION_INFERENCE_STOPPING')
  }

  async withStoppedCredential<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.#credentialChanges.has(id) || this.#resourceChange || this.#resetting)
      throw new Error('EXTENSION_INFERENCE_STOPPING')
    this.#credentialChanges.add(id)
    try {
      const runtimes = [...this.#bindings.values()].filter(binding => binding.endpoints.some(endpoint => endpoint.credential === id)).map(binding => binding.runtime)
      await Promise.all(runtimes.map(runtime => this.#stopRuntime(runtime)))
      return await operation()
    }
    finally { this.#credentialChanges.delete(id) }
  }

  forgetResource(id: string, revision: string): void {
    for (const [runtime, binding] of this.#bindings) {
      if (binding.resources.some(resource => resource.id === id && resource.revision === revision))
        this.#bindings.delete(runtime)
    }
  }

  status() {
    return (this.pkg.manifest.contributes.inference?.runtimes ?? []).map(runtime => ({
      runtime: runtime.id,
      configured: this.#bindings.has(runtime.id),
      platforms: runtime.platforms,
      instances: [...this.#instances.values()].filter(instance => instance.runtime === runtime.id).map(instance => ({
        id: instance.worker?.instanceId ?? null,
        state: instance.stopping ? 'stopping' : instance.worker?.stopped ? 'stopped' : instance.worker ? 'ready' : 'loading',
        active: instance.active,
        pending: instance.waiters - instance.active,
        cancelling: instance.worker?.cancelling ?? 0,
        ...(!instance.abort.signal.aborted && !instance.worker?.stopped && instance.observation.current ? { observation: structuredClone(instance.observation.current) } : {}),
      })),
    }))
  }

  async withStoppedResources<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#resourceChange || this.#credentialChanges.size)
      throw new Error('EXTENSION_INFERENCE_STOPPING')
    this.#resourceChange = true
    try {
      await this.reset()
      return await operation()
    }
    finally { this.#resourceChange = false }
  }

  invoke(capability: InferenceCapability, input: InferenceInvocation): Promise<void> {
    const pending = this.#invoke(capability, input).finally(() => this.#calls.delete(pending))
    this.#calls.add(pending)
    return pending
  }

  async #invoke(capability: InferenceCapability, input: InferenceInvocation): Promise<void> {
    const epoch = this.#epoch
    if (this.#resetting || this.#resourceChange || this.#rebinding.has(capability.runtime) || this.#runtimeLifetimes.get(capability.runtime)?.stopping)
      throw new Error('EXTENSION_INFERENCE_STOPPING')
    const signal = AbortSignal.any([input.signal, this.#stop.signal, this.#runtimeLifetime(capability.runtime).abort.signal])
    signal.throwIfAborted()
    this.assertCurrent()
    const binding = this.#bindings.get(capability.runtime)
    const runtime = this.pkg.manifest.contributes.inference?.runtimes.find(item => item.id === capability.runtime)
    if (!binding || !runtime)
      throw new Error('EXTENSION_INFERENCE_SETUP_REQUIRED')
    if (input.bindingRevision && input.bindingRevision !== createHash('sha256').update(JSON.stringify(binding)).digest('hex'))
      throw new Error('EXTENSION_INFERENCE_CONFIGURATION_CHANGED')
    await this.#assertCredentials(binding)
    signal.throwIfAborted()
    const release = await this.ports.admit(this.pkg.manifest.id, input.id, signal, input.parentInvocationId)
    try {
      signal.throwIfAborted()
      this.assertCurrent()
      if (epoch !== this.#epoch || this.#bindings.get(capability.runtime) !== binding)
        throw new Error('EXTENSION_INFERENCE_CONFIGURATION_CHANGED')
      const key = createHash('sha256').update(JSON.stringify(binding)).digest('hex')
      let instance = this.#instances.get(key)
      while (instance?.stopping) {
        await waitForInference(instance.stopping, signal)
        instance = this.#instances.get(key)
      }
      signal.throwIfAborted()
      this.assertCurrent()
      if (epoch !== this.#epoch || this.#bindings.get(capability.runtime) !== binding)
        throw new Error('EXTENSION_INFERENCE_CONFIGURATION_CHANGED')
      if (this.#resetting || this.#resourceChange || this.#rebinding.has(capability.runtime) || this.#runtimeLifetimes.get(capability.runtime)?.stopping)
        throw new Error('EXTENSION_INFERENCE_STOPPING')
      this.#assertCredentialStable(binding)
      if (!instance) {
        const abort = new AbortController()
        const leases: InferenceResourceLease[] = []
        const observation: Instance['observation'] = {}
        const loading = AbortSignal.any([abort.signal, this.#stop.signal, AbortSignal.timeout(inferenceLimits.startTimeoutMs)])
        const ready = Promise.resolve().then(async () => {
          for (const resource of binding.resources)
            leases.push(await this.store.inference.acquire(this.pkg.manifest.id, resource, this.source, loading))
          this.assertCurrent()
          return NativeInferenceProcess.start({ ...this.ports, record: (event) => {
            safeDiagnosticReporter(this.ports.record)(event)
            if (abort.signal.aborted || this.#bindings.get(binding.runtime) !== binding || this.#instances.get(key)?.abort !== abort || event.component !== 'models.inference' || event.extensionId !== this.pkg.manifest.id || !inferenceStderrDiagnosticSchema.shape.event.safeParse(event.event).success)
              return
            const error = inferenceDiagnosticCodeSchema.safeParse(event.errorCode)
            if (event.event === 'chat.gpu.exit') {
              observation.current = error.success ? { error: error.data, observedAt: Date.now() } : undefined
              return
            }
            if (event.event === 'chat.gpu.start')
              observation.current = undefined
            if (event.event === 'chat.gpu.invoke' && observation.current)
              delete observation.current.error
            const parsed = inferenceObservationSchema.safeParse({ ...event.inference, ...(error.success ? { error: error.data } : {}), observedAt: Date.now() })
            if (!parsed.success || Object.keys(parsed.data).length === 1)
              return
            if (event.event === 'chat.gpu.ready')
              this.#acceptModelMetadata(binding, parsed.data)
            const previous = observation.current
            observation.current = {
              ...previous,
              ...parsed.data,
              ...(parsed.data.context ? { context: { ...previous?.context, ...parsed.data.context } } : {}),
              ...(parsed.data.timings ? { timings: { ...previous?.timings, ...parsed.data.timings } } : {}),
            }
          }, network: async (name, body, signal, rawOptions) => {
            const endpoint = binding.endpoints.find(item => item.id === name)
            this.assertCurrent()
            if (!endpoint || !this.ports.request)
              throw new Error('EXTENSION_INFERENCE_NETWORK_DENIED')
            const options = inferenceNetworkOptionsSchema.parse(rawOptions ?? {})
            if ((endpoint.contentType === 'multipart/form-data') !== !!options.contentType)
              throw new Error('EXTENSION_INFERENCE_NETWORK_DENIED')
            const headers: Record<string, string> = { 'Content-Type': options.contentType ?? endpoint.contentType }
            if (endpoint.credential) {
              if (!this.ports.credentials)
                throw new Error('EXTENSION_INFERENCE_CREDENTIAL_UNAVAILABLE')
              headers.Authorization = await this.ports.credentials.authorize(this.pkg.manifest.id, { id: endpoint.credential, origin: new URL(endpoint.url).origin })
            }
            signal.throwIfAborted()
            this.assertCurrent()
            return this.ports.request(endpoint.url, { method: 'POST', headers, body, signal })
          } }, this.store, this.pkg, runtime, binding, leases, loading)
        })
        const created: Instance = { abort, runtime: runtime.id, ready, observation, capacity: new ExtensionInvocationQueue({ concurrent: runtime.capacity, concurrentPerExtension: runtime.capacity, queued: 1024 }), waiters: 0, active: 0, leases }
        instance = created
        this.#instances.set(key, created)
        void ready.then((worker) => {
          created.worker = worker
        }, (error: unknown) => {
          void this.#retire(key, created, error).catch(() => {
          })
        })
      }
      clearTimeout(instance.idle)
      instance.waiters++
      const lifetime = AbortSignal.any([signal, instance.abort.signal])
      let capacity: (() => void) | undefined
      try {
        const worker = await waitForInference(instance.ready, lifetime)
        capacity = await instance.capacity.acquire(this.pkg.manifest.id, input.id, lifetime)
        lifetime.throwIfAborted()
        this.assertCurrent()
        instance.active++
        try {
          await worker.invoke({ ...input, signal: lifetime })
        }
        finally {
          instance.active--
        }
      }
      finally {
        capacity?.()
        instance.waiters--
        if (!instance.waiters && !instance.active) {
          if (runtime.idleTimeoutMs === 0 || lifetime.aborted || !instance.worker || instance.worker.stopped) {
            await this.#retire(key, instance)
          }
          else {
            const idle = instance
            instance.idle = setTimeout(() => {
              if (!idle.waiters && !idle.active) {
                void this.#retire(key, idle).catch(() => {
                })
              }
            }, runtime.idleTimeoutMs ?? 60000)
          }
        }
      }
    }
    finally {
      await release()
    }
  }

  async #retire(key: string, instance: Instance, reason?: unknown): Promise<void> {
    return instance.stopping ??= (async () => {
      clearTimeout(instance.idle)
      instance.abort.abort(reason)
      const worker = await instance.ready.catch(() => undefined)
      await worker?.stop()
      await Promise.all(instance.leases.splice(0).map(lease => lease.release()))
      if (this.#instances.get(key) === instance)
        this.#instances.delete(key)
    })()
  }

  #runtimeLifetime(runtime: string): RuntimeLifetime {
    let lifetime = this.#runtimeLifetimes.get(runtime)
    if (!lifetime) {
      lifetime = { abort: new AbortController() }
      this.#runtimeLifetimes.set(runtime, lifetime)
    }
    return lifetime
  }

  #stopRuntime(runtime: string): Promise<void> {
    const lifetime = this.#runtimeLifetime(runtime)
    return lifetime.stopping ??= Promise.resolve().then(async () => {
      lifetime.abort.abort(new Error('EXTENSION_INFERENCE_CANCELLED'))
      await Promise.all([...this.#instances].filter(([, instance]) => instance.runtime === runtime).map(([key, instance]) => this.#retire(key, instance)))
    }).finally(() => {
      if (this.#runtimeLifetimes.get(runtime) === lifetime)
        this.#runtimeLifetimes.delete(runtime)
    })
  }

  async stop(input?: InferenceRuntimeReference): Promise<void> {
    if (!input)
      return this.reset()
    if (!this.pkg.manifest.contributes.inference?.runtimes.some(runtime => runtime.id === input.runtime))
      throw new Error('EXTENSION_INFERENCE_RUNTIME_UNAVAILABLE')
    this.assertCurrent()
    await (this.#resetting ?? this.#stopRuntime(input.runtime))
  }

  async unbind(input: InferenceRuntimeReference): Promise<void> {
    if (!this.pkg.manifest.contributes.inference?.runtimes.some(runtime => runtime.id === input.runtime))
      throw new Error('EXTENSION_INFERENCE_RUNTIME_UNAVAILABLE')
    this.assertCurrent()
    if (this.#rebinding.has(input.runtime) || this.#resourceChange || this.#resetting)
      throw new Error('EXTENSION_INFERENCE_STOPPING')
    this.#rebinding.add(input.runtime)
    this.#bindings.delete(input.runtime)
    try {
      await this.#stopRuntime(input.runtime)
    }
    finally { this.#rebinding.delete(input.runtime) }
  }

  reset(): Promise<void> {
    if (this.#resetting)
      return this.#resetting
    this.#epoch++
    return this.#resetting = Promise.resolve().then(async () => {
      for (const lifetime of this.#runtimeLifetimes.values()) lifetime.abort.abort(new Error('EXTENSION_INFERENCE_CANCELLED'))
      await Promise.all([...this.#instances].map(([key, instance]) => this.#retire(key, instance)))
    }).finally(() => {
      this.#runtimeLifetimes.clear()
      this.#resetting = undefined
    })
  }

  async dispose(): Promise<void> {
    this.#stop.abort()
    this.#bindings.clear()
    await this.reset()
    await Promise.allSettled([...this.#calls])
  }
}

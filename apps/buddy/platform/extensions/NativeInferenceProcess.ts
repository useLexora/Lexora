import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { FileHandle } from 'node:fs/promises'
import type { InferenceBinding, InferenceRuntime } from '../../shared/extensions/extensionInference'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { InferenceResourceLease } from './ExtensionInferenceResources'
import type { ExtensionPackage, ExtensionPackageStore } from './ExtensionPackageStore'
import type { InferenceNetworkRequest } from './InferenceNetworkHost'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { inferenceLimits } from '../../shared/extensions/extensionInference'
import { supportsInferenceRuntime } from '../../shared/extensions/inferencePlatform'
import { InferenceNetworkHost } from './InferenceNetworkHost'
import { enqueueInferenceFrame, readInferenceFrames, writeInferenceFrame } from './inferenceWire'
import { prepareSupervisedInferenceLaunch } from './supervisedInferenceLaunch'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  void promise.catch(() => {
  })
  return { promise, resolve, reject }
}
function backendError(data: unknown): Error {
  return new Error(typeof data === 'string' && /^EXTENSION_INFERENCE_[A-Z_]{1,80}$/.test(data) ? data : 'EXTENSION_INFERENCE_BACKEND_FAILED')
}
export function waitForInference<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}
export interface InferenceInvocation {
  id: string
  generation?: string
  bindingRevision?: string
  parentInvocationId?: string
  capability: string
  input: JsonValue
  chunks?: AsyncIterable<Uint8Array>
  signal: AbortSignal
  ready?: () => void | Promise<void>
  event: (data: JsonValue, bytes: Uint8Array, signal: AbortSignal) => void | Promise<void>
}
interface Job {
  abort: AbortController
  signal: AbortSignal
  started: ReturnType<typeof deferred<void>>
  completed: ReturnType<typeof deferred<void>>
  accepted?: {
    sequence: number
    result: ReturnType<typeof deferred<void>>
  }
  event: InferenceInvocation['event']
  error?: unknown
  events: Set<Promise<void>>
}
export interface NativeInferenceOptions {
  sandbox?: string
  executable: string
  bootstrap: string
  supervisor?: string
  network?: InferenceNetworkRequest
}
export class NativeInferenceProcess {
  readonly instanceId = randomUUID()
  readonly #network: InferenceNetworkHost
  readonly #child: ChildProcessWithoutNullStreams
  readonly #jobs = new Map<string, Job>()
  readonly #ready = deferred<void>()
  readonly #closed = deferred<void>()
  #stopped = false
  #cancelTimer?: ReturnType<typeof setTimeout>
  #stopPromise?: Promise<void>
  private constructor(child: ChildProcessWithoutNullStreams, request?: InferenceNetworkRequest, dispose?: () => Promise<void>) {
    this.#child = child
    const network = this.#network = new InferenceNetworkHost(child.stdin, request)
    const fail = (error: unknown) => {
      this.#ready.reject(error)
      for (const job of this.#jobs.values()) {
        job.abort.abort(error)
        job.started.reject(error)
        job.accepted?.result.reject(error)
        job.completed.reject(error)
      }
    }
    child.stdin.on('error', fail)
    child.stderr.resume()
    child.on('error', fail)
    child.once('close', () => {
      this.#stopped = true
      clearTimeout(this.#cancelTimer)
      fail(new Error('EXTENSION_INFERENCE_PROCESS_EXITED'))
      void Promise.resolve().then(dispose).then(() => this.#closed.resolve(), error => this.#closed.reject(error))
    })
    void (async () => {
      for await (const { message, bytes } of readInferenceFrames(child.stdout)) {
        if (message.type === 'ready') {
          this.#ready.resolve()
          continue
        }
        if (message.type === 'fatal')
          throw backendError(message.data)
        const job = message.id ? this.#jobs.get(message.id) : undefined
        if (message.type.startsWith('network.') && message.id && (job || message.type === 'network.cancel')) {
          network.receive(message.id, message, bytes, job?.signal ?? AbortSignal.abort())
          continue
        }
        if (!job)
          throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
        if (message.type === 'started') {
          job.started.resolve()
        }
        else if (message.type === 'accepted') {
          if (!job.accepted || job.accepted.sequence !== message.sequence)
            throw new Error('EXTENSION_INFERENCE_SEQUENCE_INVALID')
          job.accepted.result.resolve()
        }
        else if (message.type === 'event') {
          if (!job.signal.aborted) {
            try {
              const delivery = Promise.resolve(job.event(message.data ?? null, bytes, job.signal))
              job.events.add(delivery)
              void delivery.finally(() => job.events.delete(delivery)).catch(() => {})
              await waitForInference(delivery, job.signal)
            }
            catch (error) {
              job.error = error
              job.abort.abort(error)
            }
          }
        }
        else if (['completed', 'cancelled', 'failed'].includes(message.type)) {
          const error = message.type === 'failed' ? backendError(message.data) : new Error('EXTENSION_INFERENCE_CALL_ENDED')
          if (message.type === 'failed')
            job.completed.reject(error)
          else
            job.completed.resolve()
          job.started.reject(error)
          job.accepted?.result.reject(error)
        }
        else {
          throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
        }
      }
    })().catch((error) => {
      fail(error)
      child.kill('SIGKILL')
    })
  }

  static async start(options: NativeInferenceOptions, store: ExtensionPackageStore, pkg: ExtensionPackage, runtime: InferenceRuntime, binding: InferenceBinding, leases: InferenceResourceLease[], signal: AbortSignal): Promise<NativeInferenceProcess> {
    if (!supportsInferenceRuntime(runtime, process.platform, process.arch))
      throw new Error('EXTENSION_INFERENCE_PLATFORM_UNSUPPORTED')
    signal.throwIfAborted()
    if (process.platform === 'win32' || process.platform === 'darwin')
      return this.#startSupervised(options, store, pkg, runtime, binding, leases, signal)
    if (!options.sandbox)
      throw new Error('EXTENSION_INFERENCE_SANDBOX_UNAVAILABLE')
    const temporary = await mkdtemp(join(tmpdir(), 'lexora-inference-'))
    const handles: FileHandle[] = []
    let worker: NativeInferenceProcess | undefined
    try {
      const bootstrap = join(temporary, 'runtime.mjs')
      await writeFile(bootstrap, options.bootstrap, { mode: 0o600 })
      const mounts: Array<{
        target: string
        handle: FileHandle
      }> = []
      for (const [path, hash] of Object.entries(pkg.hashes)) {
        signal.throwIfAborted()
        const handle = await open(join(store.packageRoot(pkg), path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        handles.push(handle)
        if (!(await handle.stat()).isFile() || createHash('sha256').update(await handle.readFile()).digest('hex') !== hash)
          throw new Error('EXTENSION_PACKAGE_CHANGED')
        mounts.push({ target: `/plugin/${path}`, handle })
      }
      const bootstrapHandle = await open(bootstrap, 'r')
      handles.push(bootstrapHandle)
      mounts.push({ target: '/bootstrap.mjs', handle: bootstrapHandle })
      leases.forEach((lease, index) => lease.files.forEach(file => mounts.push({ target: `/resources/${binding.resources[index]!.mount}/${file.path}`, handle: file.handle })))
      const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/plugin', '--tmpfs', '/resources', '--chdir', '/tmp', '--ro-bind', dirname(options.executable), '/runtime', '--setenv', 'ELECTRON_RUN_AS_NODE', '1', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin']
      if (runtime.gpu) {
        if (!pkg.manifest.permissions.inferenceGpu)
          throw new Error('EXTENSION_INFERENCE_GPU_DENIED')
        const names = (await readdir('/dev')).filter(name => /^nvidia(?:\d+|ctl|-uvm)$/.test(name)).map(name => `/dev/${name}`)
        const render = await readdir('/dev/dri').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT')
            return []
          throw error
        })
        names.push(...render.filter(name => /^renderD\d+$/.test(name)).map(name => `/dev/dri/${name}`))
        if (!names.length)
          throw new Error('EXTENSION_INFERENCE_GPU_UNAVAILABLE')
        for (const path of ['/sys/module/nvidia', '/sys/module/nvidia_uvm']) {
          const module = await lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT')
              return undefined
            throw error
          })
          if (module?.isDirectory())
            args.push('--ro-bind', path, path)
        }
        for (const path of names) {
          if (!(await lstat(path)).isCharacterDevice())
            throw new Error('EXTENSION_INFERENCE_GPU_UNAVAILABLE')
          args.push('--dev-bind', path, path)
        }
      }
      if (binding.libraryPaths.length)
        args.push('--setenv', 'LD_LIBRARY_PATH', binding.libraryPaths.map(item => `/resources/${item.mount}/${item.path}`).join(':'))
      mounts.forEach((mount, index) => args.push('--ro-bind', `/proc/self/fd/${index + 3}`, mount.target))
      args.push('--remount-ro', '/plugin', '--remount-ro', '/resources')
      args.push(`/runtime/${basename(options.executable)}`, '/bootstrap.mjs', `/plugin/${runtime.entry}`)
      signal.throwIfAborted()
      const child = spawn(options.sandbox, args, { stdio: ['pipe', 'pipe', 'pipe', ...mounts.map(mount => mount.handle.fd)], env: { PATH: '/usr/bin' } }) as ChildProcessWithoutNullStreams
      worker = new NativeInferenceProcess(child, options.network)
      const abort = () => {
        void worker!.stop()
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        await writeInferenceFrame(child.stdin, { type: 'initialize', data: { configuration: binding.configuration, resources: Object.fromEntries(binding.resources.map(item => [item.mount, `/resources/${item.mount}`])) } })
        await waitForInference(worker.#ready.promise, signal)
      }
      finally {
        signal.removeEventListener('abort', abort)
      }
      return worker
    }
    catch (error) {
      await worker?.stop()
      throw error
    }
    finally {
      await Promise.all(handles.map(handle => handle.close()))
      await rm(temporary, { recursive: true, force: true })
    }
  }

  static async #startSupervised(options: NativeInferenceOptions, store: ExtensionPackageStore, pkg: ExtensionPackage, runtime: InferenceRuntime, binding: InferenceBinding, leases: InferenceResourceLease[], signal: AbortSignal): Promise<NativeInferenceProcess> {
    if (!options.supervisor || !isAbsolute(options.supervisor) || !isAbsolute(options.executable))
      throw new Error('EXTENSION_INFERENCE_SUPERVISION_UNAVAILABLE')
    const launch = await prepareSupervisedInferenceLaunch(options.bootstrap, store, pkg, runtime, binding, leases, signal)
    let worker: NativeInferenceProcess | undefined
    try {
      signal.throwIfAborted()
      const child = spawn(options.supervisor, ['--supervise-inference'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: launch.directory,
        env: process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot, TEMP: launch.directory, TMP: launch.directory }
          : { HOME: launch.directory, TMPDIR: launch.directory, PATH: '/usr/bin:/bin' },
      })
      worker = new NativeInferenceProcess(child, options.network, launch.dispose)
      const abort = () => {
        void worker!.stop().catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        child.stdin.write(`${JSON.stringify({ executable: options.executable, directory: launch.directory, entry: runtime.entry, libraryPaths: launch.libraryPaths, parentPid: process.pid })}\n`)
        await writeInferenceFrame(child.stdin, { type: 'initialize' })
        await waitForInference(worker.#ready.promise, signal)
      }
      finally { signal.removeEventListener('abort', abort) }
      return worker
    }
    catch (error) {
      if (worker)
        await worker.stop()
      else
        await launch.dispose()
      throw error
    }
  }

  get cancelling(): number {
    return [...this.#jobs.values()].filter(job => job.signal.aborted).length
  }

  get stopped(): boolean {
    return this.#stopped
  }

  async invoke(input: InferenceInvocation): Promise<void> {
    input.signal.throwIfAborted()
    if (this.#stopped || this.#stopPromise || this.#jobs.has(input.id))
      throw new Error('EXTENSION_INFERENCE_PROCESS_UNAVAILABLE')
    const dispatch = enqueueInferenceFrame(this.#child.stdin, { type: 'start', id: input.id, data: { capability: input.capability, input: input.input } })
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, input.signal])
    const job: Job = { abort, signal, started: deferred(), completed: deferred(), event: input.event, events: new Set() }
    this.#jobs.set(input.id, job)
    this.#updateCancelTimer()
    const cancel = () => {
      void writeInferenceFrame(this.#child.stdin, { type: 'cancel', id: input.id }).catch(() => {
      })
      this.#updateCancelTimer()
    }
    let error: unknown
    let iterator: AsyncIterator<Uint8Array> | undefined
    try {
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted)
        cancel()
      await dispatch
      await waitForInference(job.started.promise, signal)
      await waitForInference(Promise.resolve(input.ready?.()), signal)
      iterator = input.chunks?.[Symbol.asyncIterator]()
      let sequence = 0
      while (true) {
        if (!iterator)
          break
        const item = await waitForInference(iterator.next(), signal)
        if (item.done)
          break
        const result = deferred<void>()
        job.accepted = { sequence, result }
        await writeInferenceFrame(this.#child.stdin, { type: 'input', id: input.id, sequence: sequence++ }, item.value)
        await waitForInference(result.promise, signal)
      }
    }
    catch (failure) {
      error = failure
      abort.abort(failure)
    }
    finally {
      void iterator?.return?.().catch(() => {
      })
      await writeInferenceFrame(this.#child.stdin, { type: 'finish', id: input.id }).catch((failure) => {
        error ??= failure
      })
      try {
        await job.completed.promise
      }
      catch (failure) {
        error ??= failure
      }
      await this.#network.close(input.id)
      await Promise.allSettled([...job.events])
      signal.removeEventListener('abort', cancel)
      this.#jobs.delete(input.id)
      this.#updateCancelTimer()
    }
    if (error || job.error)
      throw error ?? job.error
    signal.throwIfAborted()
  }

  #updateCancelTimer(): void {
    if (this.#stopped || this.#stopPromise || !this.#jobs.size || [...this.#jobs.values()].some(job => !job.signal.aborted)) {
      clearTimeout(this.#cancelTimer)
      this.#cancelTimer = undefined
      return
    }
    this.#cancelTimer ??= setTimeout(() => {
      this.#cancelTimer = undefined
      if (this.#jobs.size && [...this.#jobs.values()].every(job => job.signal.aborted))
        void this.stop()
    }, inferenceLimits.stopTimeoutMs)
  }

  stop(): Promise<void> {
    return this.#stopPromise ??= (async () => {
      for (const job of this.#jobs.values()) job.abort.abort()
      clearTimeout(this.#cancelTimer)
      this.#cancelTimer = undefined
      const closingNetwork = this.#network.close()
      this.#child.stdin.end()
      const timer = setTimeout(() => this.#child.kill('SIGKILL'), inferenceLimits.stopTimeoutMs)
      try {
        await Promise.all([this.#closed.promise, closingNetwork])
      }
      finally {
        clearTimeout(timer)
      }
    })()
  }
}

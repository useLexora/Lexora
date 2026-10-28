import type { ExtensionPackageProcessor, ExtensionPackageRequests, ExtensionPackageResults, ExtensionPackageTask } from '../../../platform/extensions/extensionPackageProcessing'
import type { ExtensionIncompatibleReview } from '../../../shared/extensions/extensionCompatibility'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { ExtensionCompatibilityError } from '../../../shared/extensions/extensionCompatibility'
import { validateExtensionArchiveSize, validateExtensionFiles } from '../../../shared/extensions/extensionPackageBudget'

type Request = ExtensionPackageRequests[ExtensionPackageTask]
type Result = ExtensionPackageResults[ExtensionPackageTask]
type Reply = { kind: 'result', value: Result } | { kind: 'log', message: string } | { kind: 'error', code: string, compatibility?: ExtensionIncompatibleReview, errno?: string }

async function snapshotRequest(request: Request, signal: AbortSignal): Promise<{ request: Request, transfer: ArrayBuffer[] }> {
  const transfer: ArrayBuffer[] = []
  async function copy(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const snapshot = new Uint8Array(bytes.byteLength)
    for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
      signal.throwIfAborted()
      snapshot.set(bytes.subarray(offset, offset + 1024 * 1024), offset)
      await setImmediate(undefined, { signal })
    }
    transfer.push(snapshot.buffer)
    return snapshot
  }
  if ('files' in request) {
    validateExtensionFiles(request.files)
    const files = new Map<string, Uint8Array>()
    for (const [name, bytes] of request.files)
      files.set(name, await copy(bytes))
    return { request: { ...request, files }, transfer }
  }
  if ('bytes' in request) {
    validateExtensionArchiveSize(request.bytes.byteLength)
    return { request: { ...request, bytes: await copy(request.bytes) }, transfer }
  }
  return { request, transfer }
}

export class ExtensionPackageWorker {
  readonly #entry: string
  readonly #timeoutMs: number
  readonly #queue: { start: () => void, abort: () => void }[] = []
  #active = false

  constructor(entry = join(import.meta.dirname, 'extension-package-worker.js'), timeoutMs = 60000) {
    this.#entry = entry
    this.#timeoutMs = timeoutMs
  }

  readonly run = <R extends Request>(request: R, signal?: AbortSignal, report: (message: string) => void = () => {}): Promise<ExtensionPackageResults[R['kind']]> => {
    if (this.#queue.length + Number(this.#active) >= 4)
      return Promise.reject(new Error('EXTENSION_PACKAGE_BUSY'))
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('EXTENSION_INSTALL_CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted)
      abort()
    const timer = setTimeout(() => controller.abort(new Error(request.kind === 'compile' ? 'EXTENSION_COMPILE_TIMEOUT' : 'EXTENSION_PACKAGE_TIMEOUT')), request.kind === 'compile' ? Math.min(this.#timeoutMs, 30000) : this.#timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    return new Promise<Result>((resolve, reject) => {
      const job = {
        abort: () => {
          const index = this.#queue.indexOf(job)
          if (index !== -1) {
            this.#queue.splice(index, 1)
            cleanup()
            reject(controller.signal.reason)
          }
        },
        start: () => {
          controller.signal.removeEventListener('abort', job.abort)
          this.#active = true
          void this.#execute(request, controller.signal, report).then(resolve, error => reject(controller.signal.aborted ? controller.signal.reason : error)).finally(() => {
            cleanup()
            this.#active = false
            this.#queue.shift()?.start()
          })
        },
      }
      this.#queue.push(job)
      controller.signal.addEventListener('abort', job.abort, { once: true })
      if (controller.signal.aborted)
        job.abort()
      else if (!this.#active)
        this.#queue.shift()!.start()
    }) as Promise<ExtensionPackageResults[R['kind']]>
  }

  async #execute(request: Request, signal: AbortSignal, report: (message: string) => void): Promise<Result> {
    signal.throwIfAborted()
    const snapshot = await snapshotRequest(request, signal)
    signal.throwIfAborted()
    const worker = new Worker(this.#entry, { env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 192 }, stdout: true, stderr: true })
    worker.stdout.resume()
    worker.stderr.resume()
    try {
      return await new Promise<Result>((resolve, reject) => {
        let logCount = 0
        let settled = false
        const aborted = () => finish(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        function finish(error: unknown, value?: Result) {
          if (settled)
            return
          settled = true
          signal.removeEventListener('abort', aborted)
          if (error)
            reject(error)
          else resolve(value)
        }
        worker.on('error', error => finish(new Error('EXTENSION_PACKAGE_WORKER_FAILED', { cause: error })))
        worker.on('exit', () => finish(new Error('EXTENSION_PACKAGE_WORKER_STOPPED')))
        worker.on('message', (message: Reply) => {
          if (settled)
            return
          if (message.kind === 'log') {
            try {
              if (logCount++ < 30)
                report(message.message.slice(0, 600))
            }
            catch (error) {
              finish(error)
            }
          }
          else if (message.kind === 'result') {
            finish(null, message.value)
          }
          else if (message.kind === 'error') {
            finish(message.compatibility
              ? new ExtensionCompatibilityError(message.compatibility.manifest, message.compatibility.incompatibility)
              : Object.assign(new Error(/^EXTENSION_[A-Z_]+$/.test(message.code) ? message.code : 'EXTENSION_PACKAGE_WORKER_FAILED'), { code: message.errno }))
          }
        })
        worker.postMessage(snapshot.request, snapshot.transfer)
      })
    }
    finally {
      await worker.terminate()
    }
  }
}

export const processExtensionPackageInBackground: ExtensionPackageProcessor = new ExtensionPackageWorker().run

import type { InferenceResourceProgress } from '../../shared/extensions/extensionInference'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { ExtensionDownloads } from './ExtensionDownloads'
import type { ExtensionInference, ExtensionInferencePorts } from './ExtensionInference'
import type { InferenceResourceSource } from './ExtensionInferenceResources'
import type { ExtensionPackage, ExtensionPackageStore } from './ExtensionPackageStore'
import process from 'node:process'
import { z } from 'zod'
import { inferenceBindingSchema, inferenceCredentialReferenceSchema, inferenceCredentialSchema, inferenceHardwareSchema, inferenceHashSchema, inferenceIdSchema, inferencePrepareSchema, inferenceRuntimeReferenceSchema } from '../../shared/extensions/extensionInference'
import { resolveInferenceEnvironment } from '../../shared/extensions/inferencePlatform'

interface ExtensionInferenceRequestContext {
  identity: object
  manifest: ExtensionPackage['manifest']
  signal: AbortSignal
  inference?: ExtensionInference
  preparations: Set<Promise<unknown>>
  call: (method: string, params: JsonValue, signal?: AbortSignal) => Promise<JsonValue>
  source: () => InferenceResourceSource
  assertCurrent: () => void
  changed: () => void
}

export class ExtensionInferenceRequests {
  readonly #store: ExtensionPackageStore
  readonly #ports: ExtensionInferencePorts | undefined
  readonly #downloads: ExtensionDownloads

  constructor(store: ExtensionPackageStore, inference: ExtensionInferencePorts | undefined, downloads: ExtensionDownloads) {
    this.#store = store
    this.#ports = inference
    this.#downloads = downloads
  }

  source(manifest: ExtensionPackage['manifest'], inference: ExtensionInference | undefined, access: {
    assertCurrent: () => void
    authorizeDownload: (url: string) => void
    networkResponse: (url: string, signal: AbortSignal, headers?: Record<string, string>) => Promise<Response>
  }): InferenceResourceSource {
    const { id, permissions } = manifest
    return {
      prepare: manifest.contributes.inference?.preparation && inference
        ? (...args) => inference!.prepareResources(...args)
        : undefined,
      assertDownload: (url) => {
        access.authorizeDownload(url)
        access.assertCurrent()
      },
      response: (source, signal, headers) => {
        if ('directoryId' in source)
          throw new Error('EXTENSION_INFERENCE_REFERENCE_REQUIRED')
        return 'url' in source ? access.networkResponse(source.url, signal, headers) : this.#store.resources.response(id, source.resourceId, new Request('https://resource.invalid/'), signal, permissions.localResources)
      },
      directoryReferencePath: async (input) => {
        access.assertCurrent()
        if (!permissions.localResources)
          throw new Error('EXTENSION_PERMISSION_DENIED')
        const path = await this.#store.resources.directoryReferencePath(id, input)
        access.assertCurrent()
        return path
      },
      referencePath: async (resourceId) => {
        access.assertCurrent()
        if (!permissions.localResources)
          throw new Error('EXTENSION_PERMISSION_DENIED')
        const path = await this.#store.resources.referencePath(id, resourceId)
        access.assertCurrent()
        return path
      },
      openDirectoryReference: async (input) => {
        access.assertCurrent()
        if (!permissions.localResources)
          throw new Error('EXTENSION_PERMISSION_DENIED')
        const handle = await this.#store.resources.openDirectoryReference(id, input)
        try {
          access.assertCurrent()
          return handle
        }
        catch (error) {
          await handle.close()
          throw error
        }
      },
      openReference: async (resourceId) => {
        access.assertCurrent()
        if (!permissions.localResources)
          throw new Error('EXTENSION_PERMISSION_DENIED')
        return this.#store.resources.openReference(id, resourceId)
      },
    }
  }

  async request(context: ExtensionInferenceRequestContext, method: string, params: unknown, lifetime: AbortSignal, owner: string): Promise<JsonValue> {
    const { id, permissions } = context.manifest
    if (!permissions.inference)
      throw new Error('EXTENSION_PERMISSION_DENIED')
    if (method.startsWith('inference.credentials.')) {
      const credentials = this.#ports?.credentials
      if (!credentials || !context.inference)
        throw new Error('EXTENSION_INFERENCE_UNAVAILABLE')
      const assertCurrent = () => context.assertCurrent()
      if (method === 'inference.credentials.remove') {
        const input = z.object({ id: inferenceIdSchema }).strict().parse(params)
        await context.inference.withStoppedCredential(input.id, () => credentials.remove(id, input.id, assertCurrent))
        context.changed()
        return null
      }
      if (method === 'inference.credentials.has' || method === 'inference.credentials.set') {
        const input = method === 'inference.credentials.set' ? inferenceCredentialSchema.parse(params) : inferenceCredentialReferenceSchema.parse(params)
        if (!permissions.inferenceNetwork.includes(input.origin))
          throw new Error('EXTENSION_PERMISSION_DENIED')
        if ('token' in input) {
          await context.inference.withStoppedCredential(input.id, () => credentials.set(id, inferenceCredentialSchema.parse(input), assertCurrent))
          context.changed()
          return null
        }
        return credentials.has(id, input)
      }
      throw new Error('EXTENSION_METHOD_DENIED')
    }
    if (method === 'inference.environment') {
      const hardware = inferenceHardwareSchema.safeParse(await this.#ports?.hardware?.(permissions.inferenceGpu).catch(() => undefined))
      context.assertCurrent()
      return {
        ...resolveInferenceEnvironment(process.platform, process.arch),
        ...(hardware.success ? { hardware: { ...hardware.data, gpus: permissions.inferenceGpu ? hardware.data.gpus : [] } } : {}),
      }
    }
    if (method === 'inference.status')
      return context.inference?.status() ?? []
    if (method === 'inference.stop') {
      const input = params === null ? undefined : inferenceRuntimeReferenceSchema.parse(params)
      if (input && !context.inference)
        throw new Error('EXTENSION_INFERENCE_RUNTIME_UNAVAILABLE')
      await context.inference?.stop(input)
      return null
    }
    if (method === 'inference.unbind') {
      const input = inferenceRuntimeReferenceSchema.parse(params)
      if (!context.inference)
        throw new Error('EXTENSION_INFERENCE_RUNTIME_UNAVAILABLE')
      await context.inference.unbind(input)
      context.changed()
      return null
    }
    if (method === 'inference.resources.list') {
      const [files, directories] = await Promise.all([this.#store.resources.list(id, permissions.localResources), permissions.localResources ? this.#store.resources.directories(id) : []])
      return this.#store.inference.inspect(id, new Set(files.map(file => file.id)), new Set(directories.map(directory => directory.id)))
    }
    if (method === 'inference.resources.remove') {
      const resource = z.object({ id: inferenceIdSchema, revision: inferenceHashSchema }).strict().parse(params)
      await this.#store.inference.remove(id, resource, () => context.assertCurrent())
      context.inference?.forgetResource(resource.id, resource.revision)
      context.changed()
      return null
    }
    if (method === 'inference.bind') {
      if (!context.inference)
        throw new Error('EXTENSION_INFERENCE_UNAVAILABLE')
      await context.inference.bind(inferenceBindingSchema.parse(params))
      context.changed()
      return null
    }
    if (method === 'inference.resources.prepare') {
      const input = z.object({ id: z.uuid(), resource: inferencePrepareSchema }).strict().parse(params)
      return this.#downloads.run(input.id, context.identity, owner, [lifetime, context.signal], async (signal) => {
        const pendingProgress: InferenceResourceProgress[] = []
        let publishing: Promise<void> | undefined
        const publish = () => {
          if (publishing || signal.aborted)
            return
          const next = pendingProgress.shift()
          if (!next)
            return
          publishing = context.call('inference.progress', { id: input.id, progress: { ...next } }, signal).then(() => {}, () => {}).finally(() => {
            publishing = undefined
            publish()
          })
        }
        const report = (progress: InferenceResourceProgress) => {
          if (signal.aborted)
            return
          const last = pendingProgress.at(-1)
          if (last && last.path === progress.path && last.phase === progress.phase && last.completedFiles === progress.completedFiles && last.bytes > 0 && progress.bytes > 0)
            pendingProgress[pendingProgress.length - 1] = progress
          else
            pendingProgress.push(progress)
          publish()
        }
        const preparing = this.#store.inference.prepare(id, input.resource, context.source(), signal, () => context.assertCurrent(), report)
        context.preparations.add(preparing)
        try {
          return await preparing
        }
        finally {
          for (let pending = publishing; pending; pending = publishing)
            await pending
          context.preparations.delete(preparing)
        }
      })
    }
    throw new Error('EXTENSION_METHOD_DENIED')
  }
}

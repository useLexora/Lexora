import type { EventSubscriber } from '../events/eventTypes'
import type { JsonValue } from '../workbench/workbenchState'
import type { ExtensionHostEvents } from './extensionEvents'
import type { InferenceBinding, InferenceCredential, InferenceCredentialReference, InferenceEnvironment, InferencePrepare, InferenceResourceProgress, InferenceResourceSet, InferenceRuntimeReference } from './extensionInference'

export function createExtensionInferenceClient(request: (method: string, params?: JsonValue) => Promise<unknown>, events?: EventSubscriber<ExtensionHostEvents>) {
  return Object.freeze({
    capabilities: Object.freeze({ nativeRuntime: true as const, runtimeIsolation: true as const, chatImageInput: true as const, chatToolMatching: true as const, chatReasoning: true as const, chatModelMetadata: true as const, resumableDownloads: true as const }),
    environment: async (): Promise<InferenceEnvironment> => await request('inference.environment') as InferenceEnvironment,
    status: () => request('inference.status'),
    stop: async (input?: InferenceRuntimeReference): Promise<void> => { await request('inference.stop', input) },
    unbind: async (input: InferenceRuntimeReference): Promise<void> => { await request('inference.unbind', input) },
    bind: async (binding: InferenceBinding): Promise<void> => {
      await request('inference.bind', binding)
    },
    credentials: Object.freeze({
      has: async (reference: InferenceCredentialReference): Promise<boolean> => await request('inference.credentials.has', reference) as boolean,
      set: async (credential: InferenceCredential): Promise<void> => { await request('inference.credentials.set', credential) },
      remove: async (id: string): Promise<void> => { await request('inference.credentials.remove', { id }) },
    }),
    resources: Object.freeze({
      list: async (): Promise<InferenceResourceSet[]> => await request('inference.resources.list') as InferenceResourceSet[],
      remove: async (resource: Pick<InferenceResourceSet, 'id' | 'revision'>): Promise<void> => {
        await request('inference.resources.remove', { id: resource.id, revision: resource.revision })
      },
      prepare: async (resource: InferencePrepare, options: {
        signal?: AbortSignal
        onProgress?: (progress: InferenceResourceProgress) => void
      } = {}): Promise<InferenceResourceSet> => {
        options.signal?.throwIfAborted()
        const id = crypto.randomUUID()
        const subscription = options.onProgress && events?.on('inference:resources:progress', ({ data }) => {
          if (data.id === id)
            options.onProgress?.(data.progress)
        })
        const cancel = () => {
          void request('network.cancel', { id }).catch(() => {
          })
        }
        options.signal?.addEventListener('abort', cancel, { once: true })
        try {
          return await request('inference.resources.prepare', { id, resource }) as InferenceResourceSet
        }
        finally {
          subscription?.dispose()
          options.signal?.removeEventListener('abort', cancel)
        }
      },
    }),
  })
}

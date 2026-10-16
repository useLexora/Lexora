import type { JsonValue } from '../workbench/workbenchState'
import type { ExtensionLocalFile } from './extensionResources'

type Request = (method: string, params?: JsonValue) => Promise<unknown>
interface TransferOptions { name?: string, signal?: AbortSignal }

async function transfer(request: Request, method: string, params: Record<string, string>, options: TransferOptions): Promise<ExtensionLocalFile> {
  options.signal?.throwIfAborted()
  const id = crypto.randomUUID()
  const pending = request(method, { ...params, id, ...(options.name === undefined ? {} : { name: options.name }) })
  const cancel = () => {
    void request('network.cancel', { id }).catch(() => {})
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await pending as ExtensionLocalFile
  }
  finally { options.signal?.removeEventListener('abort', cancel) }
}

export function createExtensionNetworkClient(request: Request) {
  return Object.freeze({
    get: (url: string) => request('network.get', { url }),
    download: (url: string, options: TransferOptions = {}) => transfer(request, 'network.download', { url }, options),
  })
}

export function createExtensionResourceClient(request: Request) {
  return Object.freeze({
    readText: (resource: { id: string }) => request('resources.readText', { id: resource.id }),
    getUrl: (resource: { id: string } | { packagePath: string }) => request('resources.getUrl', 'packagePath' in resource ? { packagePath: resource.packagePath } : { id: resource.id }),
    listFiles: () => request('resources.listFiles'),
    readBytes: async (resource: { id: string }, options: { offset?: number, length?: number } = {}) => {
      const result = await request('resources.readBytes', { id: resource.id, offset: options.offset ?? 0, length: options.length ?? 65536 }) as { base64: string, size: number, eof: boolean }
      return { data: Uint8Array.from(atob(result.base64), byte => byte.charCodeAt(0)), size: result.size, eof: result.eof }
    },
    importFile: (resource: { id: string, name?: string }, options: TransferOptions = {}) => transfer(request, 'resources.importFile', { resourceId: resource.id }, { ...options, name: options.name ?? resource.name }),
    release: (resource: { id: string }) => request('resources.release', { id: resource.id }),
  })
}

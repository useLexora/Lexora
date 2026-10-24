import type { JsonValue } from '../workbench/workbenchState'
import type { ExtensionLocalFile } from './extensionResources'
import { extensionResourceMimeTypeSchema } from './extensionResources'

type Request = (method: string, params?: JsonValue) => Promise<unknown>
interface TransferOptions { name?: string, signal?: AbortSignal }
interface WriteOptions { name: string, data: Blob | ArrayBuffer | Uint8Array, signal?: AbortSignal }

export async function writeExtensionResource(request: Request, method: 'resources.beginSave' | 'resources.beginCreate', options: WriteOptions & { mimeType?: string }): Promise<ExtensionLocalFile | boolean> {
  options.signal?.throwIfAborted()
  const blob = options.data instanceof Blob ? options.data : new Blob([options.data as Uint8Array<ArrayBuffer> | ArrayBuffer])
  const id = await request(method, { name: options.name, size: blob.size, ...(method === 'resources.beginCreate' ? { mimeType: extensionResourceMimeTypeSchema.parse(options.mimeType ?? (blob.type || 'application/octet-stream')) } : {}) }) as string | null
  if (!id)
    return false
  const cancel = () => {
    void request('resources.cancelSave', { id }).catch(() => {})
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    options.signal?.throwIfAborted()
    for (let offset = 0; offset < blob.size; offset += 96 * 1024) {
      options.signal?.throwIfAborted()
      const bytes = new Uint8Array(await blob.slice(offset, offset + 96 * 1024).arrayBuffer())
      const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
      await request('resources.writeChunk', { id, offset, base64 })
    }
    options.signal?.throwIfAborted()
    const result = await request('resources.commitSave', { id })
    return method === 'resources.beginCreate' ? result as ExtensionLocalFile : true
  }
  catch (error) {
    await request('resources.cancelSave', { id }).catch(() => {})
    throw error
  }
  finally { options.signal?.removeEventListener('abort', cancel) }
}

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
    createFile: (options: WriteOptions & { mimeType?: string }) => writeExtensionResource(request, 'resources.beginCreate', options) as Promise<ExtensionLocalFile>,
    release: (resource: { id: string }) => request('resources.release', { id: resource.id }),
  })
}

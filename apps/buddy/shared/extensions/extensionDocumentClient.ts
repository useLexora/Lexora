import type { JsonValue } from '../workbench/workbenchState'
import type { ExtensionDocument, ExtensionDocumentWrite } from './extensionDocuments'

type Request = (method: string, params?: JsonValue) => Promise<unknown>
interface Bytes { data: Blob | Uint8Array | ArrayBuffer, signal?: AbortSignal }

export function createExtensionDocumentClient(request: Request) {
  const write = async (input: Omit<ExtensionDocumentWrite, 'size' | 'operationId'>, options: Bytes): Promise<ExtensionDocument | null> => {
    const blob = options.data instanceof Blob ? options.data : new Blob([options.data as Uint8Array<ArrayBuffer> | ArrayBuffer])
    options.signal?.throwIfAborted()
    const id = await request('documents.beginWrite', { ...input, size: blob.size, operationId: crypto.randomUUID() }) as string | null
    if (!id)
      return null
    const cancel = () => {
      void request('documents.cancelWrite', { id }).catch(() => {})
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      for (let offset = 0; offset < blob.size; offset += 96 * 1024) {
        options.signal?.throwIfAborted()
        const bytes = new Uint8Array(await blob.slice(offset, offset + 96 * 1024).arrayBuffer())
        await request('documents.writeChunk', { id, offset, base64: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) })
      }
      options.signal?.throwIfAborted()
      return await request('documents.commitWrite', { id }) as ExtensionDocument
    }
    catch (error) {
      await request('documents.cancelWrite', { id }).catch(() => {})
      throw error
    }
    finally {
      options.signal?.removeEventListener('abort', cancel)
    }
  }
  return Object.freeze({
    pick: (options: { filters?: { name: string, extensions: string[] }[] } = {}) => request('documents.pick', options),
    open: (resource: { id: string }) => request('documents.open', { resourceId: resource.id }),
    resume: (document: { id: string }) => request('documents.resume', { id: document.id }),
    list: () => request('documents.list'),
    read: async (document: { id: string }, options: { recovery?: boolean, signal?: AbortSignal } = {}) => {
      const parts: Uint8Array[] = []
      let offset = 0
      let contentVersion: string | undefined
      for (;;) {
        options.signal?.throwIfAborted()
        const part = await request('documents.readBytes', { id: document.id, offset, length: 128 * 1024, recovery: options.recovery ?? true, ...(contentVersion ? { contentVersion } : {}) }) as { base64: string, size: number, eof: boolean, contentVersion: string }
        contentVersion = part.contentVersion
        const bytes = Uint8Array.from(atob(part.base64), byte => byte.charCodeAt(0))
        parts.push(bytes)
        offset += bytes.length
        if (offset > 256 * 1024 * 1024 || (!part.eof && !bytes.length))
          throw new Error('EXTENSION_DOCUMENT_SIZE_LIMIT')
        if (part.eof)
          break
      }
      const result = new Uint8Array(offset)
      offset = 0
      for (const part of parts) {
        result.set(part, offset)
        offset += part.length
      }
      return result
    },
    create: (options: Bytes & { name: string }) => write({ mode: 'create', name: options.name, version: null }, options),
    save: (document: ExtensionDocument, options: Bytes) => write({ mode: 'save', id: document.id, version: document.version, revision: document.revision }, options),
    saveAs: (options: Bytes & { name: string }) => write({ mode: 'saveAs', name: options.name, version: null }, options),
    backup: (document: ExtensionDocument, options: Bytes) => write({ mode: 'draft', id: document.id, version: document.version, revision: document.revision }, options),
    status: (document: { id: string }) => request('documents.status', { id: document.id }),
    discardRecovery: (document: { id: string }) => request('documents.discardRecovery', { id: document.id }),
    close: (document: { id: string }) => request('documents.close', { id: document.id }),
    forget: (document: { id: string }) => request('documents.forget', { id: document.id }),
    reveal: (document: { id: string }) => request('documents.reveal', { id: document.id }),
  })
}

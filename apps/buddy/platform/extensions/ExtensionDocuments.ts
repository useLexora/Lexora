import type { ExtensionDocument } from '../../shared/extensions/extensionDocuments'
import type { ExtensionFileOpeningSource } from '../../shared/extensions/extensionFileOpening'
import type { ExtensionResourceSelection } from '../../shared/extensions/extensionResources'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { ExtensionResourceUpload } from './ExtensionResourceUpload'
import type { ExtensionDocumentPorts } from './ExtensionWorkingCopyStore'
import { z } from 'zod'
import { extensionDocumentWriteSchema } from '../../shared/extensions/extensionDocuments'
import { extensionResourceSelectionSchema } from '../../shared/extensions/extensionResources'
import { ExtensionWorkingCopyStore } from './ExtensionWorkingCopyStore'

interface DocumentView {
  extensionId: string
  name: string
  viewId: string
  token: string
  signal: AbortSignal
  current: () => void
  source: (resourceId: string) => Promise<ExtensionFileOpeningSource>
}
interface DocumentPorts {
  files: ExtensionDocumentPorts
  selectResources?: (name: string, selection: ExtensionResourceSelection, signal: AbortSignal) => Promise<string[]>
  selectSavePath?: (name: string, suggestedName: string, signal: AbortSignal) => Promise<string | null>
}

export class ExtensionDocuments {
  readonly #copies: ExtensionWorkingCopyStore
  readonly #ports: DocumentPorts
  readonly #pending = new Map<string, number>()
  readonly #uploads = new Map<string, { token: string, upload: ExtensionResourceUpload<ExtensionDocument> }>()
  constructor(root: string, ports: DocumentPorts) {
    this.#ports = ports
    this.#copies = new ExtensionWorkingCopyStore(root, ports.files)
  }

  async request(view: DocumentView, method: string, params: JsonValue): Promise<JsonValue> {
    const { extensionId, viewId, signal, current } = view
    let result: JsonValue = null
    if (method === 'documents.pick') {
      const selection = extensionResourceSelectionSchema.parse(params)
      if (!this.#ports.selectResources)
        throw new Error('EXTENSION_DOCUMENT_UNAVAILABLE')
      const paths = await this.#ports.selectResources(`${view.name} · 打开并编辑文件`, { ...selection, multiple: false }, signal)
      current()
      result = paths[0] ? await this.#copies.openPath(extensionId, viewId, paths[0], signal, current) : null
    }
    else if (method === 'documents.open') {
      const input = z.object({ resourceId: z.string().uuid() }).strict().parse(params)
      const source = await view.source(input.resourceId)
      const path = await this.#ports.files.resolve(source, signal)
      current()
      result = await this.#copies.openPath(extensionId, viewId, path, signal, current, source)
    }
    else if (method === 'documents.list') {
      z.null().parse(params)
      result = await this.#copies.list(extensionId)
    }
    else if (method === 'documents.beginWrite') {
      result = await this.begin(view, params)
    }
    else if (['documents.writeChunk', 'documents.commitWrite', 'documents.cancelWrite'].includes(method)) {
      const input = z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative().optional(), base64: z.string().max(128 * 1024).regex(/^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i).optional() }).strict().parse(params)
      const entry = this.#uploads.get(input.id)
      if (!entry || entry.token !== view.token)
        throw new Error('EXTENSION_DOCUMENT_EXPIRED')
      if (method === 'documents.writeChunk') {
        if (input.offset === undefined || input.base64 === undefined)
          throw new Error('EXTENSION_RESOURCE_WRITE_RANGE')
        await entry.upload.append(input.offset, input.base64)
      }
      else {
        try {
          result = method === 'documents.commitWrite' ? await entry.upload.commit() : null
        }
        finally {
          this.#uploads.delete(input.id)
          await entry.upload.dispose()
        }
      }
    }
    else if (method === 'documents.readBytes') {
      const input = z.object({ id: z.string().uuid(), offset: z.number().int().min(0).max(256 * 1024 * 1024), length: z.number().int().min(1).max(128 * 1024), recovery: z.boolean(), contentVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(params)
      result = await this.#copies.read(extensionId, viewId, input.id, input.offset, input.length, input.recovery, signal, input.contentVersion)
    }
    else {
      const input = z.object({ id: z.string().uuid() }).strict().parse(params)
      if (method === 'documents.resume')
        result = await this.#copies.reopen(extensionId, viewId, input.id, signal, current)
      else if (method === 'documents.status')
        result = await this.#copies.status(extensionId, viewId, input.id, signal)
      else if (method === 'documents.discardRecovery')
        await this.#copies.discard(extensionId, viewId, input.id, current)
      else if (method === 'documents.close')
        this.#copies.close(extensionId, viewId, input.id)
      else if (method === 'documents.forget')
        await this.#copies.forget(extensionId, input.id)
      else if (method === 'documents.reveal')
        await this.#copies.reveal(extensionId, viewId, input.id, signal)
      else throw new Error('EXTENSION_METHOD_DENIED')
    }
    current()
    return result
  }

  private async begin(view: DocumentView, params: JsonValue) {
    const input = extensionDocumentWriteSchema.parse(params)
    const { token, signal, current } = view
    if ([...this.#uploads.values()].filter(entry => entry.token === token).length + (this.#pending.get(token) ?? 0) >= 2)
      throw new Error('EXTENSION_DOCUMENT_UPLOAD_LIMIT')
    this.#pending.set(token, (this.#pending.get(token) ?? 0) + 1)
    try {
      let path: string | null = null
      if (input.mode === 'saveAs') {
        if (!input.name || !this.#ports.selectSavePath)
          throw new Error('EXTENSION_DOCUMENT_UNAVAILABLE')
        path = await this.#ports.selectSavePath(view.name, input.name, signal)
        current()
        if (!path)
          return null
      }
      const upload = await this.#copies.begin(view.extensionId, view.viewId, input, path, signal, current)
      try {
        current()
      }
      catch (error) {
        await upload.dispose()
        throw error
      }
      this.#uploads.set(upload.id, { token, upload })
      return upload.id
    }
    finally {
      const count = (this.#pending.get(token) ?? 1) - 1
      if (count)
        this.#pending.set(token, count)
      else this.#pending.delete(token)
    }
  }

  forget(extensionId: string) {
    return this.#copies.forget(extensionId)
  }

  async close(extensionId: string, viewId: string, token: string) {
    this.#copies.close(extensionId, viewId)
    const uploads = [...this.#uploads.entries()].filter(([, entry]) => entry.token === token)
    for (const [id] of uploads) this.#uploads.delete(id)
    await Promise.all(uploads.map(([, entry]) => entry.upload.dispose()))
  }
}

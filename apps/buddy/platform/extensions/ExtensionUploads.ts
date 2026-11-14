import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { ExtensionResourceUpload } from './ExtensionResourceUpload'
import { extensionResourceWriteRequestSchema } from '../../shared/extensions/extensionResources'

export class ExtensionUploads {
  readonly #creating = new Set<{ host: object, owner: string, promise: Promise<ExtensionResourceUpload> }>()
  readonly #uploads = new Map<string, { host: object, owner: string, upload: ExtensionResourceUpload }>()

  has(id: string): boolean { return this.#uploads.has(id) }

  async create(host: object, owner: string, create: () => Promise<ExtensionResourceUpload>): Promise<string> {
    const creation = { host, owner, promise: create() }
    this.#creating.add(creation)
    try {
      const upload = await creation.promise
      this.#uploads.set(upload.id, { host, owner, upload })
      void upload.finished.finally(() => this.#uploads.delete(upload.id)).catch(() => {})
      return upload.id
    }
    finally { this.#creating.delete(creation) }
  }

  async request(host: object, owner: string, method: string, params: unknown): Promise<JsonValue> {
    const input = extensionResourceWriteRequestSchema.parse(params)
    const entry = this.#uploads.get(input.id)
    if (!entry)
      throw new Error('EXTENSION_RESOURCE_WRITE_EXPIRED')
    if (entry.host !== host || entry.owner !== owner)
      throw new Error('EXTENSION_RESOURCE_DENIED')
    if (method === 'resources.writeChunk') {
      if (input.offset === undefined || input.base64 === undefined)
        throw new Error('EXTENSION_RESOURCE_WRITE_RANGE')
      await entry.upload.append(input.offset, input.base64)
      return null
    }
    if (method === 'resources.commitSave') {
      try {
        return { ...await entry.upload.commit() }
      }
      finally { await entry.upload.dispose() }
    }
    if (method !== 'resources.cancelSave')
      throw new Error('EXTENSION_METHOD_DENIED')
    await entry.upload.dispose()
    return null
  }

  async dispose(host: object, owner?: string): Promise<void> {
    const matches = (entry: { host: object, owner: string }) => entry.host === host && (owner === undefined || entry.owner === owner)
    await Promise.all([
      ...[...this.#creating].filter(matches).map(entry => entry.promise.then(upload => upload.dispose(), () => {})),
      ...[...this.#uploads.values()].filter(matches).map(entry => entry.upload.dispose()),
    ])
  }
}

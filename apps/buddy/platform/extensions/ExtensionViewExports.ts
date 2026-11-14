import type { JsonValue } from '../../shared/workbench/workbenchState'
import { z } from 'zod'
import { extensionResourceWriteRequestSchema } from '../../shared/extensions/extensionResources'
import { ExtensionResourceWriter } from './ExtensionResourceWriter'

interface ExtensionViewExportAccess {
  name: string
  signal: AbortSignal
  assertCurrent: () => void
  selectSavePath?: (name: string, suggestedName: string, signal: AbortSignal) => Promise<string | null>
}

export class ExtensionViewExports {
  readonly #writers = new Map<string, ExtensionResourceWriter>()

  async request(access: ExtensionViewExportAccess, method: string, params: unknown): Promise<JsonValue> {
    if (method === 'resources.beginSave') {
      if (!access.selectSavePath || this.#writers.size >= 2)
        throw new Error('EXTENSION_RESOURCE_SAVE_UNAVAILABLE')
      const input = z.object({ name: z.string().min(1).max(255).regex(/^[^/\\\0]+$/), size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict().parse(params)
      const signal = AbortSignal.any([access.signal, AbortSignal.timeout(120000)])
      const path = await access.selectSavePath(access.name, input.name, signal)
      signal.throwIfAborted()
      access.assertCurrent()
      if (!path)
        return null
      const writer = await ExtensionResourceWriter.create(path, input.size, access.assertCurrent)
      try {
        access.assertCurrent()
      }
      catch (error) {
        await writer.dispose()
        throw error
      }
      this.#writers.set(writer.id, writer)
      return writer.id
    }
    const input = extensionResourceWriteRequestSchema.parse(params)
    const writer = this.#writers.get(input.id)
    if (!writer)
      throw new Error('EXTENSION_RESOURCE_WRITE_EXPIRED')
    if (method === 'resources.writeChunk') {
      if (input.offset === undefined || input.base64 === undefined)
        throw new Error('EXTENSION_RESOURCE_WRITE_RANGE')
      await writer.append(input.offset, input.base64)
    }
    else {
      if (method !== 'resources.commitSave' && method !== 'resources.cancelSave')
        throw new Error('EXTENSION_METHOD_DENIED')
      try {
        if (method === 'resources.commitSave')
          await writer.commit()
      }
      finally {
        this.#writers.delete(input.id)
        await writer.dispose()
      }
    }
    return null
  }

  async dispose(): Promise<void> {
    const cleanups = [...this.#writers.values()].map(writer => writer.dispose())
    this.#writers.clear()
    const results = await Promise.allSettled(cleanups)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected')
      throw failure.reason
  }
}

import type { AttachmentPreviewResult } from '../../shared/runtime/attachmentHostProtocol'
import { Buffer } from 'node:buffer'

interface Entry { version: string, image: Blob }
interface Flight { controller: AbortController, result: Promise<Blob>, readers: number }

export function createAttachmentPreviewCache(
  load: (id: string, ifVersion: string | null, signal: AbortSignal) => Promise<AttachmentPreviewResult>,
  maxBytes = 16 * 1024 * 1024,
  maxEntries = 32,
) {
  const entries = new Map<string, Entry>()
  const pending = new Map<string, Flight>()
  let bytes = 0

  function remove(id: string) {
    const previous = entries.get(id)
    if (previous) {
      entries.delete(id)
      bytes -= previous.image.size
    }
  }

  async function read(id: string, signal: AbortSignal) {
    const previous = entries.get(id)
    try {
      const result = await load(id, previous?.version ?? null, signal)
      signal.throwIfAborted()
      const entry = 'unchanged' in result
        ? previous && previous.version === result.unchanged ? previous : null
        : { version: result.version, image: new Blob([Buffer.from(result.data, 'base64')], { type: result.mimeType }) }
      if (!entry)
        throw new Error('Invalid attachment preview version')
      remove(id)
      if (entry.version && entry.image.size <= maxBytes) {
        entries.set(id, { version: entry.version, image: entry.image })
        bytes += entry.image.size
        while (bytes > maxBytes || entries.size > maxEntries)
          remove(entries.keys().next().value!)
      }
      return entry.image
    }
    catch (error) {
      if (!signal.aborted)
        remove(id)
      throw error
    }
  }

  async function get(id: string, signal: AbortSignal): Promise<Blob> {
    signal.throwIfAborted()
    let flight = pending.get(id)
    if (!flight) {
      const controller = new AbortController()
      flight = { controller, result: read(id, controller.signal), readers: 0 }
      pending.set(id, flight)
    }
    const shared = flight
    shared.readers++
    const cancelled = Promise.withResolvers<never>()
    const abort = () => cancelled.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await Promise.race([shared.result, cancelled.promise])
    }
    finally {
      signal.removeEventListener('abort', abort)
      if (--shared.readers === 0 && pending.get(id) === shared) {
        pending.delete(id)
        if (signal.aborted)
          shared.controller.abort()
      }
    }
  }

  function clear() {
    for (const flight of pending.values()) flight.controller.abort()
    pending.clear()
    entries.clear()
    bytes = 0
  }

  return { get, clear }
}

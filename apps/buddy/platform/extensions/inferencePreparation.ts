import type { FileHandle } from 'node:fs/promises'
import type { InferencePrepare, InferenceResourceProgress } from '../../shared/extensions/extensionInference'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { FileAssetStore } from '../filesystem/FileAssetStore'
import { inferencePreparedFileEventSchema } from '../../shared/extensions/extensionInference'

export type InferencePreparationRunner = (
  inputs: Array<{ path: string, handle: FileHandle, hostPath?: string }>,
  options: JsonValue,
  signal: AbortSignal,
  event: (data: JsonValue, bytes: Uint8Array, signal: AbortSignal) => Promise<void>,
) => Promise<void>

export async function collectInferencePreparation(
  input: InferencePrepare,
  inputs: Parameters<InferencePreparationRunner>[0],
  run: InferencePreparationRunner,
  assets: FileAssetStore,
  signal: AbortSignal,
  assertCurrent: () => void,
  report: (path: string, bytes: number, total: number, phase: InferenceResourceProgress['phase'], completedFiles: number) => void,
): Promise<Array<{ path: string, sha256: string, size: number, executable?: boolean }>> {
  const preparation = input.preparation!
  const entries: Array<{ path: string, sha256: string, size: number, executable?: boolean }> = []
  const paths = new Set<string>()
  let total = 0
  let active: {
    path: string
    size: number
    bytes: number
    executable?: boolean
    writer: WritableStreamDefaultWriter<Uint8Array>
    writing: Promise<{ key: string, size: number }>
  } | undefined
  try {
    await run(inputs, preparation.options, signal, async (data, bytes) => {
      signal.throwIfAborted()
      assertCurrent()
      const event = inferencePreparedFileEventSchema.parse(data)
      if (event.type !== 'chunk' && bytes.length)
        throw new Error('EXTENSION_INFERENCE_PREPARATION_INVALID')
      if (event.type === 'file') {
        const path = event.path.toLowerCase()
        if (active || paths.size >= preparation.maxFiles || total + event.size > preparation.maxBytes
          || (event.executable && input.kind !== 'engine')
          || [...paths].some(existing => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))) {
          throw new Error('EXTENSION_INFERENCE_PREPARATION_INVALID')
        }
        paths.add(path)
        total += event.size
        let controller: TransformStreamDefaultController<Uint8Array>
        const stream = new TransformStream<Uint8Array, Uint8Array>({
          start(value) { controller = value },
        })
        report(event.path, 0, event.size, 'extract', entries.length)
        const writing = assets.put(stream.readable, signal, assertCurrent, count => report(event.path, count, event.size, 'extract', entries.length))
        void writing.catch(error => controller.error(error))
        active = { ...event, bytes: 0, writer: stream.writable.getWriter(), writing }
      }
      else if (event.type === 'alias') {
        const target = entries.find(entry => entry.path === event.target)
        const path = event.path.toLowerCase()
        if (active || !target || paths.size >= preparation.maxFiles || total + target.size > preparation.maxBytes
          || [...paths].some(existing => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))) {
          throw new Error('EXTENSION_INFERENCE_PREPARATION_INVALID')
        }
        paths.add(path)
        total += target.size
        entries.push({ ...target, path: event.path })
        report(event.path, target.size, target.size, 'extract', entries.length)
      }
      else if (event.type === 'chunk') {
        if (!active || active.bytes + bytes.length > active.size)
          throw new Error('EXTENSION_INFERENCE_RESOURCE_LIMIT')
        active.bytes += bytes.length
        await active.writer.write(bytes)
      }
      else {
        if (!active || active.bytes !== active.size)
          throw new Error('EXTENSION_INFERENCE_PREPARATION_INCOMPLETE')
        await active.writer.close()
        const asset = await active.writing
        if (asset.key !== event.sha256 || asset.size !== active.size)
          throw new Error('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
        entries.push({ path: active.path, sha256: asset.key, size: asset.size, ...(active.executable ? { executable: true } : {}) })
        report(active.path, asset.size, asset.size, 'extract', entries.length)
        active = undefined
      }
    })
    signal.throwIfAborted()
    assertCurrent()
    if (active || !entries.length)
      throw new Error('EXTENSION_INFERENCE_PREPARATION_INCOMPLETE')
    return entries
  }
  finally {
    if (active) {
      await active.writer.abort(new Error('EXTENSION_INFERENCE_PREPARATION_INCOMPLETE')).catch(() => {})
      await active.writing.catch(() => {})
    }
  }
}

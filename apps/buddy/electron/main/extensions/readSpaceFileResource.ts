import type { SpaceFileTarget } from '../../../shared/spaces/spaceFileApi'
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileResponse } from '../../../platform/filesystem/fileResponse'
import { extensionResourceMimeType } from '../../../shared/extensions/extensionResources'

export function readSpaceFileResource(target: SpaceFileTarget, signal: AbortSignal, locate: (target: SpaceFileTarget) => Promise<{ path: string, kind: 'file' | 'directory' }>, request?: Request): Promise<Response> {
  return readAuthorizedFileResource(target, signal, locate, request)
}

export async function readAuthorizedFileResource<T>(target: T, signal: AbortSignal, locate: (target: T) => Promise<{ path: string, kind: 'file' | 'directory' }>, request = new Request('https://resource.invalid/')): Promise<Response> {
  const location = await locate(target)
  signal.throwIfAborted()
  if (location.kind !== 'file')
    throw new Error('EXTENSION_RESOURCE_UNSUPPORTED')
  const handle = await open(location.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !Number.isSafeInteger(Number(before.size)))
      throw new Error('EXTENSION_RESOURCE_UNSUPPORTED')
    const response = await fileResponse(handle, Number(before.size), extensionResourceMimeType(extname(location.path).slice(1)), request, signal)
    if (!response.body)
      return response
    const body = (response.body ?? new ReadableStream<Uint8Array>({ start(controller) {
      controller.close()
    } })).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { controller.enqueue(chunk) },
      async flush() {
        const current = await locate(target)
        signal.throwIfAborted()
        const after = await stat(current.path, { bigint: true })
        if (current.path !== location.path || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
          throw new Error('EXTENSION_RESOURCE_CHANGED')
      },
    }))
    return new Response(body, { status: response.status, headers: response.headers })
  }
  catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

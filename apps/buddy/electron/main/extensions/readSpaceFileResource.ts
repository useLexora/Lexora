import type { BigIntStats } from 'node:fs'
import type { SpaceFileTarget } from '../../../shared/spaces/spaceFileApi'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { assertFileSnapshot, fileResponse } from '../../../platform/filesystem/fileResponse'
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
  let before: BigIntStats
  try {
    before = await handle.stat({ bigint: true })
    if (!before.isFile() || !Number.isSafeInteger(Number(before.size)))
      throw new Error('EXTENSION_RESOURCE_UNSUPPORTED')
  }
  catch (error) {
    await handle.close()
    throw error
  }
  const authorize = async () => {
    const current = await locate(target)
    signal.throwIfAborted()
    if (current.kind !== 'file' || current.path !== location.path)
      throw new Error('EXTENSION_RESOURCE_CHANGED')
  }
  let checkedPosition = 0
  let checkedAt = Date.now()
  return fileResponse(handle, Number(before.size), extensionResourceMimeType(extname(location.path).slice(1)), request, signal, undefined, undefined, async () => {
    await authorize()
    await assertFileSnapshot(handle, location.path, before)
  }, async (position) => {
    if (position - checkedPosition < 8 * 1024 * 1024 && Date.now() - checkedAt < 1000)
      return
    await authorize()
    checkedPosition = position
    checkedAt = Date.now()
  })
}

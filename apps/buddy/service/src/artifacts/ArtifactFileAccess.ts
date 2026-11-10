import type { ArtifactRecord } from '../storage/artifactRepository'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { openNativeFileStream } from '../../../platform/filesystem/nativeFileStream'
import { FileReadError, fileReadErrorCode } from '../../../shared/files/fileReadError'
import { mediaFileIdentity } from '../../../shared/files/mediaPreview'

export async function resolveArtifactFile(artifact: Pick<ArtifactRecord, 'currentPath'>) {
  try {
    const path = await realpath(artifact.currentPath)
    if (path !== artifact.currentPath)
      throw new FileReadError('FILE_CHANGED')
    const metadata = await lstat(path, { bigint: true })
    if (metadata.isSymbolicLink())
      throw new FileReadError('FILE_CHANGED')
    if (!metadata.isFile() && !metadata.isDirectory())
      throw new FileReadError('FILE_UNSUPPORTED')
    return { path, root: dirname(path), kind: metadata.isDirectory() ? 'directory' as const : 'file' as const, size: metadata.size, identity: mediaFileIdentity(metadata) }
  }
  catch (error) {
    throw new FileReadError(fileReadErrorCode(error), { cause: error })
  }
}

export async function readArtifactFile(artifact: Pick<ArtifactRecord, 'currentPath'>, maxBytes: number, signal = new AbortController().signal) {
  let target: Awaited<ReturnType<typeof resolveArtifactFile>> | undefined
  try {
    signal.throwIfAborted()
    target = await resolveArtifactFile(artifact)
    if (target.kind !== 'file')
      throw new FileReadError('FILE_UNSUPPORTED')
    await access(target.path, constants.R_OK)
    if (target.size > BigInt(maxBytes))
      throw new FileReadError('FILE_TOO_LARGE')
    const stream = await openNativeFileStream({
      root: target.root,
      path: target.path,
      fileId: target.identity.split(':').slice(0, 2).join(':'),
      sizeBytes: Number(target.size),
      start: 0,
      length: Number(target.size),
    }, signal)
    try {
      if ((await resolveArtifactFile(artifact)).identity !== target.identity)
        throw new FileReadError('FILE_CHANGED')
      stream.start()
      return Buffer.from(await new Response(stream.body).arrayBuffer())
    }
    finally {
      await stream.dispose()
    }
  }
  catch (error) {
    signal.throwIfAborted()
    if (target && !(error instanceof FileReadError)) {
      try {
        const current = await resolveArtifactFile(artifact)
        if (current.identity !== target.identity)
          throw new FileReadError('FILE_CHANGED')
        await access(current.path, constants.R_OK)
      }
      catch (currentError) {
        throw new FileReadError(fileReadErrorCode(currentError), { cause: currentError })
      }
    }
    throw new FileReadError(fileReadErrorCode(error), { cause: error })
  }
}

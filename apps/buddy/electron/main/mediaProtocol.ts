import type { NativeFileStream } from '../../platform/filesystem/nativeFileStream'
import type { MediaPreviewLocation } from '../../shared/files/mediaPreview'
import type { BuddyServiceSupervisor } from './runtime/BuddyServiceSupervisor'
import { fileRange } from '../../platform/filesystem/fileRange'
import { openNativeFileStream } from '../../platform/filesystem/nativeFileStream'
import { artifactsRpc } from '../../shared/artifacts/artifactApi'
import { isImageMimeType } from '../../shared/files/fileMimeTypes'
import { mediaPreviewLocationSchema } from '../../shared/files/mediaPreview'
import { taskFilesRpc } from '../../shared/files/taskFileApi'
import { skillsRpc } from '../../shared/skills/skillApi'
import { spaceFilesRpc } from '../../shared/spaces/spaceFileApi'

export async function handleMediaRequest(request: Request, runtime: Pick<BuddyServiceSupervisor, 'request'>, executable?: string): Promise<Response> {
  try {
    if (request.url.length > 32_768)
      return new Response(null, { status: 400 })
    const url = new URL(request.url)
    const keys = [...url.searchParams.keys()]
    if (new Set(keys).size !== keys.length)
      return new Response(null, { status: 400 })
    if (url.username || url.password || url.port || url.hash)
      return new Response(null, { status: 400 })
    if (url.protocol === 'lexora-artifact:' && ['media', 'preview'].includes(url.hostname)) {
      const artifactId = decodeURIComponent(url.pathname.slice(1))
      if (!artifactId || artifactId.includes('/') || [...url.searchParams.keys()].some(key => key !== 'v'))
        return new Response(null, { status: 400 })
      const input = artifactsRpc.resolveMedia.input.parse({ artifactId })
      return await createMediaResponse(request, async () => {
        const preview = mediaPreviewLocationSchema.parse(await runtime.request(artifactsRpc.resolveMedia.method, input, { signal: request.signal }))
        if (url.hostname === 'preview' && !isImageMimeType(preview.mimeType))
          throw new Error('IMAGE_PREVIEW_REQUIRED')
        return preview
      }, executable)
    }
    if (url.protocol === 'lexora-file:' && url.hostname === 'skill-preview') {
      if (url.pathname !== '/' || [...url.searchParams.keys()].some(key => !['spaceId', 'id', 'path', 'v'].includes(key)))
        return new Response(null, { status: 400 })
      const input = skillsRpc.resolveImage.input.parse({
        spaceId: url.searchParams.get('spaceId') || null,
        id: url.searchParams.get('id'),
        path: url.searchParams.get('path'),
      })
      return await createMediaResponse(request, () => runtime.request(skillsRpc.resolveImage.method, input, { signal: request.signal }), executable)
    }
    if (url.protocol === 'lexora-file:' && url.hostname === 'task-media') {
      if (url.pathname !== '/' || [...url.searchParams.keys()].some(key => !['conversationId', 'path', 'v'].includes(key)))
        return new Response(null, { status: 400 })
      const input = taskFilesRpc.resolveMedia.input.parse({
        conversationId: url.searchParams.get('conversationId'),
        path: url.searchParams.get('path'),
      })
      return await createMediaResponse(request, () => runtime.request(taskFilesRpc.resolveMedia.method, input, { signal: request.signal }), executable)
    }
    if (url.protocol === 'lexora-file:' && url.hostname === 'media') {
      if (url.pathname !== '/' || [...url.searchParams.keys()].some(key => !['spaceId', 'directoryId', 'revision', 'path', 'v'].includes(key)))
        return new Response(null, { status: 400 })
      const input = spaceFilesRpc.resolveMedia.input.parse({
        spaceId: url.searchParams.get('spaceId'),
        directoryId: url.searchParams.get('directoryId'),
        revision: Number(url.searchParams.get('revision')),
        path: url.searchParams.get('path'),
      })
      return await createMediaResponse(request, () => runtime.request(spaceFilesRpc.resolveMedia.method, input, { signal: request.signal }), executable)
    }
    return new Response(null, { status: 404 })
  }
  catch {
    return new Response(null, { status: 404 })
  }
}

export async function createMediaResponse(request: Request, resolve: () => Promise<unknown>, executable?: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
  let stream: NativeFileStream | undefined
  try {
    request.signal.throwIfAborted()
    const preview = mediaPreviewLocationSchema.parse(await resolve())
    const range = fileRange(preview.sizeBytes, request.method === 'HEAD' ? null : request.headers.get('range'))
    const noBody = request.method === 'HEAD' || range.status === 416 || preview.sizeBytes === 0
    stream = await openNativeFileStream({
      root: preview.root,
      path: preview.path,
      sizeBytes: preview.sizeBytes,
      // Preserve Node's bigint dev:ino identity without converting through Number.
      fileId: preview.identity.split(':').slice(0, 2).join(':'),
      start: noBody ? 0 : range.start,
      length: noBody ? 0 : range.end - range.start + 1,
    }, request.signal, executable)
    const current = mediaPreviewLocationSchema.parse(await resolve())
    if (!sameMediaFile(preview, current))
      throw new Error('MEDIA_FILE_CHANGED')
    request.signal.throwIfAborted()
    const headers = {
      ...range.headers,
      'content-type': preview.mimeType,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...(isImageMimeType(preview.mimeType) ? { 'content-security-policy': 'default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; sandbox' } : {}),
    }
    if (noBody) {
      await stream.dispose()
      return new Response(null, { status: range.status, headers })
    }
    stream.start()
    return new Response(stream.body, { status: range.status, headers })
  }
  catch {
    await stream?.dispose()
    return new Response(null, { status: 404 })
  }
}

function sameMediaFile(left: MediaPreviewLocation, right: MediaPreviewLocation): boolean {
  return left.root === right.root && left.path === right.path && left.identity === right.identity
    && left.sizeBytes === right.sizeBytes && left.mimeType === right.mimeType
}

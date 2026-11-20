import type { BuddyServiceSupervisor } from './runtime/BuddyServiceSupervisor'
import { Buffer } from 'node:buffer'
import { dirname } from 'node:path'
import process from 'node:process'
import { app, protocol } from 'electron'
import { readNativeBoundedFile } from '../../platform/filesystem/nativeBoundedFile'
import { resolveBuddyFileReader } from '../../platform/native/nativeHost'
import { attachmentsRequestSchemas } from '../../shared/conversation/attachmentApi'
import { composerResourcesRpc } from '../../shared/conversation/composerApi'
import { attachmentHostRpc, attachmentPreviewBytesSchema } from '../../shared/runtime/attachmentHostProtocol'
import { handleMediaRequest } from './mediaProtocol'
import { resolveDevelopmentRendererUrl } from './security/navigationPolicy'

const ATTACHMENT_PROTOCOL = 'lexora-attachment'
const ARTIFACT_PROTOCOL = 'lexora-artifact'
const FILE_PROTOCOL = 'lexora-file'

export const attachmentSchemePrivileges: Electron.CustomScheme[] = [ATTACHMENT_PROTOCOL, ARTIFACT_PROTOCOL, FILE_PROTOCOL].map(scheme => ({
  scheme,
  privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true, corsEnabled: scheme === ARTIFACT_PROTOCOL || scheme === ATTACHMENT_PROTOCOL },
}))

export function installAttachmentProtocol(runtime: Pick<BuddyServiceSupervisor, 'request' | 'requestHost'>): () => void {
  const fileReader = resolveBuddyFileReader({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
  const developmentUrl = resolveDevelopmentRendererUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged)
  const rendererOrigin = developmentUrl ? new URL(developmentUrl).origin : 'lexora-app://renderer'
  function allowRendererRead(handler: (request: Request) => Promise<Response>) {
    return async (request: Request) => {
      const response = await handler(request)
      if (request.headers.get('origin') === rendererOrigin) {
        response.headers.set('access-control-allow-origin', rendererOrigin)
        response.headers.set('access-control-expose-headers', 'x-lexora-error-code')
        response.headers.set('vary', 'Origin')
      }
      return response
    }
  }
  void protocol.handle(ATTACHMENT_PROTOCOL, allowRendererRead(async (request) => {
    if (request.method !== 'GET')
      return new Response(null, { status: 405 })

    const url = new URL(request.url)
    if (url.hostname === 'local-preview') {
      try {
        const [draftId, resourceId, extra] = url.pathname.slice(1).split('/').map(decodeURIComponent)
        if (extra !== undefined)
          return new Response(null, { status: 400 })
        const input = composerResourcesRpc.resolvePreview.input.parse({ draftId, resourceId })
        const preview = composerResourcesRpc.resolvePreview.response.parse(await runtime.request(composerResourcesRpc.resolvePreview.method, input))
        const bytes = await readNativeBoundedFile(dirname(preview.path), preview.path, 10 * 1024 * 1024, request.signal, fileReader)
        return new Response(bytes, { headers: { 'cache-control': 'private, no-store', 'content-type': preview.mimeType, 'x-content-type-options': 'nosniff' } })
      }
      catch {
        return new Response(null, { status: 404 })
      }
    }
    if (url.hostname !== 'preview')
      return new Response(null, { status: 404 })

    const id = decodeURIComponent(url.pathname.slice(1))
    if (!id || id.includes('/'))
      return new Response(null, { status: 400 })

    try {
      const input = attachmentsRequestSchemas.attachmentPreview.parse({ attachmentId: id })
      const preview = attachmentPreviewBytesSchema.parse(await runtime.requestHost(attachmentHostRpc.readPreview, input, { signal: request.signal }))
      return new Response(Buffer.from(preview.data, 'base64'), { headers: { 'cache-control': 'private, max-age=300', 'content-type': preview.mimeType, 'x-content-type-options': 'nosniff' } })
    }
    catch {
      return new Response(null, { status: 404 })
    }
  }))

  void protocol.handle(ARTIFACT_PROTOCOL, allowRendererRead(request => handleMediaRequest(request, runtime, fileReader)))

  void protocol.handle(FILE_PROTOCOL, request => handleMediaRequest(request, runtime, fileReader))

  return () => {
    protocol.unhandle(FILE_PROTOCOL)
    protocol.unhandle(ATTACHMENT_PROTOCOL)
    protocol.unhandle(ARTIFACT_PROTOCOL)
  }
}

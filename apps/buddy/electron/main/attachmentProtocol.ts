import type { BuddyServiceSupervisor } from './runtime/BuddyServiceSupervisor'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { app, protocol } from 'electron'
import { readNativeBoundedFile } from '../../platform/filesystem/nativeBoundedFile'
import { resolveBuddyFileReader } from '../../platform/native/nativeHost'
import { artifactsRequestSchemas, artifactsResponseSchemas } from '../../shared/artifacts/artifactApi'
import { attachmentsRequestSchemas } from '../../shared/conversation/attachmentApi'
import { composerResourcesRpc } from '../../shared/conversation/composerApi'

const ATTACHMENT_PROTOCOL = 'lexora-attachment'
const ARTIFACT_PROTOCOL = 'lexora-artifact'

export const attachmentSchemePrivileges: Electron.CustomScheme[] = [ATTACHMENT_PROTOCOL, ARTIFACT_PROTOCOL].map(scheme => ({
  scheme,
  privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true },
}))

export function installAttachmentProtocol(runtime: BuddyServiceSupervisor): () => void {
  const installPreviewProtocol = (
    scheme: string,
    idKey: 'artifactId' | 'attachmentId',
    method: 'artifacts.resolvePreview' | 'attachments.resolvePreview',
    schema: typeof artifactsRequestSchemas.artifactPreview | typeof attachmentsRequestSchemas.attachmentPreview,
  ) => protocol.handle(scheme, async (request) => {
    if (request.method !== 'GET')
      return new Response(null, { status: 405 })

    const url = new URL(request.url)
    if (scheme === ATTACHMENT_PROTOCOL && url.hostname === 'local-preview') {
      try {
        const [draftId, resourceId, extra] = url.pathname.slice(1).split('/').map(decodeURIComponent)
        if (extra !== undefined)
          return new Response(null, { status: 400 })
        const input = composerResourcesRpc.resolvePreview.input.parse({ draftId, resourceId })
        const preview = composerResourcesRpc.resolvePreview.response.parse(await runtime.request(composerResourcesRpc.resolvePreview.method, input))
        const bytes = await readNativeBoundedFile(dirname(preview.path), preview.path, 10 * 1024 * 1024, request.signal, resolveBuddyFileReader({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }))
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
      const input = schema.parse({ [idKey]: id })
      const preview = artifactsResponseSchemas.artifactPreview.parse(
        await runtime.request(method, input),
      )
      const body = await readFile(preview.path)
      return new Response(body, {
        headers: {
          'cache-control': scheme === ARTIFACT_PROTOCOL
            ? 'private, no-store'
            : 'private, max-age=300',
          'content-type': preview.mimeType,
          'x-content-type-options': 'nosniff',
        },
      })
    }
    catch {
      return new Response(null, { status: 404 })
    }
  })

  void installPreviewProtocol(
    ATTACHMENT_PROTOCOL,
    'attachmentId',
    'attachments.resolvePreview',
    attachmentsRequestSchemas.attachmentPreview,
  )
  void installPreviewProtocol(
    ARTIFACT_PROTOCOL,
    'artifactId',
    'artifacts.resolvePreview',
    artifactsRequestSchemas.artifactPreview,
  )

  return () => {
    protocol.unhandle(ATTACHMENT_PROTOCOL)
    protocol.unhandle(ARTIFACT_PROTOCOL)
  }
}

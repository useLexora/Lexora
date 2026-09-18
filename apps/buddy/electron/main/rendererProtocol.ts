import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { protocol } from 'electron'
import { containsCanonicalPath, filePaths } from '../../platform/filesystem/filePaths'

const RENDERER_PROTOCOL = 'lexora-app'
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

export const rendererSchemePrivileges: Electron.CustomScheme = {
  scheme: RENDERER_PROTOCOL,
  privileges: { codeCache: true, secure: true, standard: true, supportFetchAPI: true },
}

export function installRendererProtocol(rendererRoot = join(__dirname, '../renderer')): () => void {
  protocol.handle(RENDERER_PROTOCOL, async (request) => {
    const path = resolveRendererAssetPath(request.url, rendererRoot)
    if (!path)
      return new Response(null, { status: 404 })
    try {
      return new Response(await readFile(path), {
        headers: {
          'content-type': MIME_TYPES[extname(path)] ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
        },
      })
    }
    catch {
      return new Response(null, { status: 404 })
    }
  })
  return () => protocol.unhandle(RENDERER_PROTOCOL)
}

export function resolveRendererAssetPath(urlValue: string, rendererRoot: string): string | null {
  let url: URL
  try {
    const decodedValue = decodeURIComponent(urlValue)
    if (decodedValue.split(/[\\/]/).includes('..'))
      return null
    url = new URL(urlValue)
  }
  catch {
    return null
  }
  if (url.protocol !== `${RENDERER_PROTOCOL}:` || url.hostname !== 'renderer')
    return null
  try {
    const root = filePaths.resolveInput(rendererRoot)
    const path = filePaths.resolveInput(decodeURIComponent(url.pathname).replace(/^\/+/, ''), root)
    return containsCanonicalPath(root, path) ? path : null
  }
  catch {
    return null
  }
}

import type { Session } from 'electron'
import type { ExtensionPackage, ExtensionPackageStore } from '../../../platform/extensions/ExtensionPackageStore'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { extensionResourceRange } from '../../../platform/extensions/extensionResourceResponse'
import { EXTENSION_PROTOCOL } from '../../../shared/extensions/extensionManifest'
import { extensionResourceMimeType } from '../../../shared/extensions/extensionResources'
import hostSource from './runtime/host.js?raw'
import viewSource from './runtime/view.js?raw'

export const extensionSchemePrivileges: Electron.CustomScheme = {
  scheme: EXTENSION_PROTOCOL,
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
}

interface ExtensionEndpoint { token: string, kind: 'host' | 'view', package: ExtensionPackage, abort: AbortController }
const codeMime: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }

export class ExtensionProtocol {
  readonly #store: ExtensionPackageStore
  readonly #endpoints = new Map<string, ExtensionEndpoint>()
  constructor(store: ExtensionPackageStore) { this.#store = store }

  register(pkg: ExtensionPackage, kind: 'host' | 'view') {
    const token = randomUUID()
    const abort = new AbortController()
    this.#endpoints.set(token, { token, kind, package: pkg, abort })
    return { token, url: `${EXTENSION_PROTOCOL}://${token}/__${kind}.html`, dispose: () => {
      abort.abort()
      this.#endpoints.delete(token)
    } }
  }

  install(session: Session, kind: 'host' | 'view', token?: string): () => void {
    session.protocol.handle(EXTENSION_PROTOCOL, request => this.#respond(request, kind, token))
    return () => session.protocol.unhandle(EXTENSION_PROTOCOL)
  }

  validViewUrl(raw: string): boolean {
    try {
      const url = new URL(raw)
      return url.protocol === `${EXTENSION_PROTOCOL}:` && this.#endpoints.get(url.hostname)?.kind === 'view' && url.pathname === '/__view.html'
    }
    catch { return false }
  }

  async #respond(request: Request, kind: 'host' | 'view', requiredToken?: string): Promise<Response> {
    try {
      const url = new URL(request.url)
      const endpoint = this.#endpoints.get(url.hostname)
      if (!endpoint || endpoint.kind !== kind || (requiredToken && endpoint.token !== requiredToken) || !['GET', 'HEAD'].includes(request.method))
        return new Response(null, { status: 403 })
      const path = decodeURIComponent(url.pathname)
      const origin = `${EXTENSION_PROTOCOL}://${endpoint.token}`
      const csp = `default-src 'none'; script-src ${origin}/__package/ ${origin}/__${kind}.js; style-src ${origin}/__package/ 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} data: blob:; media-src ${origin} blob:; connect-src ${origin}/__package/ ${origin}/__resource/; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; ${kind === 'view' ? 'sandbox allow-scripts allow-forms; frame-ancestors lexora-app://renderer http://localhost:1420 http://127.0.0.1:1420' : 'frame-ancestors \'none\''}`
      const headers = { 'content-security-policy': csp, 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
      if (path.startsWith('/__resource/')) {
        if (kind !== 'view' || !endpoint.package.manifest.permissions.localResources)
          return new Response(null, { status: 403 })
        return await this.#store.resources.response(endpoint.package.manifest.id, path.slice('/__resource/'.length), request, endpoint.abort.signal)
      }
      if (path === `/__${kind}.html`) {
        return new Response(`<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><style>html,body{margin:0;min-height:100%;font:14px system-ui;color-scheme:light dark}main{padding:16px;overflow-wrap:anywhere}button,input{font:inherit}pre{overflow:auto}</style><main></main><script type="module" src="/__${kind}.js"></script>`, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
      }
      if (path === `/__${kind}.js`)
        return new Response(kind === 'host' ? hostSource : viewSource, { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' } })
      if (!path.startsWith('/__package/'))
        return new Response(null, { status: 404 })
      const name = path.slice('/__package/'.length)
      const body = await this.#store.asset(endpoint.package, name)
      if (!this.#endpoints.has(endpoint.token))
        return new Response(null, { status: 410 })
      const type = codeMime[extname(name)] ?? extensionResourceMimeType(extname(name).slice(1))
      const range = extensionResourceRange(body.byteLength, request.headers.get('range'))
      return new Response(request.method === 'HEAD' || range.status === 416 ? null : body.subarray(range.start, range.end + 1) as Uint8Array<ArrayBuffer>, { status: range.status, headers: { ...headers, ...range.headers, 'content-type': type } })
    }
    catch { return new Response(null, { status: 403 }) }
  }
}

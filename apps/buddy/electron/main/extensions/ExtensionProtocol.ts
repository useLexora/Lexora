import type { Session } from 'electron'
import type { ExtensionPackage, ExtensionPackageStore } from '../../../platform/extensions/ExtensionPackageStore'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { EXTENSION_PROTOCOL } from '../../../shared/extensions/extensionManifest'
import hostSource from './runtime/host.js?raw'
import viewSource from './runtime/view.js?raw'

export const extensionSchemePrivileges: Electron.CustomScheme = {
  scheme: EXTENSION_PROTOCOL,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}

interface ExtensionEndpoint { token: string, kind: 'host' | 'view', package: ExtensionPackage }
const mime: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' }

export class ExtensionProtocol {
  readonly #store: ExtensionPackageStore
  readonly #endpoints = new Map<string, ExtensionEndpoint>()
  constructor(store: ExtensionPackageStore) { this.#store = store }

  register(pkg: ExtensionPackage, kind: 'host' | 'view') {
    const token = randomUUID()
    this.#endpoints.set(token, { token, kind, package: pkg })
    return { token, url: `${EXTENSION_PROTOCOL}://${token}/__${kind}.html`, dispose: () => this.#endpoints.delete(token) }
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
      if (!endpoint || endpoint.kind !== kind || (requiredToken && endpoint.token !== requiredToken) || request.method !== 'GET')
        return new Response(null, { status: 403 })
      const path = decodeURIComponent(url.pathname)
      const origin = `${EXTENSION_PROTOCOL}://${endpoint.token}`
      const csp = `default-src 'none'; script-src ${origin}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; font-src ${origin}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; ${kind === 'view' ? 'sandbox allow-scripts allow-forms; frame-ancestors lexora-app://renderer http://localhost:1420 http://127.0.0.1:1420' : 'frame-ancestors \'none\''}`
      const headers = { 'content-security-policy': csp, 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
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
      return new Response(body as Uint8Array<ArrayBuffer>, { headers: { ...headers, 'content-type': mime[extname(name)] ?? 'application/octet-stream' } })
    }
    catch { return new Response(null, { status: 403 }) }
  }
}

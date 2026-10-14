import type { SyncConnection } from '../../shared/sync/syncApi'
import type { SyncAdapter, SyncTransport } from './SyncAdapter'
import { Buffer } from 'node:buffer'
import { DOMParser } from 'linkedom'
import { readLimitedResponse } from './SyncAdapter'

export class WebDavAdapter implements SyncAdapter {
  readonly #base: string
  readonly #directory: string
  readonly #root: string
  readonly #authorization: string
  readonly #request: SyncTransport
  constructor(connection: Extract<SyncConnection, { adapter: 'webdav' }>, password: string, request: SyncTransport) {
    this.#base = `${connection.endpoint.replace(/\/+$/, '')}/`
    this.#directory = (connection.directory ?? 'lexora').split('/').filter(Boolean).map(encodeURIComponent).join('/')
    this.#root = this.#directory ? new URL(`${this.#directory}/`, this.#base).href : this.#base
    this.#authorization = `Basic ${Buffer.from(`${connection.username}:${password}`).toString('base64')}`
    this.#request = request
  }

  async #send(key: string, method: string, signal: AbortSignal, headers: Record<string, string> = {}, body?: Uint8Array): Promise<Response> {
    if (key && !/^(?:lexora-backups-v1\/?|lexora-backups-v1\/(?:objects|snapshots)\/?|lexora-backups-v1\/objects\/(?:[a-f0-9-]{36}-)?[a-f0-9]{64}|lexora-backups-v1\/snapshots\/[a-f0-9-]{36}\.json)$/.test(key))
      throw new Error('SYNC_INVALID_KEY')
    return this.#sendUrl(new URL(key, key ? this.#root : this.#base).href, method, signal, headers, body)
  }

  async #sendUrl(url: string, method: string, signal: AbortSignal, headers: Record<string, string> = {}, body?: Uint8Array): Promise<Response> {
    const response = await this.#request(url, { method, headers: { ...headers, Authorization: this.#authorization }, ...(body ? { body } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) })
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel()
      throw new Error('SYNC_AUTHENTICATION_FAILED')
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error('SYNC_REDIRECT_REFUSED')
    }
    return response
  }

  async test(signal: AbortSignal): Promise<void> {
    const response = await this.#send('', 'PROPFIND', signal, { Depth: '0' })
    await response.body?.cancel()
    if (response.status !== 207)
      throw new Error('SYNC_WEBDAV_UNAVAILABLE')
  }

  async prepare(signal: AbortSignal): Promise<void> {
    let directory = ''
    for (const segment of this.#directory.split('/').filter(Boolean)) {
      directory += `${segment}/`
      const response = await this.#sendUrl(new URL(directory, this.#base).href, 'MKCOL', signal)
      await response.body?.cancel()
      if (![201, 204, 405].includes(response.status))
        throw new Error('SYNC_REMOTE_WRITE_FAILED')
    }
    for (const key of ['lexora-backups-v1/', 'lexora-backups-v1/objects/', 'lexora-backups-v1/snapshots/']) {
      const response = await this.#send(key, 'MKCOL', signal)
      await response.body?.cancel()
      if (![201, 204, 405].includes(response.status))
        throw new Error('SYNC_REMOTE_WRITE_FAILED')
    }
  }

  async list(signal: AbortSignal): Promise<string[]> {
    const key = 'lexora-backups-v1/snapshots/'
    const response = await this.#send(key, 'PROPFIND', signal, { Depth: '1' })
    if (response.status === 404) {
      await response.body?.cancel()
      return []
    }
    if (response.status !== 207) {
      await response.body?.cancel()
      throw new Error('SYNC_REMOTE_READ_FAILED')
    }
    const xml = new TextDecoder().decode(await readLimitedResponse(response, 4 * 1024 * 1024))
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new Error('SYNC_INVALID_RESPONSE')
    const document = new DOMParser().parseFromString(xml, 'text/xml')
    const prefix = new URL(key, this.#root)
    const ids = new Set<string>()
    for (const element of Array.from(document.querySelectorAll('*')) as Array<{ localName: string, textContent: string | null }>) {
      if (element.localName.split(':').at(-1) !== 'href')
        continue
      const url = new URL(element.textContent ?? '', prefix)
      if (url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname))
        continue
      const name = decodeURIComponent(url.pathname.slice(prefix.pathname.length))
      if (/^[a-f0-9-]{36}\.json$/.test(name))
        ids.add(name.slice(0, -5))
    }
    return [...ids].sort()
  }

  async read(key: string, limit: number, signal: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.#send(`lexora-backups-v1/${key}`, 'GET', signal)
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error('SYNC_REMOTE_READ_FAILED')
    }
    return readLimitedResponse(response, limit)
  }

  async remove(key: string, signal: AbortSignal): Promise<void> {
    const response = await this.#send(`lexora-backups-v1/${key}`, 'DELETE', signal)
    await response.body?.cancel()
    if (![200, 202, 204, 404].includes(response.status))
      throw new Error('SYNC_REMOTE_DELETE_FAILED')
  }

  async write(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const response = await this.#send(`lexora-backups-v1/${key}`, 'PUT', signal, { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' }, bytes)
    await response.body?.cancel()
    if (response.status === 412) {
      const existing = await this.read(key, bytes.length, signal)
      if (!existing || !Buffer.from(existing).equals(bytes))
        throw new Error('SYNC_REMOTE_CONFLICT')
      return
    }
    if (![200, 201, 204].includes(response.status))
      throw new Error('SYNC_REMOTE_WRITE_FAILED')
  }
}

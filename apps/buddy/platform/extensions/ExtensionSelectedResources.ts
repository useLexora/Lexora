import type { ExtensionFileOpeningSource, ExtensionResource } from '../../shared/extensions/extensionApi'
import type { TaskFileTarget } from '../../shared/files/taskFileApi'
import type { SpaceFileTarget } from '../../shared/spaces/spaceFileApi'
import type { ExtensionPackage, ExtensionPackageStore } from './ExtensionPackageStore'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { fileRange } from '../filesystem/fileRange'
import { readResponseBytes } from '../network/publicWebTransport'

export interface ExtensionSelectedResourceAccess {
  owner: object
  manifest: ExtensionPackage['manifest']
  signal: AbortSignal
  assertCurrent: () => void
}

interface ExtensionSelectedResourcePorts {
  readText: (target: SpaceFileTarget, signal: AbortSignal) => Promise<string>
  readResource?: (target: SpaceFileTarget, signal: AbortSignal, request?: Request) => Promise<Response>
  readArtifactResource?: (artifactId: string, signal: AbortSignal, request?: Request) => Promise<{ name: string, response: Response }>
  readTaskFileResource?: (target: TaskFileTarget, signal: AbortSignal, request?: Request) => Promise<{ name: string, response: Response }>
}

export class ExtensionSelectedResources {
  readonly #store: Pick<ExtensionPackageStore, 'resolveFileOpeningGrant'>
  readonly #ports: ExtensionSelectedResourcePorts
  readonly #snapshots = new Map<string, { owner: object, signal: AbortSignal, source: ExtensionFileOpeningSource, text: string, bytes: number, created: number }>()

  constructor(store: Pick<ExtensionPackageStore, 'resolveFileOpeningGrant'>, ports: ExtensionSelectedResourcePorts) {
    this.#store = store
    this.#ports = ports
  }

  hasSnapshot(id: string): boolean { return this.#snapshots.has(id) }

  snapshot(access: ExtensionSelectedResourceAccess, source: ExtensionFileOpeningSource, name: string, text: string, retained: (id: string) => boolean): ExtensionResource {
    const bytes = Buffer.byteLength(text)
    for (const [id, entry] of this.#snapshots) {
      if (entry.signal.aborted || (entry.created < Date.now() - 600000 && !retained(id)))
        this.#snapshots.delete(id)
    }
    if (bytes > 2 * 1024 * 1024 || this.#snapshots.size >= 64 || [...this.#snapshots.values()].reduce((total, entry) => total + entry.bytes, bytes) > 16 * 1024 * 1024)
      throw new Error('EXTENSION_RESOURCE_TEXT_LIMIT')
    const resource = { id: randomUUID(), name }
    this.#snapshots.set(resource.id, { owner: access.owner, signal: access.signal, source: structuredClone(source), text, bytes, created: Date.now() })
    return resource
  }

  release(id: string): void { this.#snapshots.delete(id) }

  releaseOwner(owner: object): void {
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.owner === owner)
        this.#snapshots.delete(id)
    }
  }

  async resolve(access: ExtensionSelectedResourceAccess, id: string): Promise<ExtensionFileOpeningSource> {
    if (access.manifest.permissions.selectedResource !== 'read')
      throw new Error('EXTENSION_RESOURCE_DENIED')
    const snapshot = this.#snapshots.get(id)
    if (snapshot && snapshot.owner !== access.owner)
      throw new Error('EXTENSION_RESOURCE_DENIED')
    const source = snapshot?.source ?? await this.#store.resolveFileOpeningGrant(access.manifest.id, id)
    access.assertCurrent()
    return source
  }

  async sourceResponse(source: ExtensionFileOpeningSource, signal: AbortSignal, request?: Request): Promise<{ name: string, response: Response }> {
    if (source.kind === 'artifact') {
      if (!this.#ports.readArtifactResource)
        throw new Error('EXTENSION_RESOURCE_UNAVAILABLE')
      return this.#ports.readArtifactResource(source.artifactId, signal, request)
    }
    if (source.kind === 'task') {
      if (!this.#ports.readTaskFileResource)
        throw new Error('EXTENSION_RESOURCE_UNAVAILABLE')
      return this.#ports.readTaskFileResource(source.target, signal, request)
    }
    const response = this.#ports.readResource
      ? await this.#ports.readResource(source.target, signal, request)
      : new Response(await this.#ports.readText(source.target, signal))
    return { name: source.target.path.split('/').at(-1) ?? source.target.path, response }
  }

  async response(access: ExtensionSelectedResourceAccess, id: string, lifetime: AbortSignal, request?: Request): Promise<Response> {
    const signal = AbortSignal.any([access.signal, lifetime])
    const source = await this.resolve(access, id)
    const snapshot = this.#snapshots.get(id)
    const { response } = await this.sourceResponse(source, signal, snapshot ? undefined : request)
    try {
      access.assertCurrent()
      signal.throwIfAborted()
    }
    catch (error) {
      await response.body?.cancel().catch(() => {})
      throw error
    }
    if (!snapshot)
      return response
    await response.body?.cancel()
    if (this.#snapshots.get(id) !== snapshot)
      throw new Error('EXTENSION_RESOURCE_DENIED')
    const bytes = Buffer.from(snapshot.text)
    const range = fileRange(bytes.length, request?.headers.get('range') ?? null)
    return new Response(request?.method === 'HEAD' || range.status === 416 ? null : bytes.subarray(range.start, range.end + 1), { status: range.status, headers: { ...range.headers, 'content-type': response.headers.get('content-type') ?? 'text/plain; charset=utf-8', 'content-security-policy': 'default-src \'none\'; sandbox', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' } })
  }

  async text(access: ExtensionSelectedResourceAccess, id: string, signal: AbortSignal): Promise<string> {
    const source = await this.resolve(access, id)
    if (source.kind === 'space' && !this.#snapshots.has(id))
      return this.#ports.readText(source.target, signal)
    const response = await this.response(access, id, signal)
    return new TextDecoder().decode(await readResponseBytes(response, 2 * 1024 * 1024))
  }

  async bytes(access: ExtensionSelectedResourceAccess, id: string, offset: number, length: number, signal: AbortSignal): Promise<{ base64: string, size: number, eof: boolean }> {
    const url = 'https://resource.invalid/'
    const metadata = await this.response(access, id, signal, new Request(url, { method: 'HEAD' }))
    const size = Number(metadata.headers.get('content-length'))
    await metadata.body?.cancel()
    if (!Number.isSafeInteger(size) || size < 0 || !metadata.headers.has('content-length'))
      throw new Error('EXTENSION_RESOURCE_UNSUPPORTED')
    if (offset >= size)
      return { base64: '', size, eof: true }
    const response = await this.response(access, id, signal, new Request(url, { headers: { range: `bytes=${offset}-${Math.min(offset + length, size) - 1}` } }))
    const bytes = Buffer.from(await readResponseBytes(response, length))
    return { base64: bytes.toString('base64'), size, eof: offset + bytes.length >= size }
  }
}

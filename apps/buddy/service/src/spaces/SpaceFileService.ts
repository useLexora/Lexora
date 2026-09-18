import type { LocalSpaceDirectoryPage, LocalSpaceFileEntry, LocalSpaceFilePreview, SpaceDirectoryRequest, SpaceFileTarget, SpaceSaveDocument, SpaceSaveResult, SpaceTextDocument } from '../../../shared/spaces/spaceFileApi'
import type { SpaceRepository } from '../storage/spaceRepository'
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { saveBoundedTextFile } from '../../../platform/filesystem/saveBoundedTextFile'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { readFilePreview } from '../files/readFilePreview'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { requireActiveSpace } from './requireActiveSpace'

export class SpaceFileService {
  readonly #spaces: Pick<SpaceRepository, 'findById'>
  readonly #saves = new Map<string, Promise<SpaceSaveResult>>()

  constructor(spaces: Pick<SpaceRepository, 'findById'>) {
    this.#spaces = spaces
  }

  async list(input: SpaceDirectoryRequest): Promise<LocalSpaceDirectoryPage> {
    const target = await this.resolve(input)
    const entries = (await readdir(target.path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
    const cursorIndex = input.cursor ? entries.findIndex(entry => entry.name === input.cursor) : -1
    const page = entries.slice(cursorIndex + 1, cursorIndex + 251)
    const result: LocalSpaceFileEntry[] = await Promise.all(page.map(async (entry) => {
      const path = input.path ? `${input.path}/${entry.name}` : entry.name
      let kind: 'directory' | 'file' = entry.isDirectory() ? 'directory' : 'file'
      let unavailable = false
      if (entry.isSymbolicLink()) {
        try {
          const resolved = await this.resolve({ ...input, path })
          kind = (await stat(resolved.path)).isDirectory() ? 'directory' : 'file'
        }
        catch {
          unavailable = true
        }
      }
      return { name: entry.name, path, kind, unavailable }
    }))
    this.requireDirectory(input)
    return { entries: result, nextCursor: cursorIndex + 1 + page.length < entries.length ? page.at(-1)?.name ?? null : null }
  }

  async read(input: SpaceFileTarget): Promise<LocalSpaceFilePreview> {
    const target = await this.resolve(input)
    this.requireDirectory(input)
    const preview = await readFilePreview(target.root, target.path)
    this.requireDirectory(input)
    return preview
  }

  async locate(input: SpaceFileTarget): Promise<{ path: string, kind: 'directory' | 'file' }> {
    const target = await this.resolve(input)
    const metadata = await stat(target.path)
    this.requireDirectory(input)
    if (!metadata.isDirectory() && !metadata.isFile())
      throw new BuddyServiceError('VALIDATION_FAILED')
    return { path: target.path, kind: metadata.isDirectory() ? 'directory' : 'file' }
  }

  async readDocument(input: SpaceFileTarget): Promise<SpaceTextDocument> {
    const target = await this.resolve(input)
    const bytes = await readBoundedFile(target.root, target.path, 1024 * 1024)
    this.requireDirectory(input)
    if (bytes.includes(0))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return { text, etag: createHash('sha256').update(bytes).digest('hex') }
  }

  saveDocument(input: SpaceSaveDocument): Promise<SpaceSaveResult> {
    const key = JSON.stringify([input.directoryId, input.revision, input.path])
    const previous = this.#saves.get(key) ?? Promise.resolve()
    const save = previous.catch(() => {}).then(async (): Promise<SpaceSaveResult> => {
      const target = await this.resolve(input)
      const current = await this.readDocument(input)
      if (current.etag !== input.etag)
        return { status: 'conflict', document: current }
      this.requireDirectory(input)
      const status = await saveBoundedTextFile({ ...target, expected: current.text, content: input.text })
      this.requireDirectory(input)
      return status === 'saved'
        ? { status, document: { text: input.text, etag: createHash('sha256').update(input.text).digest('hex') } }
        : { status, document: await this.readDocument(input) }
    }).finally(() => {
      if (this.#saves.get(key) === save)
        this.#saves.delete(key)
    })
    this.#saves.set(key, save)
    return save
  }

  private requireDirectory(input: SpaceFileTarget) {
    const space = requireActiveSpace(this.#spaces.findById(input.spaceId))
    const directory = space.primaryDirectory
    if (!directory || directory.id !== input.directoryId || directory.revision !== input.revision || directory.revokedAt)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return directory
  }

  private async resolve(input: SpaceFileTarget): Promise<{ path: string, root: string }> {
    const directory = this.requireDirectory(input)
    if (isAbsolute(input.path) || input.path.includes('\\') || input.path.split('/').includes('..'))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const target = await resolveGrantedPath([{
      canonicalRoot: directory.canonicalRoot,
      grantId: directory.id,
      kind: 'workspace',
      root: directory.root,
    }], resolve(directory.canonicalRoot, input.path), 'existing')
    this.requireDirectory(input)
    return { path: target.canonicalPath, root: directory.canonicalRoot }
  }
}

import type { LocalSpaceDirectoryPage, LocalSpaceFilePreview, SpaceDirectoryRequest, SpaceFileMutation, SpaceFileOperation, SpaceFilesChange, SpaceFileTarget, SpaceSaveDocument, SpaceSaveResult, SpaceTextDocument } from '../../../shared/spaces/spaceFileApi'
import type { FileAction, NativeFileEngine, NativeFileOperation } from '../files/NativeFileEngine'
import type { SpaceRepository } from '../storage/spaceRepository'
import type { SpaceWorkspaceDirectories } from './SpaceWorkspaceDirectories'
import { Buffer } from 'node:buffer'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BoundedFileReadError } from '../../../platform/filesystem/boundedFile'
import { Emitter } from '../../../shared/events/Emitter'
import { FILE_IMAGE_PREVIEW_MAX_BYTES } from '../../../shared/files/filePreview'
import { spaceFileMediaUrl } from '../../../shared/files/mediaPreview'
import { isSpaceWorkspaceDirectoryId } from '../../../shared/spaces/spaceApi'
import { GrantedPathError, resolveGrantedPath } from '../directories/resolveGrantedPath'
import { readFilePreview } from '../files/readFilePreview'
import { resolveMediaPreview } from '../files/resolveMediaPreview'
import { createSensitivePathMatcher } from '../permissions/sensitivePaths'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { requireActiveSpace } from './requireActiveSpace'

export type SpaceFileChange = SpaceFilesChange

const INTERNAL_WORKSPACE_ENTRIES: ReadonlySet<string> = new Set(['.attachments'])

export class SpaceFileService {
  readonly #spaces: Pick<SpaceRepository, 'findById'>
  readonly #engine: NativeFileEngine
  readonly #workspaces: SpaceWorkspaceDirectories | undefined
  readonly #changes = new Emitter<SpaceFileChange>(() => console.error('SPACE_FILE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #roots = new Map<string, SpaceFileTarget>()
  readonly #operations = new Map<string, SpaceFileTarget>()
  readonly #pending = new Set<Promise<unknown>>()
  readonly #subscription: { dispose: () => void }
  #revision = 0
  #disposed = false

  constructor(spaces: Pick<SpaceRepository, 'findById'>, engine: NativeFileEngine, workspaces?: SpaceWorkspaceDirectories) {
    this.#spaces = spaces
    this.#engine = engine
    this.#workspaces = workspaces
    this.#subscription = engine.onDidChange((event) => {
      if (event.event === 'changed') {
        for (const key of event.roots) {
          const input = this.#roots.get(key)
          if (!input)
            continue
          try {
            this.requireDirectory(input)
            this.publish(input, '', 'changed')
          }
          catch { void engine.revoke(key).catch(() => {}) }
        }
      }
    })
  }

  async list(input: SpaceDirectoryRequest): Promise<LocalSpaceDirectoryPage> {
    const root = await this.root(input)
    const result = await this.#engine.list(root, input.path, input.cursor)
    this.requireDirectory(input)
    const directory = this.requireDirectory(input)
    const sensitive = createSensitivePathMatcher()
    // The space's own folder also holds the app's attachment copies, which are not the user's files.
    const internal = isSpaceWorkspaceDirectoryId(directory.id) ? INTERNAL_WORKSPACE_ENTRIES : null
    return { ...result, entries: result.entries.filter(entry => !internal?.has(entry.path) && !sensitive.matches(resolve(directory.canonicalRoot, entry.path))) }
  }

  async read(input: SpaceFileTarget): Promise<LocalSpaceFilePreview> {
    const target = await this.resolve(input).catch(rethrowMissingFile)
    this.requireDirectory(input)
    const url = spaceFileMediaUrl(input)
    const preview = await readFilePreview(target.root, target.path, { image: url, media: url }).catch(error => rethrowMissingFile(error, target.path))
    this.requireDirectory(input)
    return preview
  }

  async resolveMedia(input: SpaceFileTarget) {
    const target = await this.resolve(input).catch(rethrowMissingFile)
    const preview = await resolveMediaPreview(target.root, target.path, { imageBytesLimit: FILE_IMAGE_PREVIEW_MAX_BYTES }).catch(error => rethrowMissingFile(error, target.path))
    const current = await this.resolve(input).catch(rethrowMissingFile)
    if (current.path !== preview.path || current.root !== preview.root)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
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
    const root = await this.root(input, 'existing').catch(rethrowMissingFile)
    const result = await this.#engine.read(root, input.path)
    this.requireDirectory(input)
    if (Buffer.byteLength(result.text) > 1024 * 1024)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return { text: result.text, etag: result.etag }
  }

  saveDocument(input: SpaceSaveDocument): Promise<SpaceSaveResult> {
    return this.track(async () => {
      if (Buffer.byteLength(input.text) > 1024 * 1024)
        throw new BuddyServiceError('VALIDATION_FAILED')
      const root = await this.root(input)
      let result: NativeFileOperation
      try {
        result = await this.#engine.mutate({ root, path: input.path, operationId: input.operationId, action: { kind: 'write', text: input.text, expected: input.etag } })
      }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'FILE_CONFLICT')
          throw error
        this.publish(input, input.operationId, 'conflict')
        return { status: 'conflict', document: await this.readDocument(input) }
      }
      this.requireDirectory(input)
      if (result.status === 'not-applied' && result.error === 'FILE_CONFLICT')
        return { status: 'conflict', document: await this.readDocument(input) }
      if (result.status !== 'applied' || typeof result.receipt?.etag !== 'string')
        throw new Error(result.error ?? 'FILE_RECOVERY_REQUIRED')
      this.publish(input, input.operationId, 'saved')
      try {
        this.requireDirectory(input)
      }
      catch (error) {
        this.publish(input, input.operationId, 'response-denied')
        throw error
      }
      return { status: 'saved', document: { text: input.text, etag: result.receipt.etag } }
    })
  }

  mutate(input: SpaceFileMutation): Promise<SpaceFileOperation> {
    return this.track(async () => {
      this.requireDirectory(input)
      this.#operations.set(input.operationId, input)
      try {
        const root = await this.root(input)
        if (input.action.kind === 'rename')
          await this.resolve({ ...input, path: input.action.destination }, 'create')
        const action: FileAction = input.action.kind === 'copy' || input.action.kind === 'move'
          ? { kind: input.action.kind, destinationRoot: await this.root(input.action.destination), destination: input.action.destination.path }
          : input.action
        if (action.kind === 'restore') {
          const original = await this.query({ ...input, operationId: action.originalOperationId })
          if (!original?.restorable || original.path !== input.path)
            throw new Error('FILE_INVALID_REQUEST')
        }
        const record = await this.#engine.mutate({ root, path: input.path, operationId: input.operationId, action })
        this.requireDirectory(input)
        if (input.action.kind === 'copy' || input.action.kind === 'move')
          this.requireDirectory(input.action.destination)
        this.publish(input, input.operationId, 'changed')
        return this.present(input, record)
      }
      finally { this.#operations.delete(input.operationId) }
    })
  }

  async history(input: SpaceFileTarget): Promise<SpaceFileOperation[]> {
    const records = await this.#engine.history(await this.root(input))
    return records.map(record => this.present(input, record))
  }

  async query(input: SpaceFileTarget & { operationId: string }): Promise<SpaceFileOperation | null> {
    await this.root(input)
    const record = await this.#engine.query(input.operationId)
    return record ? this.present(input, record) : null
  }

  async acknowledge(input: SpaceFileTarget & { operationId: string }): Promise<SpaceFileOperation> {
    const root = await this.root(input)
    const record = await this.#engine.acknowledge(root, input.operationId)
    await this.root(input)
    this.publish(input, input.operationId, 'changed')
    return this.present(input, record)
  }

  async cancel(input: SpaceFileTarget & { operationId: string }): Promise<null> {
    this.requireDirectory(input)
    const active = this.#operations.get(input.operationId)
    if (active && active.spaceId === input.spaceId && active.directoryId === input.directoryId && active.revision === input.revision)
      return this.#engine.cancel(input.operationId)
    await this.query(input)
    return null
  }

  revoke(directoryIds: readonly string[]): void {
    for (const [key, input] of this.#roots) {
      if (directoryIds.includes(input.directoryId)) {
        void this.#engine.revoke(key).catch(() => {})
        this.#roots.delete(key)
      }
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled(this.#pending)
    this.#subscription.dispose()
    this.#changes.dispose()
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed)
      return Promise.reject(new Error('SPACE_FILES_STOPPED'))
    const pending = operation().finally(() => this.#pending.delete(pending))
    this.#pending.add(pending)
    return pending
  }

  private async root(input: SpaceFileTarget, mode: 'existing' | 'create' = 'create'): Promise<string> {
    const directory = this.requireDirectory(input)
    await this.resolve(input, mode)
    const key = JSON.stringify([directory.id, directory.revision])
    await this.#engine.register(key, directory.canonicalRoot, true)
    this.requireDirectory(input)
    this.#roots.set(key, { ...input })
    return key
  }

  private present(input: SpaceFileTarget, record: NativeFileOperation): SpaceFileOperation {
    const directory = this.requireDirectory(input)
    const within = (path: string | null) => {
      if (path === null)
        return null
      const result = relative(directory.canonicalRoot, path)
      return isAbsolute(result) || result === '..' || result.startsWith(`..${sep}`) ? null : result.split(sep).join('/')
    }
    const path = within(record.source)
    const destination = within(record.destination)
    if (path === null && destination === null)
      throw new Error('FILE_PERMISSION_REVOKED')
    return { operationId: record.operationId, kind: record.kind, path, destination, status: record.status, error: record.error, createdAt: record.createdAt, updatedAt: record.updatedAt, temporaryPath: typeof record.receipt?.staging === 'string' ? within(record.receipt.staging) : null, restorable: record.kind === 'trash' && record.status === 'applied' && !!record.receipt && !record.receipt.restoredBy }
  }

  private publish(input: SpaceFileTarget, operationId: string, kind: SpaceFilesChange['kind']): void {
    this.#changes.fire({ revision: ++this.#revision, operationId, spaceId: input.spaceId, directoryId: input.directoryId, directoryRevision: input.revision, kind })
  }

  private requireDirectory(input: SpaceFileTarget) {
    const space = requireActiveSpace(this.#spaces.findById(input.spaceId))
    // A workspace id carries its space id, so another space's id never resolves to this space's folder.
    const workspace = isSpaceWorkspaceDirectoryId(input.directoryId) ? this.#workspaces?.get(space) ?? null : null
    const directory = [space.primaryDirectory, ...space.additionalDirectories, workspace].find(directory => directory?.id === input.directoryId)
    if (!directory || directory.revision !== input.revision || directory.revokedAt)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return directory
  }

  private async resolve(input: SpaceFileTarget, mode: 'existing' | 'create' = 'existing'): Promise<{ path: string, root: string }> {
    const directory = this.requireDirectory(input)
    if (isAbsolute(input.path) || input.path.includes('\\') || input.path.split('/').includes('..'))
      throw new BuddyServiceError('VALIDATION_FAILED')
    if (await realpath(directory.root) !== directory.canonicalRoot)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const requestedPath = resolve(directory.canonicalRoot, input.path)
    const target = await resolveGrantedPath([{
      canonicalRoot: directory.canonicalRoot,
      grantId: directory.id,
      kind: 'workspace',
      root: directory.root,
    }], requestedPath, mode)
    const sensitive = createSensitivePathMatcher()
    if (sensitive.matches(directory.root) || sensitive.matches(requestedPath) || sensitive.matches(target.canonicalPath))
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.requireDirectory(input)
    return { path: target.canonicalPath, root: directory.canonicalRoot }
  }
}

function rethrowMissingFile(error: unknown, targetPath?: string): never {
  if (error instanceof GrantedPathError && error.code === 'PATH_NOT_FOUND')
    throw new BuddyServiceError('FILE_NOT_FOUND')
  const failure = (error instanceof BoundedFileReadError && error.code === 'BOUNDED_FILE_READ_FAILED' ? error.cause : error) as NodeJS.ErrnoException | undefined
  if (targetPath && failure?.path === targetPath && (failure.code === 'ENOENT' || failure.code === 'ENOTDIR'))
    throw new BuddyServiceError('FILE_NOT_FOUND')
  throw error
}

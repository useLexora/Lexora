import type { SpaceIcon, SpaceIconColor } from '../../../shared/spaces/spaceAppearance'
import type { DirectoryGrantMutation } from '../directories/DirectoryGrantService'
import type {
  PersistedSpaceAdditionalDirectoryInput,
  PersistedSpacePrimaryDirectoryInput,
  SpaceAdditionalDirectoryBindingRecord,
  SpaceMemoryScope,
  SpaceRecord,
  SpaceRepository,
} from '../storage/spaceRepository'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { containsCanonicalPath } from '../../../platform/filesystem/filePaths'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { parseDirectorySearch, searchDirectoryEntries } from '../directories/searchDirectoryEntries'
import { requireActiveSpace } from './requireActiveSpace'

export interface SpaceAdditionalDirectoryInput {
  id: string | null
  root: string
}

export type SpacePrimaryDirectoryInput = SpaceAdditionalDirectoryInput

export interface SpaceFileSearchResult {
  directoryId: string
  kind?: 'file' | 'directory'
  name: string
  path: string
  relativePath: string
  root: string
}

export interface CreateSpaceInput {
  icon?: SpaceIcon
  iconColor?: SpaceIconColor
  memoryScope: SpaceMemoryScope
  name: string
  primaryDirectory: SpacePrimaryDirectoryInput | null
  primaryDirectorySelectionVerified: boolean
}

export interface UpdateSpaceInput extends CreateSpaceInput {
  spaceId: string
}

interface ResolvedSpaceDirectoryConfiguration {
  additionalDirectories: PersistedSpaceAdditionalDirectoryInput[]
  primaryDirectory: PersistedSpacePrimaryDirectoryInput | null
}

interface DirectoryConfigurationEntry {
  canonicalRoot: string
  id: string
  role: 'additional' | 'primary'
  root: string
}

export interface SpaceCommit {
  readonly sourceId: string
  readonly revision: number
  readonly spaceId: string
  readonly kind: 'created' | 'updated' | 'directory-granted' | 'deleted'
  readonly facets: readonly ('presentation' | 'directories' | 'memory' | 'availability')[]
  readonly directories: readonly { readonly id: string, readonly revision: number, readonly role: 'primary' | 'additional', readonly resourcesTrusted: boolean }[]
  readonly revokedDirectoryIds: readonly string[]
}

export class SpaceService {
  readonly #spaces: SpaceRepository
  readonly #sourceId = randomUUID()
  readonly #changes: Emitter<SpaceCommit>
  readonly #mutations = new Map<string, Promise<unknown>>()
  readonly onDidCommit
  #revision = 0
  #disposed = false
  #quiescing = false

  constructor(spaces: SpaceRepository, onListenerError: (error: unknown) => void = () => console.error('SPACE_OBSERVER_FAILED')) {
    this.#spaces = spaces
    this.#changes = new Emitter(onListenerError)
    this.onDidCommit = this.#changes.event
  }

  get revision(): number { return this.#revision }

  create(input: CreateSpaceInput): Promise<SpaceRecord> {
    const request = copyEventSnapshot(input)
    return this.#serialize(randomUUID(), () => this.#create(request))
  }

  async #create(input: CreateSpaceInput): Promise<SpaceRecord> {
    this.#requireOpen()
    const name = requireSpaceName(input.name)
    if (input.primaryDirectory && !input.primaryDirectorySelectionVerified)
      throw new SpaceDirectoryError()
    const createdAt = new Date().toISOString()
    const directories = await this.#resolveDirectoryConfiguration({
      additionalDirectories: [],
      primaryDirectory: input.primaryDirectory,
    }, null, createdAt)
    this.#requireOpen()
    const created = this.#spaces.create({
      additionalDirectories: directories.additionalDirectories,
      createdAt,
      id: randomUUID(),
      icon: input.icon,
      iconColor: input.iconColor,
      memoryScope: input.memoryScope,
      name,
      primaryDirectory: directories.primaryDirectory,
    })
    this.#publish('created', null, created)
    return created
  }

  update(input: UpdateSpaceInput): Promise<SpaceRecord> {
    const request = copyEventSnapshot(input)
    return this.#serialize(request.spaceId, () => this.#update(request))
  }

  async #update(input: UpdateSpaceInput): Promise<SpaceRecord> {
    const space = requireActiveSpace(this.#spaces.findById(input.spaceId))
    const name = requireSpaceName(input.name)
    if (
      input.primaryDirectory
      && input.primaryDirectory.id !== space.primaryDirectory?.id
      && !input.primaryDirectorySelectionVerified
    ) {
      throw new SpaceDirectoryError()
    }
    const updatedAt = new Date().toISOString()
    const directories = await this.#resolveDirectoryConfiguration({
      additionalDirectories: space.additionalDirectories
        .filter(directory => directory.id !== input.primaryDirectory?.id)
        .map(directory => ({ id: directory.id, root: directory.root })),
      primaryDirectory: input.primaryDirectory,
    }, space, updatedAt)
    if (
      directoryConfigurationChanged(space, directories)
      && this.#spaces.hasActiveRuns(space.id)
    ) {
      throw new SpaceHasActiveRunsError()
    }
    this.#requireOpen()
    if (!directoryConfigurationChanged(space, directories)
      && name === space.name && input.memoryScope === space.memoryScope
      && (input.icon ?? space.icon) === space.icon && (input.iconColor ?? space.iconColor) === space.iconColor) {
      return space
    }
    const updated = this.#spaces.update({
      additionalDirectories: directories.additionalDirectories,
      event: {
        createdAt: updatedAt,
        eventType: 'space.config.updated',
        id: randomUUID(),
        payload: {
          changes: {
            directories: summarizeDirectoryChanges(space, directories),
            memoryScope: { from: space.memoryScope, to: input.memoryScope },
            name: { from: space.name, to: name },
            icon: { from: space.icon, to: input.icon ?? space.icon },
            iconColor: { from: space.iconColor, to: input.iconColor ?? space.iconColor },
          },
        },
        spaceId: space.id,
      },
      id: space.id,
      icon: input.icon,
      iconColor: input.iconColor,
      memoryScope: input.memoryScope,
      name,
      primaryDirectory: directories.primaryDirectory,
      updatedAt,
    })
    this.#publish('updated', space, updated)
    return updated
  }

  grantAdditionalDirectory(input: {
    root: string
    spaceId: string
  }): Promise<DirectoryGrantMutation> {
    const request = copyEventSnapshot(input)
    return this.#serialize(request.spaceId, () => this.#grantAdditionalDirectory(request))
  }

  async #grantAdditionalDirectory(input: { root: string, spaceId: string }): Promise<DirectoryGrantMutation> {
    requireActiveSpace(this.#spaces.findById(input.spaceId))
    const resolved = await resolveSpaceDirectory(input.root, { create: true })
    this.#requireOpen()
    const space = requireActiveSpace(this.#spaces.findById(input.spaceId))

    const existing = [...getSpaceDirectories(space)]
      .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)
      .find(directory => containsDirectory(directory.canonicalRoot, resolved.canonicalRoot))
    if (existing) {
      return {
        changed: false,
        coveredGrantIds: [],
        grant: {
          canonicalRoot: existing.canonicalRoot,
          id: existing.id,
          root: existing.root,
        },
      }
    }

    const coveredDirectories = space.additionalDirectories.filter(directory => (
      containsDirectory(resolved.canonicalRoot, directory.canonicalRoot)
    ))
    const nextDirectoryCount = getSpaceDirectories(space).length - coveredDirectories.length + 1
    if (nextDirectoryCount > 32)
      throw new SpaceDirectoryError()

    const updatedAt = new Date().toISOString()
    const grantedDirectory: PersistedSpaceAdditionalDirectoryInput = {
      accessGrantedAt: updatedAt,
      canonicalRoot: resolved.canonicalRoot,
      id: randomUUID(),
      root: resolved.root,
    }
    const coveredDirectoryIds = new Set(coveredDirectories.map(directory => directory.id))
    const directories: ResolvedSpaceDirectoryConfiguration = {
      additionalDirectories: [
        ...space.additionalDirectories
          .filter(directory => !coveredDirectoryIds.has(directory.id))
          .map(toPersistedAdditionalDirectory),
        grantedDirectory,
      ],
      primaryDirectory: space.primaryDirectory
        ? toPersistedPrimaryDirectory(space.primaryDirectory)
        : null,
    }
    const updated = this.#spaces.update({
      additionalDirectories: directories.additionalDirectories,
      event: {
        createdAt: updatedAt,
        eventType: 'space.config.updated',
        id: randomUUID(),
        payload: {
          authorization: {
            coveredGrantIds: [...coveredDirectoryIds],
            root: resolved.root,
          },
          changes: {
            directories: summarizeDirectoryChanges(space, directories),
            memoryScope: { from: space.memoryScope, to: space.memoryScope },
            name: { from: space.name, to: space.name },
          },
        },
        spaceId: space.id,
      },
      id: space.id,
      memoryScope: space.memoryScope,
      name: space.name,
      primaryDirectory: directories.primaryDirectory,
      updatedAt,
    })
    this.#publish('directory-granted', space, updated)
    const directory = updated.additionalDirectories.find(
      candidate => candidate.id === grantedDirectory.id,
    )
    if (!directory)
      throw new SpaceDirectoryError()
    return {
      changed: true,
      coveredGrantIds: [...coveredDirectoryIds],
      grant: {
        canonicalRoot: directory.canonicalRoot,
        id: directory.id,
        root: directory.root,
      },
    }
  }

  delete(spaceId: string): Promise<SpaceRecord> {
    return this.#serialize(spaceId, () => this.#delete(spaceId))
  }

  #delete(spaceId: string): SpaceRecord {
    const space = requireActiveSpace(this.#spaces.findById(spaceId))
    if (this.#spaces.hasActiveRuns(spaceId))
      throw new SpaceHasActiveRunsError()
    const deletedAt = new Date().toISOString()
    const deleted = this.#spaces.delete(spaceId, deletedAt, {
      createdAt: deletedAt,
      eventType: 'space.deleted',
      id: randomUUID(),
      payload: {
        directoryIds: getSpaceDirectories(space).map(directory => directory.id),
        memoryScope: space.memoryScope,
        name: space.name,
      },
      spaceId,
    })
    this.#publish('deleted', space, deleted)
    return deleted
  }

  async quiesce(): Promise<void> {
    this.#quiescing = true
    while (this.#mutations.size)
      await Promise.allSettled([...this.#mutations.values()])
  }

  async dispose(): Promise<void> {
    await this.quiesce()
    this.#disposed = true
    this.#changes.dispose()
  }

  #requireOpen(): void {
    if (this.#disposed)
      throw new Error('SPACE_SERVICE_STOPPED')
  }

  #serialize<T>(spaceId: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.#quiescing)
      return Promise.reject(new Error('SPACE_SERVICE_STOPPED'))
    this.#requireOpen()
    const previous = this.#mutations.get(spaceId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => {
      this.#requireOpen()
      return operation()
    }).finally(() => {
      if (this.#mutations.get(spaceId) === pending)
        this.#mutations.delete(spaceId)
    })
    this.#mutations.set(spaceId, pending)
    return pending
  }

  #publish(kind: SpaceCommit['kind'], before: SpaceRecord | null, current: SpaceRecord): void {
    const facets: Array<SpaceCommit['facets'][number]> = []
    if (!before || before.name !== current.name || before.icon !== current.icon || before.iconColor !== current.iconColor)
      facets.push('presentation')
    if (!before || before.memoryScope !== current.memoryScope)
      facets.push('memory')
    const directories = getSpaceDirectories(current).map(directory => ({
      id: directory.id,
      revision: directory.revision,
      role: directory.id === current.primaryDirectory?.id ? 'primary' as const : 'additional' as const,
      resourcesTrusted: directory.id === current.primaryDirectory?.id && Boolean(current.primaryDirectory.resourcesTrustedAt),
    }))
    if (!before || JSON.stringify(getSpaceDirectories(before)) !== JSON.stringify(getSpaceDirectories(current)))
      facets.push('directories')
    if (!before || before.revokedAt !== current.revokedAt)
      facets.push('availability')
    this.#changes.fire(copyEventSnapshot({
      sourceId: this.#sourceId,
      revision: ++this.#revision,
      spaceId: current.id,
      kind,
      facets,
      directories,
      revokedDirectoryIds: before ? getSpaceDirectories(before).filter(directory => !directories.some(current => current.id === directory.id)).map(directory => directory.id) : [],
    }))
  }

  list(): readonly SpaceRecord[] {
    return this.#spaces.list()
  }

  isGrantCurrent(spaceId: string, grantId: string): boolean {
    const space = this.#spaces.findById(spaceId)
    return Boolean(space && !space.revokedAt && getSpaceDirectories(space).some(directory => directory.id === grantId && !directory.revokedAt))
  }

  async searchFiles(spaceId: string, query: string, deepSearch = false): Promise<SpaceFileSearchResult[]> {
    const space = requireActiveSpace(this.#spaces.findById(spaceId))
    const primary = space.primaryDirectory
    if (!primary && !isAbsolute(query))
      return []
    const parsed = parseDirectorySearch(query, primary?.canonicalRoot ?? query)
    const directory = getSpaceDirectories(space)
      .filter(directory => !directory.revokedAt && containsCanonicalPath(directory.canonicalRoot, parsed.path))
      .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)[0]
    if (!directory)
      return []
    const result = await searchDirectoryEntries({ canonicalRoot: directory.canonicalRoot, grantId: directory.id, kind: 'workspace', root: directory.root }, parsed.path, parsed.term, deepSearch)
    const current = requireActiveSpace(this.#spaces.findById(spaceId))
    if (!getSpaceDirectories(current).some(candidate => candidate.id === directory.id && candidate.revision === directory.revision && !candidate.revokedAt))
      throw new SpaceDirectoryError()
    return result.entries.map(entry => ({ ...entry, directoryId: directory.id, relativePath: relative(directory.canonicalRoot, entry.path), root: directory.root }))
  }

  async #resolveDirectoryConfiguration(
    input: {
      additionalDirectories: readonly SpaceAdditionalDirectoryInput[]
      primaryDirectory: SpacePrimaryDirectoryInput | null
    },
    currentSpace: SpaceRecord | null,
    timestamp: string,
  ): Promise<ResolvedSpaceDirectoryConfiguration> {
    if (input.additionalDirectories.length + Number(Boolean(input.primaryDirectory)) > 32)
      throw new SpaceDirectoryError()
    const currentById = new Map(
      currentSpace
        ? getSpaceDirectories(currentSpace).map(directory => [directory.id, directory])
        : [],
    )
    const resolveIdentity = async (directory: SpaceAdditionalDirectoryInput) => {
      const existing = directory.id ? currentById.get(directory.id) : null
      if (directory.id && !existing)
        throw new SpaceDirectoryError()
      if (existing && resolve(directory.root) !== existing.root)
        throw new SpaceDirectoryError()
      if (existing) {
        return {
          accessGrantedAt: existing.accessGrantedAt,
          canonicalRoot: existing.canonicalRoot,
          id: existing.id,
          root: existing.root,
        }
      }
      const resolved = await resolveSpaceDirectory(directory.root)
      return {
        accessGrantedAt: timestamp,
        canonicalRoot: resolved.canonicalRoot,
        id: randomUUID(),
        root: resolved.root,
      }
    }
    const [primaryIdentity, additionalDirectories] = await Promise.all([
      input.primaryDirectory ? resolveIdentity(input.primaryDirectory) : null,
      Promise.all(input.additionalDirectories.map(resolveIdentity)),
    ])
    const directories = [
      ...(primaryIdentity ? [primaryIdentity] : []),
      ...additionalDirectories,
    ]
    if (new Set(directories.map(directory => directory.id)).size !== directories.length)
      throw new SpaceDirectoryError()
    if (new Set(directories.map(directory => directory.canonicalRoot)).size !== directories.length)
      throw new SpaceDirectoryError()
    const currentPrimary = currentSpace?.primaryDirectory ?? null
    return {
      additionalDirectories,
      primaryDirectory: primaryIdentity && input.primaryDirectory
        ? {
            ...primaryIdentity,
            resourcesTrustedAt: currentPrimary?.id === primaryIdentity.id
              ? currentPrimary.resourcesTrustedAt
              : timestamp,
          }
        : null,
    }
  }
}

function directoryConfigurationChanged(
  space: SpaceRecord,
  directories: ResolvedSpaceDirectoryConfiguration,
): boolean {
  const current = getPersistedDirectoryConfiguration(space)
  const next = getResolvedDirectoryConfiguration(directories)
  return JSON.stringify(current) !== JSON.stringify(next)
}

function compareDirectoryConfiguration(
  left: { id: string },
  right: { id: string },
): number {
  return left.id.localeCompare(right.id)
}

function summarizeDirectoryChanges(
  space: SpaceRecord,
  directories: ResolvedSpaceDirectoryConfiguration,
) {
  const current = getPersistedDirectoryConfiguration(space)
  const next = getResolvedDirectoryConfiguration(directories)
  const currentById = new Map(current.map(directory => [directory.id, directory]))
  const nextById = new Map(next.map(directory => [directory.id, directory]))
  return {
    added: next.filter(directory => !currentById.has(directory.id)),
    removed: current.filter(directory => !nextById.has(directory.id)),
    updated: next.filter((directory) => {
      const current = currentById.get(directory.id)
      return current && current.role !== directory.role
    }).map((directory) => {
      const current = currentById.get(directory.id)!
      return {
        id: directory.id,
        role: { from: current.role, to: directory.role },
      }
    }),
  }
}

function getPersistedDirectoryConfiguration(space: SpaceRecord): DirectoryConfigurationEntry[] {
  return [
    ...(space.primaryDirectory
      ? [{
          canonicalRoot: space.primaryDirectory.canonicalRoot,
          id: space.primaryDirectory.id,
          role: 'primary' as const,
          root: space.primaryDirectory.root,
        }]
      : []),
    ...space.additionalDirectories.map(directory => ({
      canonicalRoot: directory.canonicalRoot,
      id: directory.id,
      role: 'additional' as const,
      root: directory.root,
    })),
  ].sort(compareDirectoryConfiguration)
}

function getResolvedDirectoryConfiguration(
  configuration: ResolvedSpaceDirectoryConfiguration,
): DirectoryConfigurationEntry[] {
  return [
    ...(configuration.primaryDirectory
      ? [{
          canonicalRoot: configuration.primaryDirectory.canonicalRoot,
          id: configuration.primaryDirectory.id,
          role: 'primary' as const,
          root: configuration.primaryDirectory.root,
        }]
      : []),
    ...configuration.additionalDirectories.map(directory => ({
      canonicalRoot: directory.canonicalRoot,
      id: directory.id,
      role: 'additional' as const,
      root: directory.root,
    })),
  ].sort(compareDirectoryConfiguration)
}

function getSpaceDirectories(space: SpaceRecord) {
  return [
    ...(space.primaryDirectory ? [space.primaryDirectory] : []),
    ...space.additionalDirectories,
  ]
}

function toPersistedAdditionalDirectory(
  directory: SpaceAdditionalDirectoryBindingRecord,
): PersistedSpaceAdditionalDirectoryInput {
  return {
    accessGrantedAt: directory.accessGrantedAt,
    canonicalRoot: directory.canonicalRoot,
    id: directory.id,
    root: directory.root,
  }
}

function toPersistedPrimaryDirectory(
  directory: NonNullable<SpaceRecord['primaryDirectory']>,
): PersistedSpacePrimaryDirectoryInput {
  return {
    ...toPersistedAdditionalDirectory(directory),
    resourcesTrustedAt: directory.resourcesTrustedAt,
  }
}

function containsDirectory(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate === root || candidate.startsWith(prefix)
}

function requireSpaceName(value: string): string {
  const name = value.trim()
  if (!name)
    throw new SpaceDirectoryError()
  return name
}

async function resolveSpaceDirectory(
  root: string,
  options: { create?: boolean } = {},
) {
  const absoluteRoot = resolve(root)
  try {
    if (options.create)
      await mkdir(absoluteRoot, { recursive: true })
    const canonicalRoot = await realpath(absoluteRoot)
    if (options.create && canonicalRoot !== absoluteRoot)
      throw new Error('Directory identity changed')
    const metadata = await stat(canonicalRoot)
    if (!metadata.isDirectory())
      throw new Error('Not a directory')
    return { canonicalRoot, root: absoluteRoot }
  }
  catch {
    throw new SpaceDirectoryError()
  }
}

export class SpaceDirectoryError extends Error {
  readonly code = 'DIRECTORY_NOT_AUTHORIZED'

  constructor() {
    super('Lexora Buddy directory is not authorized')
    this.name = 'SpaceDirectoryError'
  }
}

export class SpaceHasActiveRunsError extends Error {
  readonly code = 'SPACE_HAS_ACTIVE_RUNS'

  constructor() {
    super('Lexora Buddy cannot change space directories or delete a space with active runs')
    this.name = 'SpaceHasActiveRunsError'
  }
}

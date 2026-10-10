import type { Event, ListenerErrorHandler } from '../../../shared/events/Emitter'
import type { LocalSkill, LocalSkillCatalog, SkillDirectoryRequest, SkillFileTarget, SkillInstallPreview, SkillOrigin, SkillPreviewInput, SkillReference } from '../../../shared/skills/skillApi'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { SkillInstallation, SkillRepository } from '../storage/skillRepository'
import type { SpaceRepository } from '../storage/spaceRepository'
import type { SkillEvent, SkillEventDetails } from './skillEvents'
import type { LoadedSkill } from './skillFiles'
import type { ResolvedSkill } from './SkillPackageCache'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { Emitter, filterEvent } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { isSkillAvailable, skillsRpc } from '../../../shared/skills/skillApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'
import { validateSkillForAuthoring } from './skillAuthoringValidation'
import { discoverSkillFiles, readSkill, requireSkillPath, SkillError, skillIdentity } from './skillFiles'
import { prepareSkillSource, writeSkillFiles } from './skillImport'
import { SkillInspector } from './SkillInspector'
import { SkillPackageCache } from './SkillPackageCache'

export interface BuddySkillResolution {
  readonly diagnostics: LocalSkillCatalog['diagnostics']
  readonly paths: readonly string[]
  readonly readRoots: readonly string[]
  readonly references: readonly SkillReference[]
  readonly revision: string
  readonly skills: readonly LocalSkill[]
}

export interface BuddyMaterializedSkill {
  baseDirectory: string
  body: string
  filePath: string
  name: string
  reference: SkillReference
}

interface SkillServiceOptions {
  agentDirectory: string
  builtinSkillsDirectories?: readonly string[]
  spaces: SpaceRepository
  repository: SkillRepository
  paths: BuddyDataPaths
  onListenerError?: ListenerErrorHandler
}

interface Candidate {
  allowedRoot: string | null
  entry: LocalSkill
  loaded: ResolvedSkill | null
  priority: number
  referenceRevision: string
}

interface ResolvedCatalog {
  readonly candidates: readonly Readonly<Candidate>[]
  readonly catalog: LocalSkillCatalog
}

interface ImportPreview {
  result: SkillInstallPreview
  directory: string
  candidates: Map<string, { loaded: LoadedSkill, sourcePath: string, existing: SkillInstallation | undefined, existingRevision: string | undefined }>
  createdAt: number
}

export class SkillService {
  readonly #options: SkillServiceOptions
  readonly #previews = new Map<string, ImportPreview>()
  readonly #inspector: SkillInspector
  readonly #packages = new SkillPackageCache()
  readonly #resolutions = new Map<string, Promise<ResolvedCatalog>>()
  readonly #resolved = new Map<string, { key: string, result: ResolvedCatalog }>()
  readonly #accepted = new Map<string, string>()
  readonly #resources = new Map<string | null, BuddySkillResolution>()
  readonly #scopeGenerations = new Map<string | null, number>()
  readonly #cleanupStates = new Map<string, Extract<SkillEvent, { type: 'cleanup' }>['status']>()
  readonly #events: Emitter<SkillEvent>
  readonly sourceId = randomUUID()
  #mutation: Promise<unknown> = Promise.resolve()
  #generation = 0
  #globalGeneration = 0
  #sequence = 0
  #disposed = false
  #quiescing = false
  readonly #operations = new Set<Promise<unknown>>()

  constructor(options: SkillServiceOptions) {
    this.#options = options
    this.#events = new Emitter(options.onListenerError ?? (() => console.error('SKILL_OBSERVER_FAILED')))
    this.#inspector = new SkillInspector({ ...options, refresh: spaceId => this.list(spaceId) })
  }

  readonly onDidChange: Event<SkillEvent> = (listener, options) => this.#events.event(listener, options)
  readonly onDidCommitInstallation = filterEvent(this.onDidChange, (event): event is Extract<SkillEvent, { type: 'installation' }> => event.type === 'installation')
  readonly onDidAcceptCatalog = filterEvent(this.onDidChange, (event): event is Extract<SkillEvent, { type: 'catalog' }> => event.type === 'catalog')
  readonly onDidChangeResources = filterEvent(this.onDidChange, (event): event is Extract<SkillEvent, { type: 'resources' }> => event.type === 'resources')
  readonly onDidCleanup = filterEvent(this.onDidChange, (event): event is Extract<SkillEvent, { type: 'cleanup' }> => event.type === 'cleanup')

  resourceSnapshots(): readonly { readonly spaceId: string | null, readonly resolution: BuddySkillResolution }[] {
    return Object.freeze([...this.#resources].map(([spaceId, resolution]) => Object.freeze({ spaceId, resolution })))
  }

  async initialize() {
    await this.#cleanup()
    const imports = join(this.#options.paths.root, 'skill-imports')
    try {
      await requireSkillPath(this.#options.paths.root, imports)
      for (const entry of await readdir(imports, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.name))
          await rm(join(imports, entry.name), { recursive: true, force: true })
      }
    }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error
    }
  }

  list(spaceId: string | null, metadataOnly = false): Promise<LocalSkillCatalog> {
    if (this.#quiescing)
      return Promise.reject(new SkillError('SKILL_CHANGED'))
    return this.#list(spaceId, metadataOnly)
  }

  #list(spaceId: string | null, metadataOnly = false): Promise<LocalSkillCatalog> {
    return this.#track(async () => {
      this.#invalidateResolutions(spaceId)
      return (await this.#resolve(spaceId, metadataOnly)).catalog
    })
  }

  loadForSpace(spaceId: string | null): Promise<BuddySkillResolution> {
    return this.#track(async () => this.#sessionResolution(await this.#resolve(spaceId, true)))
  }

  materializeForSpace(spaceId: string | null, selections: readonly (string | SkillReference)[]): Promise<BuddyMaterializedSkill[]> {
    if (this.#quiescing)
      return Promise.reject(new SkillError('SKILL_CHANGED'))
    const request = copyEventSnapshot(selections)
    return this.#track(() => this.#materializeForSpace(spaceId, request))
  }

  async #materializeForSpace(spaceId: string | null, selections: readonly (string | SkillReference)[]): Promise<BuddyMaterializedSkill[]> {
    if (!selections.length)
      return []
    const { candidates } = await this.#resolve(spaceId, true)
    const state = this.#resolutionKey(spaceId, true)
    const selected = new Map<string, BuddyMaterializedSkill>()
    for (const selection of selections) {
      const name = typeof selection === 'string' ? selection : selection.name
      const candidate = candidates.find(item => item.entry.name === name && isSkillAvailable(item.entry))
      if (!candidate?.allowedRoot)
        throw new SkillError('SKILL_NOT_FOUND')
      let loaded: ResolvedSkill
      try {
        loaded = await this.#packages.load(candidate.entry.filePath, candidate.allowedRoot)
      }
      catch (error) {
        this.#invalidateResolutions(spaceId)
        throw error
      }
      if (loaded.referenceRevision !== candidate.referenceRevision) {
        this.#invalidateResolutions(spaceId)
        throw new SkillError('SKILL_CHANGED')
      }
      if (typeof selection !== 'string' && (
        selection.id !== candidate.entry.id
        || (selection.revision !== candidate.referenceRevision && selection.revision !== loaded.revision)
        || (selection.packageRevision && selection.packageRevision !== loaded.revision)
      )) {
        throw new SkillError('SKILL_CHANGED')
      }
      selected.set(name, {
        name,
        body: loaded.body,
        filePath: candidate.entry.filePath,
        baseDirectory: loaded.baseDirectory,
        reference: reference(candidate.entry, candidate.referenceRevision, loaded.revision),
      })
    }
    if (this.#resolutionKey(spaceId, true) !== state)
      throw new SkillError('SKILL_CHANGED')
    return [...selected.values()]
  }

  get(spaceId: string | null, id: string) {
    return this.#inspector.get(spaceId, id)
  }

  listFiles(input: SkillDirectoryRequest) {
    return this.#inspector.listFiles(input)
  }

  readFile(input: SkillFileTarget) {
    return this.#inspector.readFile(input)
  }

  locateFile(input: SkillFileTarget) {
    return this.#inspector.locateFile(input)
  }

  setEnabled(input: { spaceId: string | null, id: string, enabled: boolean, revision: string }) {
    input = copyEventSnapshot(input)
    return this.#mutate(async () => {
      const skill = await this.#currentSkill(input.spaceId, input.id)
      if (skill.managedBy === 'directory' || skill.spaceId !== input.spaceId)
        throw new SkillError('SKILL_READ_ONLY')
      if (skill.revision !== input.revision)
        throw new SkillError('SKILL_CHANGED')
      const record = this.#record(input.id)
      if (record.enabled === input.enabled)
        return (await this.#resolve(input.spaceId)).catalog
      this.#options.repository.save({ ...record, enabled: input.enabled, updatedAt: new Date().toISOString() })
      this.#installationCommitted(input.spaceId, 'enabled', [record.id])
      return this.#list(input.spaceId)
    })
  }

  remove(input: { spaceId: string | null, id: string, revision: string }) {
    input = copyEventSnapshot(input)
    return this.#mutate(async () => {
      const skill = await this.#currentSkill(input.spaceId, input.id)
      if (!skill.canRemove)
        throw new SkillError('SKILL_READ_ONLY')
      if (skill.revision !== input.revision)
        throw new SkillError('SKILL_CHANGED')
      this.#assertIdle(skill.spaceId)
      this.#options.repository.remove(input.id)
      this.#installationCommitted(input.spaceId, 'removed', [input.id])
      await this.#cleanup()
      return this.#list(input.spaceId)
    })
  }

  preview(input: SkillPreviewInput, mode: 'import' | 'authoring' = 'import'): Promise<SkillInstallPreview> {
    if (this.#quiescing)
      return Promise.reject(new SkillError('SKILL_CHANGED'))
    const request = copyEventSnapshot(input)
    return this.#track(() => this.#preview(request, mode))
  }

  async #preview(input: SkillPreviewInput, mode: 'import' | 'authoring'): Promise<SkillInstallPreview> {
    this.#requireSpace(input.spaceId)
    for (const [id, preview] of this.#previews) {
      if (Date.now() - preview.createdAt > 30 * 60 * 1000)
        await this.discard(id)
    }
    if (this.#previews.size >= 8)
      throw new SkillError('SKILL_BUSY')
    const catalog = await this.#list(input.spaceId)
    const records = this.#options.repository.list()
    const updating = input.updateId ? this.#record(input.updateId) : undefined
    if (updating && (updating.managedBy !== 'user' || updating.spaceId !== input.spaceId))
      throw new SkillError('SKILL_READ_ONLY')
    const id = randomUUID()
    const directory = join(this.#options.paths.root, 'skill-imports', id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const prepared = await prepareSkillSource(input.source, directory)
      const diagnostics: Array<{ code: 'SKILL_INVALID', message: string, path: string }> = []
      const paths = mode === 'authoring'
        ? [join(prepared.root, 'SKILL.md')]
        : await discoverSkillFiles(prepared.root, false, path => diagnostics.push({ code: 'SKILL_INVALID', message: 'Skill source is outside the selected folder or cannot be read.', path }))
      const candidates: ImportPreview['candidates'] = new Map()
      const items: Array<SkillInstallPreview['candidates'][number]> = []
      let totalBytes = 0
      let totalFiles = 0
      for (const path of paths) {
        try {
          const loaded = await readSkill(path, prepared.root)
          if (mode === 'authoring') {
            const issues = validateSkillForAuthoring(loaded)
            if (issues.length) {
              diagnostics.push(...issues.map(message => ({ code: 'SKILL_INVALID' as const, message, path })))
              continue
            }
          }
          if (!loaded.hasDeclaredName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(loaded.name) || loaded.name.length > 64 || loaded.description.length > 1024)
            throw new SkillError('SKILL_INVALID')
          if (updating && loaded.name !== updating.name)
            continue
          totalBytes += [...loaded.files.values()].reduce((sum, file) => sum + file.length, 0)
          totalFiles += loaded.files.size
          if (totalBytes > 64 * 1024 * 1024 || totalFiles > 5000 || items.length >= 100)
            throw new SkillError('SKILL_TOO_LARGE')
          const candidateId = randomUUID()
          const existing = records.find(record => record.spaceId === input.spaceId && record.name === loaded.name && record.managedBy === 'user')
          const reserved = input.spaceId === null && records.some(record => record.managedBy === 'application' && record.name === loaded.name)
          const sourcePath = relative(prepared.root, dirname(path)).split('\\').join('/')
          candidates.set(candidateId, { loaded, sourcePath, existing, existingRevision: catalog.skills.find(skill => skill.id === existing?.id)?.revision })
          items.push({
            id: candidateId,
            name: loaded.name,
            description: loaded.description,
            revision: loaded.revision,
            bytes: [...loaded.files.values()].reduce((total, file) => total + file.length, 0),
            fileCount: loaded.files.size,
            replacesId: existing?.id ?? null,
            blocked: reserved,
          })
        }
        catch (error) {
          if (error instanceof SkillError && error.code === 'SKILL_TOO_LARGE')
            throw error
          diagnostics.push({ code: 'SKILL_INVALID', message: 'Skill metadata or bundled resources are invalid.', path })
        }
      }
      const checkedItems = items.map(item => ({ ...item, blocked: item.blocked || items.filter(other => other.name === item.name).length > 1 }))
      const result = copyEventSnapshot({ id, spaceId: input.spaceId, updateId: updating?.id ?? null, source: prepared.source, candidates: checkedItems, diagnostics })
      if (this.#disposed)
        throw new SkillError('SKILL_CHANGED')
      this.#requireSpace(input.spaceId)
      this.#previews.set(id, { directory, candidates, result, createdAt: Date.now() })
      return result
    }
    catch (error) {
      await rm(directory, { recursive: true, force: true })
      if (error instanceof SkillError)
        throw error
      throw new SkillError('SKILL_SOURCE_UNAVAILABLE', { cause: error })
    }
  }

  install(input: { previewId: string, candidateIds: readonly string[] }) {
    input = copyEventSnapshot(input)
    return this.#mutate(async () => {
      const preview = this.#previews.get(input.previewId)
      if (!preview || Date.now() - preview.createdAt > 30 * 60 * 1000)
        throw new SkillError('SKILL_PREVIEW_EXPIRED')
      const scope = preview.result.spaceId
      this.#requireSpace(scope)
      const current = await this.#list(scope)
      const records = this.#options.repository.list()
      const selected = [...new Set(input.candidateIds)].map((id) => {
        const item = preview.result.candidates.find(candidate => candidate.id === id)
        const candidate = preview.candidates.get(id)
        if (!item || item.blocked || !candidate)
          throw new SkillError('SKILL_INVALID')
        const existing = records.find(record => record.managedBy === 'user' && record.name === item.name && record.spaceId === scope)
        if (scope === null && records.some(record => record.managedBy === 'application' && record.name === item.name))
          throw new SkillError('SKILL_NAME_COLLISION')
        if (existing?.id !== candidate.existing?.id || existing?.revision !== candidate.existing?.revision
          || current.skills.find(skill => skill.id === existing?.id)?.revision !== candidate.existingRevision) {
          throw new SkillError('SKILL_CHANGED')
        }
        return candidate
      })
      if (!selected.length)
        throw new SkillError('SKILL_INVALID')
      if (selected.some(candidate => candidate.existing))
        this.#assertIdle(scope)
      const published: { path: string, spaceId: string | null, installationId: string }[] = []
      const next: SkillInstallation[] = []
      try {
        for (const candidate of selected) {
          const id = candidate.existing?.id ?? randomUUID()
          const root = join(this.#options.paths.skillsDirectory(scope), id, randomUUID(), candidate.loaded.name)
          published.push({ path: dirname(root), spaceId: scope, installationId: id })
          this.#options.repository.scheduleCleanup(scope, id, dirname(root))
          this.#cleanupChanged({ path: dirname(root), spaceId: scope, installationId: id }, 'pending')
          await writeSkillFiles(root, candidate.loaded.files, candidate.loaded.modes)
          const source: SkillOrigin = preview.result.source.kind === 'github'
            ? { ...preview.result.source, subdirectory: [preview.result.source.subdirectory, candidate.sourcePath].filter(Boolean).join('/') }
            : preview.result.source.kind === 'directory'
              ? { kind: 'directory', location: join(preview.result.source.location, candidate.sourcePath) }
              : { ...preview.result.source }
          const now = new Date().toISOString()
          next.push({
            id,
            name: candidate.loaded.name,
            description: candidate.loaded.description,
            enabled: candidate.existing?.enabled ?? true,
            spaceId: scope,
            managedBy: 'user',
            path: join(root, 'SKILL.md'),
            origin: source,
            revision: candidate.loaded.revision,
            createdAt: candidate.existing?.createdAt ?? now,
            updatedAt: now,
          })
        }
        if (selected.some(candidate => candidate.existing))
          this.#assertIdle(scope)
        this.#options.repository.saveAll(next)
      }
      catch (error) {
        await Promise.all(published.map(async (item) => {
          try {
            await rm(item.path, { recursive: true, force: true })
            this.#options.repository.completeCleanup(item.path)
            this.#cleanupChanged(item, 'completed')
          }
          catch {
            this.#cleanupChanged(item, 'failed')
          }
        }))
        if (error instanceof SkillError)
          throw error
        throw new SkillError('SKILL_INSTALL_FAILED', { cause: error })
      }
      this.#installationCommitted(scope, 'installed', next.map(record => record.id))
      for (const record of next)
        this.#cleanupChanged({ path: dirname(dirname(record.path)), spaceId: scope, installationId: record.id }, 'cancelled')
      await this.#cleanup()
      await this.discard(input.previewId).catch(() => {})
      return this.#list(scope)
    })
  }

  async discard(id: string) {
    const preview = this.#previews.get(id)
    this.#previews.delete(id)
    if (preview)
      await rm(preview.directory, { recursive: true, force: true })
  }

  async whenIdle(): Promise<void> {
    let mutation: Promise<unknown>
    do {
      mutation = this.#mutation
      await Promise.allSettled([mutation, ...this.#operations, ...this.#resolutions.values()])
    } while (mutation !== this.#mutation || this.#operations.size || this.#resolutions.size)
  }

  async quiesce(): Promise<void> {
    this.#quiescing = true
    await this.whenIdle()
  }

  async dispose() {
    await this.quiesce()
    this.#disposed = true
    this.#globalGeneration = ++this.#generation
    this.#resolved.clear()
    this.#packages.clear()
    await Promise.all([...this.#previews.keys()].map(id => this.discard(id)))
    this.#events.dispose()
  }

  async #resolve(spaceId: string | null, lightweight = false): Promise<ResolvedCatalog> {
    if (this.#disposed)
      throw new SkillError('SKILL_CHANGED')
    const space = this.#requireSpace(spaceId)
    const scope = JSON.stringify(space?.primaryDirectory ?? null)
    const cacheId = this.#resolutionCacheId(spaceId, lightweight)
    const state = this.#resolutionKey(spaceId, lightweight)
    const generation = this.#currentGeneration(spaceId)
    const key = JSON.stringify([state, generation])
    const cached = this.#resolved.get(cacheId)
    if (cached?.key === key && await this.#isCatalogCurrent(cached.result)) {
      if (this.#resolutionKey(spaceId, lightweight) !== state)
        throw new SkillError('SKILL_CHANGED')
      if (!this.#disposed && this.#currentGeneration(spaceId) === generation)
        return cached.result
    }
    if (this.#currentGeneration(spaceId) !== generation)
      return this.#resolve(spaceId, lightweight)
    const pending = this.#resolutions.get(key)
    if (pending)
      return pending
    const resolving = this.#resolveCatalog(spaceId, lightweight).then((result) => {
      if (this.#disposed)
        throw new SkillError('SKILL_CHANGED')
      if (JSON.stringify(this.#requireSpace(spaceId)?.primaryDirectory ?? null) !== scope)
        throw new SkillError('SKILL_CHANGED')
      if (this.#currentGeneration(spaceId) !== generation)
        return this.#resolve(spaceId, lightweight)
      if (this.#resolutionKey(spaceId, lightweight) !== state)
        throw new SkillError('SKILL_CHANGED')
      const accepted = copyEventSnapshot(result)
      if (lightweight)
        this.#resolved.set(cacheId, { key, result: accepted })
      this.#acceptCatalog(spaceId, lightweight, scope, accepted)
      return accepted
    }).finally(() => {
      if (this.#resolutions.get(key) === resolving)
        this.#resolutions.delete(key)
    })
    this.#resolutions.set(key, resolving)
    return resolving
  }

  #resolutionCacheId(spaceId: string | null, lightweight: boolean) {
    return JSON.stringify([spaceId, lightweight])
  }

  #invalidateResolutions(spaceId: string | null, all = false) {
    if (all) {
      this.#globalGeneration = ++this.#generation
      this.#resolved.clear()
      return
    }
    this.#scopeGenerations.set(spaceId, ++this.#generation)
    this.#resolved.delete(this.#resolutionCacheId(spaceId, false))
    this.#resolved.delete(this.#resolutionCacheId(spaceId, true))
  }

  #currentGeneration(spaceId: string | null): number {
    return Math.max(this.#globalGeneration, this.#scopeGenerations.get(spaceId) ?? 0)
  }

  async #isCatalogCurrent(result: ResolvedCatalog): Promise<boolean> {
    for (const candidate of result.candidates) {
      if (!candidate.loaded || !candidate.allowedRoot)
        continue
      try {
        if (await realpath(candidate.allowedRoot) !== candidate.allowedRoot)
          return false
        const document = await this.#packages.loadMetadata(candidate.entry.filePath, candidate.allowedRoot)
        if (document.path !== candidate.loaded.path || document.referenceRevision !== candidate.referenceRevision)
          return false
      }
      catch { return false }
    }
    return true
  }

  #resolutionKey(spaceId: string | null, lightweight: boolean) {
    const space = this.#requireSpace(spaceId)
    return JSON.stringify([spaceId, JSON.stringify(space?.primaryDirectory ?? null), this.#options.repository.list().filter(record => record.spaceId === null || record.spaceId === spaceId), lightweight])
  }

  async #resolveCatalog(spaceId: string | null, lightweight = false) {
    const space = this.#requireSpace(spaceId)
    const diagnostics: Array<{ code: 'SKILL_INVALID' | 'SKILL_NAME_COLLISION' | 'SKILL_PATH_OUTSIDE_SOURCE' | 'SKILL_SOURCE_UNREADABLE', message: string, path?: string }> = []
    const candidates: Candidate[] = []
    const legacyRoot = join(this.#options.agentDirectory, 'skills')
    await mkdir(legacyRoot, { recursive: true, mode: 0o700 })
    const sources = [
      ...(this.#options.builtinSkillsDirectories ?? []).map(root => ({ root, allowedRoot: root, kind: 'application' as const })),
      { root: legacyRoot, allowedRoot: this.#options.agentDirectory, kind: 'external' as const },
      ...(space?.primaryDirectory?.resourcesTrustedAt
        ? ['.agents', '.pi'].map(name => ({ root: join(space.primaryDirectory!.canonicalRoot, name, 'skills'), allowedRoot: space.primaryDirectory!.canonicalRoot, kind: 'directory' as const }))
        : []),
    ]
    const discovered = new Map<string, ResolvedSkill>()
    const discoveredRoots = new Map<string, string>()
    for (const source of sources) {
      try {
        const root = await requireSkillPath(source.allowedRoot, source.root)
        for (const path of await discoverSkillFiles(root, source.kind !== 'application', path => diagnostics.push({ code: 'SKILL_PATH_OUTSIDE_SOURCE', message: 'Skill source is outside the allowed folder or cannot be read.', path }))) {
          try {
            const loaded = lightweight
              ? await this.#packages.loadMetadata(path, root)
              : await this.#packages.load(path, root)
            const id = skillIdentity(source.kind === 'application' ? `application:${loaded.name}` : `${source.kind}:${path}`)
            if (source.kind === 'directory') {
              candidates.push({ allowedRoot: root, loaded, priority: 1, referenceRevision: loaded.referenceRevision, entry: {
                id,
                name: loaded.name,
                description: loaded.description,
                source: 'directory',
                spaceId,
                managedBy: 'directory',
                enabled: true,
                status: loaded.manualOnly ? 'manual_only' : 'available',
                shadowedBy: null,
                revision: loaded.revision,
                referenceRevision: loaded.referenceRevision,
                filePath: path,
                origin: null,
                canRemove: false,
                canUpdate: false,
                busy: false,
              } })
            }
            else {
              const records = this.#options.repository.list()
              const existing = records.find(record => record.id === id)
              if (!existing && records.some(record => record.name === loaded.name && record.managedBy === source.kind && record.spaceId === null))
                continue
              const now = new Date().toISOString()
              if (!lightweight && (!existing || existing.path !== loaded.path || existing.revision !== loaded.revision)) {
                this.#options.repository.save({
                  id,
                  name: loaded.name,
                  description: loaded.description,
                  path: loaded.path,
                  spaceId: null,
                  managedBy: source.kind,
                  enabled: existing?.enabled ?? true,
                  origin: { kind: source.kind === 'application' ? 'application' : 'directory', location: root },
                  revision: loaded.revision,
                  createdAt: existing?.createdAt ?? now,
                  updatedAt: now,
                })
                this.#installationCommitted(null, 'discovered', [id])
              }
              discovered.set(id, loaded)
              discoveredRoots.set(id, root)
              if (lightweight && !existing) {
                candidates.push({
                  allowedRoot: root,
                  loaded,
                  priority: source.kind === 'application' ? 3 : 4,
                  referenceRevision: loaded.referenceRevision,
                  entry: {
                    id,
                    name: loaded.name,
                    description: loaded.description,
                    source: 'global',
                    spaceId: null,
                    managedBy: source.kind,
                    enabled: true,
                    status: loaded.manualOnly ? 'manual_only' : 'available',
                    shadowedBy: null,
                    revision: loaded.revision,
                    referenceRevision: loaded.referenceRevision,
                    filePath: loaded.path,
                    origin: { kind: source.kind === 'application' ? 'application' : 'directory', location: root },
                    canRemove: false,
                    canUpdate: false,
                    busy: false,
                  },
                })
              }
            }
          }
          catch {
            diagnostics.push({ code: 'SKILL_INVALID', message: 'Skill metadata or bundled resources are invalid.', path })
            if (source.kind === 'directory') {
              const name = basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path, '.md')
              candidates.push({ allowedRoot: root, loaded: null, priority: 1, referenceRevision: 'invalid', entry: {
                id: skillIdentity(`directory:${path}`),
                name,
                description: '',
                source: 'directory',
                spaceId,
                managedBy: 'directory',
                enabled: true,
                status: 'invalid',
                shadowedBy: null,
                revision: 'invalid',
                referenceRevision: 'invalid',
                filePath: path,
                origin: null,
                canRemove: false,
                canUpdate: false,
                busy: false,
              } })
            }
          }
        }
      }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
          continue
        diagnostics.push({ code: error instanceof SkillError ? 'SKILL_PATH_OUTSIDE_SOURCE' : 'SKILL_SOURCE_UNREADABLE', message: 'A skill source could not be read within its allowed directory.', path: source.root })
      }
    }
    for (const record of this.#options.repository.list().filter(record => !record.spaceId || record.spaceId === spaceId)) {
      let loaded = discovered.get(record.id) ?? null
      let allowedRoot = discoveredRoots.get(record.id) ?? null
      if (record.managedBy === 'user') {
        try {
          allowedRoot = this.#options.paths.skillsDirectory(record.spaceId)
          await requireSkillPath(this.#options.paths.root, record.path)
          loaded = lightweight
            ? await this.#packages.loadMetadata(record.path, allowedRoot)
            : await this.#packages.load(record.path, allowedRoot)
          if (loaded.name !== record.name)
            loaded = null
        }
        catch {
          loaded = null
          allowedRoot = null
        }
      }
      candidates.push({
        allowedRoot,
        loaded,
        priority: record.spaceId ? 2 : record.managedBy === 'external' ? 4 : 3,
        referenceRevision: loaded?.referenceRevision ?? record.revision,
        entry: {
          id: record.id,
          name: record.name,
          description: loaded?.description ?? record.description,
          referenceRevision: loaded?.referenceRevision ?? record.revision,
          source: record.spaceId ? 'space' : 'global',
          spaceId: record.spaceId,
          managedBy: record.managedBy,
          enabled: record.enabled,
          revision: loaded?.revision ?? record.revision,
          filePath: record.path,
          origin: record.origin,
          shadowedBy: null,
          status: !record.enabled ? 'disabled' : !loaded ? 'invalid' : loaded.manualOnly ? 'manual_only' : 'available',
          canRemove: record.managedBy === 'user' && record.spaceId === spaceId,
          canUpdate: record.managedBy === 'user' && record.spaceId === spaceId,
          busy: this.#options.repository.hasActiveRuns(record.spaceId),
        },
      })
    }
    const winners = new Map<string, string>()
    for (const candidate of candidates.sort((a, b) => a.priority - b.priority || a.entry.filePath.localeCompare(b.entry.filePath))) {
      const winner = winners.get(candidate.entry.name)
      if (winner) {
        candidate.entry = { ...candidate.entry, status: 'shadowed', shadowedBy: winner }
        diagnostics.push({ code: 'SKILL_NAME_COLLISION', message: 'A higher-priority skill with the same name takes precedence.', path: candidate.entry.filePath })
      }
      else { winners.set(candidate.entry.name, candidate.entry.id) }
    }
    const skills = [...candidates].sort((a, b) => a.entry.name.localeCompare(b.entry.name) || a.priority - b.priority || a.entry.id.localeCompare(b.entry.id)).map(candidate => candidate.entry)
    const revision = createHash('sha256').update(JSON.stringify(skills.map(({ id, revision, status, enabled }) => ({ id, revision, status, enabled })))).digest('hex')
    const catalog = { skills, diagnostics, revision }
    return { candidates, catalog }
  }

  async #currentSkill(spaceId: string | null, id: string) {
    this.#invalidateResolutions(spaceId)
    const { catalog } = await this.#resolve(spaceId)
    const skill = catalog.skills.find(skill => skill.id === id)
    if (!skill)
      throw new SkillError('SKILL_NOT_FOUND')
    return skill
  }

  #requireSpace(spaceId: string | null) {
    const space = spaceId ? this.#options.spaces.findById(spaceId) : null
    if (spaceId && (!space || space.revokedAt))
      throw new SkillError('SKILL_NOT_FOUND')
    return space
  }

  #record(id: string) {
    const record = this.#options.repository.list().find(record => record.id === id)
    if (!record)
      throw new SkillError('SKILL_NOT_FOUND')
    return record
  }

  #assertIdle(spaceId: string | null) {
    if (this.#options.repository.hasActiveRuns(spaceId))
      throw new SkillError('SKILL_BUSY')
  }

  async #cleanup() {
    const { repository, paths } = this.#options
    for (const item of repository.pendingCleanup()) {
      this.#cleanupChanged(item, 'pending')
      const root = join(paths.skillsDirectory(item.spaceId), item.installationId)
      if (dirname(item.path) !== root || repository.list().some(record => dirname(dirname(record.path)) === item.path))
        continue
      try {
        await requireSkillPath(this.#options.paths.root, item.path)
        await rm(item.path, { recursive: true, force: true })
        repository.completeCleanup(item.path)
        this.#cleanupChanged(item, 'completed')
      }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          repository.completeCleanup(item.path)
          this.#cleanupChanged(item, 'completed')
        }
        else {
          this.#cleanupChanged(item, 'failed')
        }
      }
    }
  }

  #track<T>(action: () => Promise<T>): Promise<T> {
    if (this.#disposed)
      return Promise.reject(new SkillError('SKILL_CHANGED'))
    const pending = action().finally(() => this.#operations.delete(pending))
    this.#operations.add(pending)
    return pending
  }

  #mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.#quiescing)
      return Promise.reject(new SkillError('SKILL_CHANGED'))
    const pending = this.#mutation.then(() => {
      if (this.#disposed)
        throw new SkillError('SKILL_CHANGED')
      return action()
    })
    this.#mutation = pending.catch(() => {})
    return pending
  }

  #installationCommitted(spaceId: string | null, reason: Extract<SkillEvent, { type: 'installation' }>['reason'], installationIds: readonly string[]): void {
    this.#invalidateResolutions(spaceId, spaceId === null)
    this.#events.fire(this.#event(spaceId, { type: 'installation', reason, installationIds, operationId: randomUUID() }))
  }

  #cleanupChanged(item: { path: string, spaceId: string | null, installationId: string }, status: Extract<SkillEvent, { type: 'cleanup' }>['status']): void {
    if (this.#cleanupStates.get(item.path) === status)
      return
    this.#cleanupStates.set(item.path, status)
    this.#events.fire(this.#event(item.spaceId, { type: 'cleanup', status, installationId: item.installationId, ...(status === 'failed' ? { error: 'SKILL_CLEANUP_FAILED' as const } : {}) }))
  }

  #acceptCatalog(spaceId: string | null, lightweight: boolean, scopeKey: string, result: ResolvedCatalog): void {
    const cacheId = this.#resolutionCacheId(spaceId, lightweight)
    const fingerprint = JSON.stringify(result.catalog)
    const events: SkillEvent[] = []
    this.#inspector.remember(spaceId, scopeKey, result.catalog)
    if (this.#accepted.get(cacheId) !== fingerprint) {
      this.#accepted.set(cacheId, fingerprint)
      events.push(this.#event(spaceId, { type: 'catalog', mode: lightweight ? 'discovery' : 'management', catalogRevision: result.catalog.revision, skillIds: result.catalog.skills.map(skill => skill.id) }))
    }
    if (lightweight) {
      const resolution = this.#sessionResolution(result)
      const previous = this.#resources.get(spaceId)
      this.#resources.set(spaceId, resolution)
      if (previous?.revision !== resolution.revision)
        events.push(this.#event(spaceId, { type: 'resources', resourceRevision: resolution.revision, previousRevision: previous?.revision ?? null, skillIds: resolution.skills.map(skill => skill.id) }))
    }
    this.#events.fireBatch(events)
  }

  #sessionResolution({ catalog, candidates }: ResolvedCatalog): BuddySkillResolution {
    const effective = candidates.filter(candidate => isSkillAvailable(candidate.entry))
    const revision = createHash('sha256').update(JSON.stringify(effective.map(candidate => ({
      id: candidate.entry.id,
      revision: candidate.referenceRevision,
      status: candidate.entry.status,
      enabled: candidate.entry.enabled,
      filePath: candidate.entry.filePath,
    })))).digest('hex')
    return copyEventSnapshot({
      diagnostics: catalog.diagnostics,
      paths: effective.map(candidate => candidate.entry.filePath),
      readRoots: [...new Set(effective.map(candidate => dirname(candidate.entry.filePath)))],
      references: effective.map(candidate => reference(candidate.entry, candidate.referenceRevision)),
      revision,
      skills: effective.map(candidate => candidate.entry).sort((a, b) => a.name.localeCompare(b.name)),
    })
  }

  #event(spaceId: string | null, detail: SkillEventDetails): SkillEvent {
    return copyEventSnapshot({ ...detail, sourceId: this.sourceId, sequence: ++this.#sequence, generation: this.#currentGeneration(spaceId), spaceId })
  }
}

function reference(
  skill: LocalSkill,
  revision = skill.referenceRevision ?? skill.revision,
  packageRevision?: string,
): SkillReference {
  return { id: skill.id, name: skill.name, revision, ...(packageRevision ? { packageRevision } : {}) }
}

export function formatBuddySkillPrompt(skill: BuddyMaterializedSkill): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return [`<skill name="${escape(skill.name)}" location="${escape(skill.filePath)}">`, `References are relative to ${skill.baseDirectory}.`, '', skill.body, '</skill>'].join('\n')
}

export function registerSkillServiceRpc(rpc: RuntimeRequestRegistrar, service: SkillService): () => void {
  const stops = [
    registerRuntimeRequest(rpc, skillsRpc.list, input => service.list(input.spaceId, input.metadataOnly)),
    registerRuntimeRequest(rpc, skillsRpc.get, input => service.get(input.spaceId, input.id)),
    registerRuntimeRequest(rpc, skillsRpc.listFiles, input => service.listFiles(input)),
    registerRuntimeRequest(rpc, skillsRpc.readFile, input => service.readFile(input)),
    registerRuntimeRequest(rpc, skillsRpc.locateFile, input => service.locateFile(input)),
    registerRuntimeRequest(rpc, skillsRpc.preview, input => service.preview(input)),
    registerRuntimeRequest(rpc, skillsRpc.install, input => service.install(input)),
    registerRuntimeRequest(rpc, skillsRpc.discard, async (input) => {
      await service.discard(input.previewId)
      return { ok: true as const }
    }),
    registerRuntimeRequest(rpc, skillsRpc.setEnabled, input => service.setEnabled(input)),
    registerRuntimeRequest(rpc, skillsRpc.remove, input => service.remove(input)),
  ]
  return () => stops.forEach(stop => stop())
}

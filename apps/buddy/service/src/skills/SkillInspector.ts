import type { DirectoryPage, FileEntry } from '../../../shared/files/filePreview'
import type { LocalSkill, LocalSkillCatalog, SkillDetail, SkillDirectoryRequest, SkillFileTarget } from '../../../shared/skills/skillApi'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { SkillRepository } from '../storage/skillRepository'
import type { SpaceRepository } from '../storage/spaceRepository'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { readFilePreview } from '../files/readFilePreview'
import { isWithin, readSkillDocument, requireSkillPath, SkillError } from './skillFiles'

interface InspectionOptions {
  agentDirectory: string
  builtinSkillsDirectories?: readonly string[]
  paths: BuddyDataPaths
  repository: SkillRepository
  spaces: SpaceRepository
  refresh: (spaceId: string | null) => Promise<LocalSkillCatalog>
}

interface InspectionTarget {
  skill: LocalSkill
  spaceId: string | null
  scopeKey: string
  root: string
  filePath: string
}

export class SkillInspector {
  readonly #options: InspectionOptions
  readonly #catalogs = new Map<string | null, { scopeKey: string, catalog: LocalSkillCatalog }>()

  constructor(options: InspectionOptions) {
    this.#options = options
  }

  remember(spaceId: string | null, scopeKey: string, catalog: LocalSkillCatalog) {
    this.#catalogs.set(spaceId, { scopeKey, catalog: copyEventSnapshot(catalog) })
  }

  async get(spaceId: string | null, id: string): Promise<SkillDetail> {
    const target = await this.#target(spaceId, id)
    const document = await readSkillDocument(target.filePath, target.root)
    this.#assertCurrent(target)
    return copyEventSnapshot({
      skill: { ...target.skill, name: document.name, description: document.description },
      content: document.content,
      body: document.body,
      metadata: document.metadata,
      compatibility: document.compatibility,
    })
  }

  async listFiles(input: SkillDirectoryRequest): Promise<DirectoryPage> {
    const target = await this.#target(input.spaceId, input.id)
    if (basename(target.filePath) !== 'SKILL.md') {
      if (input.path)
        throw new SkillError('SKILL_INVALID')
      return { entries: [{ name: basename(target.filePath), path: basename(target.filePath), kind: 'file', unavailable: false }], nextCursor: null }
    }
    const path = await this.#filePath(target, input.path)
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const offset = input.cursor ? entries.findIndex(entry => entry.name === input.cursor) + 1 : 0
    const page = entries.slice(offset, offset + 250)
    const files: FileEntry[] = await Promise.all(page.map(async (entry) => {
      const path = input.path ? `${input.path}/${entry.name}` : entry.name
      let kind: FileEntry['kind'] = entry.isDirectory() ? 'directory' : 'file'
      let unavailable = false
      if (entry.isSymbolicLink()) {
        try {
          kind = (await stat(await this.#filePath(target, path))).isDirectory() ? 'directory' : 'file'
        }
        catch { unavailable = true }
      }
      return { path, name: entry.name, kind, unavailable }
    }))
    this.#assertCurrent(target)
    return { entries: files, nextCursor: offset + page.length < entries.length ? page.at(-1)?.name ?? null : null }
  }

  async readFile(input: SkillFileTarget) {
    const target = await this.#target(input.spaceId, input.id)
    const path = await this.#filePath(target, input.path)
    const preview = await readFilePreview(target.root, path)
    this.#assertCurrent(target)
    return preview
  }

  async locateFile(input: SkillFileTarget) {
    const target = await this.#target(input.spaceId, input.id)
    const path = await this.#filePath(target, input.path)
    this.#assertCurrent(target)
    return { path }
  }

  async #filePath(target: InspectionTarget, path: string) {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || path.includes('\0'))
      throw new SkillError('SKILL_INVALID')
    if (basename(target.filePath) !== 'SKILL.md' && path !== basename(target.filePath))
      throw new SkillError('SKILL_INVALID')
    return requireSkillPath(target.root, join(target.root, path))
  }

  async #target(spaceId: string | null, id: string): Promise<InspectionTarget> {
    const scopeKey = this.#scopeKey(spaceId)
    let snapshot = this.#catalogs.get(spaceId)
    if (!snapshot || snapshot.scopeKey !== scopeKey || !snapshot.catalog.skills.some(skill => skill.id === id)) {
      await this.#options.refresh(spaceId)
      snapshot = this.#catalogs.get(spaceId)
    }
    const entry = snapshot?.catalog.skills.find(skill => skill.id === id)
    if (!entry)
      throw new SkillError('SKILL_NOT_FOUND')
    if (snapshot?.scopeKey !== scopeKey)
      throw new SkillError('SKILL_CHANGED')
    let skill = entry
    let allowedRoot: string | undefined
    if (entry.managedBy === 'directory') {
      const directory = spaceId ? this.#options.spaces.findById(spaceId)?.primaryDirectory : null
      if (!directory?.resourcesTrustedAt || directory.revokedAt)
        throw new SkillError('SKILL_NOT_FOUND')
      const sourceRoot = ['.agents', '.pi'].map(name => join(directory.canonicalRoot, name, 'skills')).find(root => isWithin(root, entry.filePath))
      if (sourceRoot)
        allowedRoot = await requireSkillPath(directory.canonicalRoot, sourceRoot)
    }
    else {
      const record = this.#options.repository.list().find(record => record.id === id)
      if (!record || (record.spaceId && record.spaceId !== spaceId))
        throw new SkillError('SKILL_NOT_FOUND')
      skill = { ...entry, filePath: record.path, revision: entry.filePath === record.path ? entry.revision : record.revision, enabled: record.enabled, busy: this.#options.repository.hasActiveRuns(record.spaceId) }
      if (record.managedBy === 'user') {
        await requireSkillPath(this.#options.paths.root, record.path)
        allowedRoot = this.#options.paths.skillsDirectory(record.spaceId)
      }
      else if (record.managedBy === 'external') {
        allowedRoot = await requireSkillPath(this.#options.agentDirectory, join(this.#options.agentDirectory, 'skills'))
      }
      else { allowedRoot = this.#options.builtinSkillsDirectories?.find(root => isWithin(root, record.path)) }
    }
    if (!allowedRoot)
      throw new SkillError('SKILL_NOT_FOUND')
    const root = await requireSkillPath(allowedRoot, dirname(skill.filePath))
    const filePath = await requireSkillPath(root, skill.filePath)
    const target = { skill, spaceId, scopeKey, filePath, root }
    this.#assertCurrent(target)
    return target
  }

  #scopeKey(spaceId: string | null) {
    const space = spaceId ? this.#options.spaces.findById(spaceId) : null
    if (spaceId && (!space || space.revokedAt))
      throw new SkillError('SKILL_NOT_FOUND')
    return JSON.stringify(space?.primaryDirectory ?? null)
  }

  #assertCurrent(target: InspectionTarget) {
    if (this.#scopeKey(target.spaceId) !== target.scopeKey)
      throw new SkillError('SKILL_CHANGED')
    if (target.skill.managedBy !== 'directory') {
      const record = this.#options.repository.list().find(record => record.id === target.skill.id)
      if (!record || record.path !== target.skill.filePath)
        throw new SkillError('SKILL_CHANGED')
    }
  }
}

import type { Event } from '../../../shared/events/Emitter'
import type { EventSnapshot, EventSubscription } from '../../../shared/events/eventTypes'
import type { ExtensionSkillDescriptor } from '../../../shared/extensions/extensionSkills'
import type { LocalSkill } from '../../../shared/skills/skillApi'
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { extensionPathSchema } from '../../../shared/extensions/extensionPath'
import { MAX_SKILL_FILES, MAX_SKILL_PACKAGE_BYTES, SkillError, skillIdentity } from './skillFiles'

export interface PluginSkillProvider {
  list: () => Promise<readonly ExtensionSkillDescriptor[]>
  onDidChange: Event<void>
}

export interface PluginSkillEntry {
  descriptor: EventSnapshot<ExtensionSkillDescriptor>
  contribution: ExtensionSkillDescriptor['skills'][number]
}

export class PluginSkillSource {
  readonly #provider: PluginSkillProvider | undefined
  readonly #changed: () => void
  readonly #subscription: EventSubscription | undefined
  #descriptors: readonly EventSnapshot<ExtensionSkillDescriptor>[] = []
  #fingerprint = ''
  #generation = 0
  #request = 0
  #acceptedRequest = 0
  #disposed = false

  constructor(provider: PluginSkillProvider | undefined, changed: () => void) {
    this.#provider = provider
    this.#changed = changed
    this.#subscription = provider?.onDidChange(() => {
      this.#generation++
      changed()
    })
  }

  get revision() { return this.#fingerprint }

  async refresh(): Promise<readonly EventSnapshot<ExtensionSkillDescriptor>[]> {
    if (!this.#provider)
      return []
    const generation = this.#generation
    const request = ++this.#request
    let descriptors: readonly EventSnapshot<ExtensionSkillDescriptor>[]
    try {
      descriptors = copyEventSnapshot(await this.#provider.list())
    }
    catch (cause) { throw new SkillError('SKILL_SOURCE_UNAVAILABLE', { cause }) }
    if (this.#disposed)
      throw new SkillError('SKILL_CHANGED')
    if (generation !== this.#generation)
      return this.refresh()
    if (request < this.#acceptedRequest)
      return this.#descriptors
    this.#acceptedRequest = request
    const fingerprint = JSON.stringify(descriptors)
    if (fingerprint !== this.#fingerprint) {
      this.#descriptors = descriptors
      this.#fingerprint = fingerprint
      this.#changed()
    }
    return this.#descriptors
  }

  entries(): PluginSkillEntry[] {
    return this.#descriptors.flatMap(descriptor => descriptor.skills.map(contribution => ({ descriptor, contribution })))
  }

  async verify(entry: PluginSkillEntry, metadataOnly = false): Promise<{ root: string, filePath: string }> {
    const { descriptor, contribution } = entry
    if (!isAbsolute(descriptor.root) || !extensionPathSchema.safeParse(contribution.path).success || !contribution.path.endsWith('/SKILL.md'))
      throw new SkillError('SKILL_INVALID')
    const packageRoot = resolve(descriptor.root)
    if (await realpath(packageRoot) !== packageRoot || !(await lstat(packageRoot)).isDirectory())
      throw new SkillError('SKILL_INVALID')
    const prefix = contribution.path.slice(0, -'SKILL.md'.length)
    let directory = packageRoot
    for (const part of prefix.slice(0, -1).split('/')) {
      directory = join(directory, part)
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new SkillError('SKILL_INVALID')
    }
    const expected = new Map(Object.entries(descriptor.hashes).filter(([path]) => path.startsWith(prefix)))
    if (!expected.has(contribution.path))
      throw new SkillError('SKILL_INVALID')
    let count = 0
    let bytes = 0
    const found = new Set<string>()
    const visit = async (path: string, depth: number): Promise<void> => {
      if (depth > 16)
        throw new SkillError('SKILL_TOO_LARGE')
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (++count > MAX_SKILL_FILES)
          throw new SkillError('SKILL_TOO_LARGE')
        const target = join(path, child.name)
        const packagePath = relative(packageRoot, target).split('\\').join('/')
        const metadata = await lstat(target)
        if (metadata.isSymbolicLink())
          throw new SkillError('SKILL_INVALID')
        if (metadata.isDirectory()) {
          if (![...expected.keys()].some(name => name.startsWith(`${packagePath}/`)))
            throw new SkillError('SKILL_CHANGED')
          await visit(target, depth + 1)
          continue
        }
        if (!metadata.isFile() || !expected.has(packagePath))
          throw new SkillError('SKILL_CHANGED')
        bytes += metadata.size
        if (bytes > MAX_SKILL_PACKAGE_BYTES)
          throw new SkillError('SKILL_TOO_LARGE')
        if (!metadataOnly || packagePath === contribution.path) {
          const content = await readBoundedFile(packageRoot, target, MAX_SKILL_PACKAGE_BYTES)
          if (createHash('sha256').update(content).digest('hex') !== expected.get(packagePath))
            throw new SkillError('SKILL_CHANGED')
        }
        found.add(packagePath)
      }
    }
    await visit(directory, 0)
    if (found.size !== expected.size)
      throw new SkillError('SKILL_CHANGED')
    return { root: directory, filePath: join(packageRoot, contribution.path) }
  }

  async assertCurrent(skill: LocalSkill, requireEnabled: boolean): Promise<{ root: string, filePath: string }> {
    await this.refresh()
    const entry = this.#find(skill, requireEnabled)
    const target = await this.verify(entry)
    await this.refresh()
    const current = this.#find(skill, requireEnabled)
    if (JSON.stringify(current) !== JSON.stringify(entry) || target.filePath !== skill.filePath)
      throw new SkillError('SKILL_CHANGED')
    return target
  }

  #find(skill: LocalSkill, requireEnabled: boolean): PluginSkillEntry {
    const owner = skill.plugin
    if (!owner)
      throw new SkillError('SKILL_CHANGED')
    const entry = this.entries().find(({ descriptor, contribution }) => descriptor.extensionId === owner.extensionId && contribution.id === owner.contributionId)
    if (!entry || entry.descriptor.revision !== owner.revision || skill.id !== skillIdentity(`plugin:${entry.contribution.id}`) || (requireEnabled && !entry.descriptor.enabled) || skill.enabled !== entry.descriptor.enabled)
      throw new SkillError('SKILL_CHANGED')
    return entry
  }

  dispose() {
    this.#disposed = true
    this.#subscription?.dispose()
  }
}

export function pluginSkillReferenceRevision(packageRevision: string, documentRevision: string): string {
  return createHash('sha256').update(JSON.stringify([packageRevision, documentRevision])).digest('hex')
}

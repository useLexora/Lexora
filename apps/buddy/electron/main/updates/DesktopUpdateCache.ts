import type { DesktopUpdateCacheSummary } from '../../shared/desktopUpdates'
import type { DesktopUpdatePackage } from './DesktopUpdatePackage'
import type { DesktopUpdatePlan, DesktopUpdatePolicy } from './DesktopUpdatePolicy'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { DESKTOP_PACKAGE_FORMATS, desktopUpdateArtifactName } from '../../shared/desktopDistribution'
import { compareDesktopVersions, desktopVersionSchema } from '../../shared/desktopUpdates'
import { desktopUpdatePackageSchema, verifyDesktopUpdatePackage } from './DesktopUpdatePackage'

const recordSchema = z.object({ version: z.literal(1), packages: z.array(desktopUpdatePackageSchema).min(1).max(2) }).strict()
const formats = Object.keys(DESKTOP_PACKAGE_FORMATS) as (keyof typeof DESKTOP_PACKAGE_FORMATS)[]

function ownedPackage(name: string) {
  const temporary = name.endsWith('.download')
  const asset = temporary ? name.slice(0, -'.download'.length) : name
  const version = desktopVersionSchema.safeParse(/^Lexora-Buddy-(\d+\.\d+\.\d+)-/.exec(asset)?.[1])
  if (!version.success || !formats.some(format => (['x64', 'arm64'] as const).some(architecture => desktopUpdateArtifactName(format, architecture, version.data) === asset)))
    return null
  return { version: version.data, temporary }
}

export class DesktopUpdateCache {
  readonly #directory: string
  readonly #policy: DesktopUpdatePolicy
  readonly #currentVersion: string
  #tail: Promise<unknown> = Promise.resolve()

  constructor(directory: string, policy: DesktopUpdatePolicy, currentVersion: string) {
    this.#directory = directory
    this.#policy = policy
    this.#currentVersion = currentVersion
  }

  async readPlan(version: string | null): Promise<DesktopUpdatePlan | null> {
    if (!version || compareDesktopVersions(version, this.#currentVersion) <= 0)
      return null
    try {
      await this.#validateDirectory()
      const path = join(this.#directory, 'download.json')
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024)
        throw new Error('UPDATE_CACHE_INVALID')
      const record = recordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      const plan = this.#policy.resolveCached(record.packages)
      return plan?.update?.version === version ? plan : null
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return null
      throw error
    }
  }

  remember(plan: DesktopUpdatePlan): Promise<void> {
    return this.#enqueue(async () => {
      const record = recordSchema.parse({ version: 1, packages: [plan.update, plan.fallback].filter(Boolean) })
      if (this.#policy.resolveCached(record.packages)?.update?.url !== plan.update?.url)
        throw new Error('UPDATE_CACHE_INVALID')
      await mkdir(this.#directory, { recursive: true })
      await this.#validateDirectory()
      const temporary = join(this.#directory, `.package-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
        await fileStorage.replace(temporary, join(this.#directory, 'download.json'))
      }
      finally {
        await rm(temporary, { force: true })
      }
    })
  }

  async summary(): Promise<DesktopUpdateCacheSummary> {
    const files = await this.#files()
    return { bytes: files.reduce((sum, file) => sum + file.size, 0), files: files.length }
  }

  async verifiedPath(update: DesktopUpdatePackage): Promise<string | null> {
    try {
      const pending = await this.#pendingDirectory()
      const path = join(pending, update.name)
      return await verifyDesktopUpdatePackage(path, update) ? path : null
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return null
      throw error
    }
  }

  cleanup(plan: DesktopUpdatePlan, activeDownload?: string): Promise<void> {
    return this.#enqueue(async () => {
      const protectedNames = new Set([plan.update?.name, plan.fallback?.name].filter(Boolean))
      for (const file of await this.#files()) {
        if ((!file.temporary && protectedNames.has(file.name)) || (file.temporary && file.name === `${activeDownload}.download`))
          continue
        const obsolete = compareDesktopVersions(file.version, this.#currentVersion) <= 0 || (plan.update && compareDesktopVersions(file.version, plan.update.version) < 0)
        if (obsolete || (file.temporary && Date.now() - file.modifiedAt > 24 * 60 * 60_000))
          await this.#remove(file.path)
      }
    })
  }

  clear(): Promise<void> {
    return this.#enqueue(async () => {
      for (const file of await this.#files())
        await this.#remove(file.path)
      await rm(join(this.#directory, 'download.json'), { force: true })
    })
  }

  async #validateDirectory(): Promise<void> {
    const info = await lstat(this.#directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('UPDATE_CACHE_INVALID')
  }

  async #pendingDirectory(): Promise<string> {
    await this.#validateDirectory()
    const pending = join(this.#directory, 'pending')
    const info = await lstat(pending)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('UPDATE_CACHE_INVALID')
    return pending
  }

  async #files() {
    const files: { name: string, path: string, version: string, temporary: boolean, size: number, modifiedAt: number }[] = []
    try {
      const pending = await this.#pendingDirectory()
      for (const name of await readdir(pending)) {
        const owned = ownedPackage(name)
        if (!owned)
          continue
        const path = join(pending, name)
        try {
          const info = await lstat(path)
          if (info.isFile() && !info.isSymbolicLink())
            files.push({ name, path, ...owned, size: info.size, modifiedAt: info.mtimeMs })
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error
        }
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
    return files
  }

  async #remove(path: string): Promise<void> {
    try {
      await rm(path, { force: true })
    }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(operation)
    this.#tail = pending.catch(() => {})
    return pending
  }
}

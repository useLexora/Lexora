import type { Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

export type ReleaseFileSystem = Pick<typeof fs, 'createReadStream' | 'promises'>

export const WINDOWS_DESKTOP_FILENAME = 'Lexora Buddy.exe'
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const resourcePath = z.string().min(1).max(1024).refine(value => !isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => part === '..' || part === '.' || part === '') && !value.includes('\0'))
export const releaseSetContentSchema = z.object({
  version: z.literal(1),
  productVersion: z.string().min(1).max(100),
  target: z.enum(['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'darwin-arm64']),
  core: z.object({ entry: resourcePath, manifest: resourcePath, manifestSha256: digestSchema }).strict(),
  node: z.object({ entry: resourcePath, version: z.string().regex(/^\d+\.\d+\.\d+$/), archiveSha256: digestSchema, binarySha256: digestSchema }).strict(),
  host: z.object({ kind: z.enum(['asar', 'inventory']), path: resourcePath, sha256: digestSchema }).strict(),
  desktop: z.object({ fileName: z.literal(WINDOWS_DESKTOP_FILENAME), sha256: digestSchema }).strict().optional(),
}).strict().refine((set) => {
  if (!set.target.startsWith('win32-') || set.host.kind === 'inventory')
    return set.desktop === undefined
  return !!set.desktop && set.host.path === 'app.asar' && set.core.entry === 'lexora-service/service.mjs' && set.core.manifest === 'lexora-service/resources.json' && set.node.entry === 'lexora-runtime/node.exe'
}, 'SERVICE_RELEASE_FILE_INVALID')
export const releaseSetSchema = releaseSetContentSchema.safeExtend({ buildId: digestSchema })
export type ReleaseSet = z.infer<typeof releaseSetSchema>

export function createReleaseSet(input: z.infer<typeof releaseSetContentSchema>): ReleaseSet {
  const value = releaseSetContentSchema.parse(input)
  return { ...value, buildId: createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }
}

export async function readReleaseSet(path: string, fileSystem: ReleaseFileSystem = fs) {
  const release = await readReleaseIdentity(path, fileSystem)
  await verifyReleaseSet(release, fileSystem)
  return release
}

export async function readReleaseIdentity(path: string, fileSystem: ReleaseFileSystem = fs) {
  const { realpath, lstat, readFile } = fileSystem.promises
  const resourcesRoot = await realpath(dirname(path))
  const file = join(resourcesRoot, basename(path))
  const metadata = await lstat(file, { bigint: true })
  if (!metadata.isFile() || metadata.size > 64n * 1024n)
    throw new Error('SERVICE_RELEASE_FILE_INVALID')
  const generation = releaseGeneration(metadata)
  const manifest = releaseSetSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  if (releaseGeneration(await lstat(file, { bigint: true })) !== generation)
    throw new Error('SERVICE_RELEASE_IDENTITY_CHANGED')
  const { buildId, ...content } = manifest
  if (buildId !== createReleaseSet(content).buildId)
    throw new Error('SERVICE_RELEASE_IDENTITY_CHANGED')
  if (manifest.target.startsWith('win32-') && manifest.host.kind === 'inventory' && (basename(dirname(path)) !== '.output' || basename(resourcesRoot) !== '.output'))
    throw new Error('SERVICE_RELEASE_FILE_INVALID')
  const desktop = manifest.desktop ? await windowsDesktopIdentity(dirname(path), fileSystem) : undefined
  const coreEntry = await resolveReleaseResource(resourcesRoot, manifest.core.entry, fileSystem)
  const nodeExecutable = await resolveReleaseResource(resourcesRoot, manifest.node.entry, fileSystem)
  const coreManifest = await resolveReleaseResource(resourcesRoot, manifest.core.manifest, fileSystem)
  const hostArtifact = await resolveReleaseResource(resourcesRoot, manifest.host.path, fileSystem)
  return { file, generation: installationGeneration(generation, desktop?.generation), manifest, resourcesRoot, nodeExecutable, coreEntry, coreManifest, hostArtifact, desktop }
}

export type ReleaseIdentity = Awaited<ReturnType<typeof readReleaseIdentity>>

function releaseGeneration(metadata: fs.BigIntStats) {
  return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}:${metadata.ctimeNs}`
}

export async function windowsDesktopIdentity(resources: string, fileSystem: ReleaseFileSystem = fs) {
  const { realpath, lstat } = fileSystem.promises
  const root = await realpath(dirname(resolve(resources)))
  if (basename(resources) !== 'resources' || !(await lstat(resources)).isDirectory() || await realpath(resources) !== join(root, 'resources'))
    throw new Error('SERVICE_RESOURCE_OUTSIDE_RELEASE')
  const path = join(root, WINDOWS_DESKTOP_FILENAME)
  const stat = await lstat(path, { bigint: true })
  if (!stat.isFile() || await realpath(path) !== path)
    throw new Error('SERVICE_RELEASE_FILE_INVALID')
  return { path, generation: desktopGeneration(stat), reusable: !!stat.ino && !!stat.ctimeNs }
}

function desktopGeneration(stat: fs.BigIntStats) {
  return `${releaseGeneration(stat)}:${stat.size}:${stat.mtimeNs}`
}

function installationGeneration(manifest: string, desktop?: string) {
  return desktop ? `${manifest}/${desktop}` : manifest
}

export async function assertReleaseGeneration(release: ReleaseIdentity, fileSystem: ReleaseFileSystem = fs) {
  const metadata = await fileSystem.promises.lstat(release.file, { bigint: true })
  const desktop = release.desktop && desktopGeneration(await fileSystem.promises.lstat(release.desktop.path, { bigint: true }))
  if (!metadata.isFile() || installationGeneration(releaseGeneration(metadata), desktop) !== release.generation)
    throw new Error('SERVICE_RELEASE_IDENTITY_CHANGED')
}

export async function resolveReleaseResource(resourcesRoot: string, value: string, fileSystem: ReleaseFileSystem) {
  const { lstat, realpath } = fileSystem.promises
  const path = resolve(resourcesRoot, value)
  if (!(await lstat(path)).isFile())
    throw new Error('SERVICE_RELEASE_FILE_INVALID')
  const location = await realpath(path)
  const boundary = relative(resourcesRoot, location)
  if (isAbsolute(boundary) || boundary === '..' || boundary.startsWith(`..${sep}`))
    throw new Error('SERVICE_RESOURCE_OUTSIDE_RELEASE')
  return location
}

export async function verifyReleaseSet(release: ReleaseIdentity, fileSystem: ReleaseFileSystem = fs) {
  const { manifest, coreEntry, nodeExecutable, coreManifest, hostArtifact } = release
  const { readFile } = fileSystem.promises
  const hash = (file: string) => hashReleaseFile(file, fileSystem)
  if (release.desktop && await hash(release.desktop.path) !== manifest.desktop?.sha256)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  if (await hash(coreManifest) !== manifest.core.manifestSha256 || await hash(hostArtifact) !== manifest.host.sha256)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  const core = JSON.parse(await readFile(coreManifest, 'utf8')) as { entry?: string, bundled?: Array<{ path: string, sha256: string }>, inventory?: { path: string, sha256: string } }
  const entryName = relative(dirname(coreManifest), coreEntry).split(sep).join('/')
  const recordedEntry = core.bundled?.find(entry => entry.path === entryName)
  if (core.entry !== entryName || !recordedEntry || await hash(coreEntry) !== recordedEntry.sha256)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  if (await hash(nodeExecutable) !== manifest.node.binarySha256 || !core.inventory)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  const coreInventory = await resolveReleaseResource(dirname(coreManifest), resourcePath.parse(core.inventory.path), fileSystem)
  if (await hash(coreInventory) !== digestSchema.parse(core.inventory.sha256))
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  await verifyFileInventory(coreInventory, [coreManifest], fileSystem)
  if (manifest.host.kind === 'inventory')
    await verifyFileInventory(hostArtifact, [], fileSystem)
  await assertReleaseGeneration(release, fileSystem)
}

export async function hashReleaseFile(path: string, fileSystem: ReleaseFileSystem = fs): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fileSystem.createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
  return value
}

const inventoryEntrySchema = z.union([
  z.object({ path: resourcePath, size: z.number().int().nonnegative(), sha256: digestSchema }).strict(),
  z.object({ path: resourcePath, link: z.string().min(1).max(1024) }).strict(),
])
const inventoryVerificationBatchSize = 8

export async function verifyFileInventory(inventoryPath: string, excluded: string[] = [], fileSystem: ReleaseFileSystem = fs) {
  const { lstat, readdir, readFile, readlink, realpath } = fileSystem.promises
  const root = await realpath(dirname(inventoryPath))
  const inventory = z.object({ version: z.literal(1), files: z.array(inventoryEntrySchema).max(100_000) }).strict().parse(JSON.parse(await readFile(inventoryPath, 'utf8')))
  const expected = new Map(inventory.files.map(entry => [entry.path, entry]))
  if (expected.size !== inventory.files.length)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  async function* visit(directory: string): AsyncGenerator<Dirent> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (path === inventoryPath || excluded.includes(path))
        continue
      if (entry.isDirectory())
        yield* visit(path)
      else
        yield entry
    }
  }
  async function verify(entry: Dirent) {
    const path = join(entry.parentPath, entry.name)
    const name = relative(root, path).split(sep).join('/')
    const recorded = expected.get(name)
    if (!recorded)
      throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
    expected.delete(name)
    if ('link' in recorded) {
      if (!entry.isSymbolicLink())
        throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
      const target = await readlink(path)
      const actual = await realpath(path)
      const boundary = relative(root, actual)
      if (target.split(sep).join('/') !== recorded.link || isAbsolute(target) || isAbsolute(boundary) || boundary === '..' || boundary.startsWith(`..${sep}`))
        throw new Error('SERVICE_RESOURCE_OUTSIDE_RELEASE')
    }
    else if (!entry.isFile() || (await lstat(path)).size !== recorded.size || await hashReleaseFile(path, fileSystem) !== recorded.sha256) {
      throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
    }
  }
  let batch: Dirent[] = []
  for await (const entry of visit(root)) {
    batch.push(entry)
    if (batch.length === inventoryVerificationBatchSize) {
      await Promise.all(batch.map(verify))
      batch = []
    }
  }
  await Promise.all(batch.map(verify))
  if (expected.size)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
}

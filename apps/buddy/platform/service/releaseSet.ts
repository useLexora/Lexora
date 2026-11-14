import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

export type ReleaseFileSystem = Pick<typeof fs, 'createReadStream' | 'promises'>

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const resourcePath = z.string().min(1).max(1024).refine(value => !isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => part === '..' || part === '.' || part === '') && !value.includes('\0'))
export const releaseSetContentSchema = z.object({
  version: z.literal(1),
  productVersion: z.string().min(1).max(100),
  target: z.enum(['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'darwin-arm64']),
  core: z.object({ entry: resourcePath, manifest: resourcePath, manifestSha256: digestSchema }).strict(),
  node: z.object({ entry: resourcePath, version: z.string().regex(/^\d+\.\d+\.\d+$/), archiveSha256: digestSchema, binarySha256: digestSchema }).strict(),
  host: z.object({ kind: z.enum(['asar', 'inventory']), path: resourcePath, sha256: digestSchema }).strict(),
}).strict()
export const releaseSetSchema = releaseSetContentSchema.extend({ buildId: digestSchema }).strict()
export type ReleaseSet = z.infer<typeof releaseSetSchema>

export function createReleaseSet(input: z.infer<typeof releaseSetContentSchema>): ReleaseSet {
  const value = releaseSetContentSchema.parse(input)
  return { ...value, buildId: createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }
}

export async function readReleaseSet(path: string, fileSystem: ReleaseFileSystem = fs) {
  const { realpath, readFile } = fileSystem.promises
  const hash = (file: string) => hashReleaseFile(file, fileSystem)
  const file = await realpath(path)
  const resourcesRoot = dirname(file)
  const manifest = releaseSetSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const { buildId, ...content } = manifest
  if (buildId !== createReleaseSet(content).buildId)
    throw new Error('SERVICE_RELEASE_IDENTITY_CHANGED')
  const resolveResource = async (value: string) => {
    const location = await realpath(resolve(resourcesRoot, value))
    const boundary = relative(resourcesRoot, location)
    if (isAbsolute(boundary) || boundary === '..' || boundary.startsWith(`..${sep}`))
      throw new Error('SERVICE_RESOURCE_OUTSIDE_RELEASE')
    return location
  }
  const coreManifest = await resolveResource(manifest.core.manifest)
  const hostArtifact = await resolveResource(manifest.host.path)
  if (await hash(coreManifest) !== manifest.core.manifestSha256 || await hash(hostArtifact) !== manifest.host.sha256)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  const coreEntry = await resolveResource(manifest.core.entry)
  const nodeExecutable = await resolveResource(manifest.node.entry)
  const core = JSON.parse(await readFile(coreManifest, 'utf8')) as { entry?: string, bundled?: Array<{ path: string, sha256: string }>, inventory?: { path: string, sha256: string } }
  const entryName = relative(dirname(coreManifest), coreEntry).split(sep).join('/')
  const recordedEntry = core.bundled?.find(entry => entry.path === entryName)
  if (core.entry !== entryName || !recordedEntry || await hash(coreEntry) !== recordedEntry.sha256)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  if (await hash(nodeExecutable) !== manifest.node.binarySha256 || !core.inventory)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  const coreInventory = await resolveResource(relative(resourcesRoot, join(dirname(coreManifest), resourcePath.parse(core.inventory.path))))
  if (await hash(coreInventory) !== digestSchema.parse(core.inventory.sha256))
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  await verifyFileInventory(coreInventory, [coreManifest], fileSystem)
  if (manifest.host.kind === 'inventory')
    await verifyFileInventory(hostArtifact, [], fileSystem)
  return { manifest, resourcesRoot, nodeExecutable, coreEntry }
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

export async function verifyFileInventory(inventoryPath: string, excluded: string[] = [], fileSystem: ReleaseFileSystem = fs) {
  const { lstat, readdir, readFile, readlink, realpath } = fileSystem.promises
  const root = await realpath(dirname(inventoryPath))
  const inventory = z.object({ version: z.literal(1), files: z.array(inventoryEntrySchema).max(100_000) }).strict().parse(JSON.parse(await readFile(inventoryPath, 'utf8')))
  const expected = new Map(inventory.files.map(entry => [entry.path, entry]))
  if (expected.size !== inventory.files.length)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (path === inventoryPath || excluded.includes(path))
        continue
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
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
  }
  await visit(root)
  if (expected.size)
    throw new Error('SERVICE_RELEASE_CONTENT_CHANGED')
}

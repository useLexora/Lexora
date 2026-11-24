import type { ReleaseFileSystem, ReleaseIdentity } from './releaseSet'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { createBuddyNativeEnvironment, resolveBuddyPrivateDirectories, resolveBuddyProcessControl, resolveBuddyShellSandbox } from '../native/nativeHost'
import searchTools from '../native/searchTools.json'
import { storageBootstrapRoot } from '../storage/StorageLocationStore'
import { ensureWindowsPrivateDirectories } from '../windows/privateDirectories'
import { installationActive } from './installationGate'
import { assertReleaseGeneration, readReleaseIdentity, resolveReleaseResource, verifyReleaseSet } from './releaseSet'
import { readPrivateServiceJson, writePrivateServiceJson } from './serviceFiles'

export async function readRuntimeRelease(path: string, fileSystem: ReleaseFileSystem = fs) {
  const release = await readReleaseIdentity(path, fileSystem)
  if (release.manifest.target !== `${process.platform}-${process.arch}`)
    throw new Error('SERVICE_RELEASE_TARGET_CHANGED')
  const resourcesRoot = join(dirname(release.coreEntry), 'resources')
  const { lstat, realpath } = fileSystem.promises
  if (!(await lstat(resourcesRoot)).isDirectory() || await realpath(resourcesRoot) !== resourcesRoot)
    throw new Error('SERVICE_RESOURCE_OUTSIDE_RELEASE')
  const native = { serviceResourcesRoot: resourcesRoot }
  const privateDirectoriesExecutable = resolveBuddyPrivateDirectories(native)
  const search = Object.values(searchTools.tools).map(tool => join(resourcesRoot, searchTools.resource.to, tool.targets[release.manifest.target].binary))
  const helpers = [...Object.values(createBuddyNativeEnvironment(native)), ...search, privateDirectoriesExecutable, resolveBuddyShellSandbox(native)].filter((file): file is string => !!file)
  for (const helper of helpers)
    await resolveReleaseResource(resourcesRoot, relative(resourcesRoot, helper), fileSystem)
  const fingerprint = createHash('sha256')
  const entries = [release.file, release.coreEntry, release.nodeExecutable, release.coreManifest, release.hostArtifact, ...helpers]
  let reusable = release.desktop?.reusable ?? true
  for (const entry of entries) {
    const stat = await lstat(entry, { bigint: true })
    if (!stat.isFile())
      throw new Error('SERVICE_RELEASE_FILE_INVALID')
    if (!stat.ino || !stat.ctimeNs)
      reusable = false
    fingerprint.update(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}\n`)
  }
  return { ...release, serviceResources: resourcesRoot, privateDirectoriesExecutable, entries: fingerprint.digest('hex'), reusable }
}

type RuntimeRelease = Awaited<ReturnType<typeof readRuntimeRelease>>
export type ActivationPhase = 'full_inventory' | 'installed_identity'

export async function activateRuntimeRelease(release: RuntimeRelease, defaultRoot: string, userId: string, fileSystem: ReleaseFileSystem = fs): Promise<ActivationPhase> {
  const checkInstallation = () => {
    if (installationActive(resolveBuddyProcessControl({ serviceResourcesRoot: release.serviceResources })))
      throw new Error('INSTALLATION_ACTIVE')
  }
  const directory = join(storageBootstrapRoot(defaultRoot), 'activation')
  const receiptPath = join(directory, 'activation.json')
  const receipt = { version: 1 as const, userId, buildId: release.manifest.buildId, releaseFile: release.file, generation: release.generation, entries: release.entries }
  const schema = z.object({ version: z.literal(1), userId: z.literal(userId), buildId: z.literal(receipt.buildId), releaseFile: z.literal(receipt.releaseFile), generation: z.literal(receipt.generation), entries: z.literal(receipt.entries) }).strict()
  if (release.reusable) {
    try {
      if (schema.safeParse(await readPrivateServiceJson(receiptPath)).success) {
        await checkReceiptDirectory(directory, release.privateDirectoriesExecutable)
        if (!schema.safeParse(await readPrivateServiceJson(receiptPath)).success)
          throw new Error('SERVICE_ACTIVATION_RECEIPT_CHANGED')
        await assertReleaseGeneration(release, fileSystem)
        checkInstallation()
        return 'installed_identity'
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error
    }
  }
  await verifyReleaseSet(release, fileSystem)
  const current = await readRuntimeRelease(release.file, fileSystem)
  if (current.manifest.buildId !== release.manifest.buildId || current.entries !== release.entries || current.generation !== release.generation)
    throw new Error('SERVICE_RELEASE_IDENTITY_CHANGED')
  checkInstallation()
  if (current.reusable) {
    if (process.platform === 'win32')
      await ensureWindowsPrivateDirectories([directory], release.privateDirectoriesExecutable, 'activation_receipt')
    else
      await ensurePrivateDirectories([directory])
    await checkReceiptDirectory(directory, release.privateDirectoriesExecutable)
    await writePrivateServiceJson(receiptPath, receipt)
    await assertReleaseGeneration(release, fileSystem)
  }
  return 'full_inventory'
}

async function checkReceiptDirectory(directory: string, executable?: string) {
  const stat = await fs.promises.lstat(directory)
  if (!stat.isDirectory() || await fs.promises.realpath(directory) !== directory || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)))
    throw new Error('SERVICE_ACTIVATION_DIRECTORY_INVALID')
  if (process.platform === 'win32')
    await ensureWindowsPrivateDirectories([directory], executable, 'activation_receipt')
}

export async function assertCurrentCore(release: ReleaseIdentity) {
  if (await fs.promises.realpath(process.argv[1]!) !== release.coreEntry || await fs.promises.realpath(process.execPath) !== release.nodeExecutable || process.versions.node !== release.manifest.node.version || (process.platform === 'linux' && await fs.promises.readlink('/proc/self/exe') !== release.nodeExecutable))
    throw new Error('SERVICE_RELEASE_IDENTITY_CHANGED')
}

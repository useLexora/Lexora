import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { serviceLaunchSchema } from '../../shared/service/localServiceProtocol'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { syncStorageDirectory } from '../storage/storageFiles'

export async function readPrivateServiceJson(path: string): Promise<unknown> {
  if (!isAbsolute(path))
    throw new Error('SERVICE_PATH_INVALID')
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024
    || (process.platform !== 'win32' && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0))) {
    throw new Error('SERVICE_PRIVATE_FILE_INVALID')
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await file.stat()
    if (current.dev !== metadata.dev || current.ino !== metadata.ino || current.size > 64 * 1024)
      throw new Error('SERVICE_PRIVATE_FILE_CHANGED')
    return JSON.parse(await file.readFile('utf8'))
  }
  finally { await file.close() }
}

export async function writePrivateServiceJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
    await file.close()
    await rename(temporary, path)
    await syncStorageDirectory(dirname(path))
  }
  finally {
    await file.close()
    await rm(temporary, { force: true })
  }
}

export async function readServiceLaunch(path: string) {
  const input = serviceLaunchSchema.parse(await readPrivateServiceJson(path))
  for (const path of [input.profileRoot, input.defaultRoot, input.resourcesRoot, input.nodeExecutable, input.coreEntry, input.hostExecutable, input.releaseSetPath, input.leaseDirectory, input.privateDirectoriesExecutable]) {
    if (path !== undefined && !isAbsolute(path))
      throw new Error('SERVICE_PATH_INVALID')
  }
  await ensurePrivateDirectories([input.profileRoot], input.privateDirectoriesExecutable)
  return { ...input, profileRoot: await realpath(input.profileRoot) }
}

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { isWindows } from '../../shared/platform/identifiers'

export async function createSandboxDirectory(): Promise<string> {
  const directory = await mkdtemp(join(isWindows(process.platform) ? tmpdir() : '/tmp', 'lexora-shell-'))
  try {
    const canonical = await realpath(directory)
    await Promise.all(['home', 'tmp'].map(path => mkdir(join(canonical, path), { mode: 0o700 })))
    return canonical
  }
  catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

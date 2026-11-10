import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it, vi } from 'vitest'
import * as nativeFiles from '../../../../platform/filesystem/nativeFileStream'
import { readArtifactFile } from '../ArtifactFileAccess'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-artifact-read-')))
  directories.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const currentPath = join(workspace, 'report.txt')
  await writeFile(currentPath, 'original')
  return { root, workspace, currentPath }
}

it('does not read a replacement file and reports the observed change', async () => {
  const f = await fixture()
  const open = nativeFiles.openNativeFileStream
  vi.spyOn(nativeFiles, 'openNativeFileStream').mockImplementation(async (...args) => {
    await rename(f.currentPath, join(f.root, 'original.txt'))
    await writeFile(f.currentPath, 'replaced')
    return open(...args)
  })
  await expect(readArtifactFile(f, 1024)).rejects.toMatchObject({ code: 'FILE_CHANGED' })
})

it('reports a file removed between metadata lookup and native open as missing', async () => {
  const f = await fixture()
  const open = nativeFiles.openNativeFileStream
  vi.spyOn(nativeFiles, 'openNativeFileStream').mockImplementation(async (...args) => {
    await rm(f.currentPath)
    return open(...args)
  })
  await expect(readArtifactFile(f, 1024)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports actual OS read denial instead of a directory grant failure', async () => {
  const f = await fixture()
  await chmod(f.currentPath, 0)
  try {
    await expect(readArtifactFile(f, 1024)).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' })
  }
  finally { await chmod(f.currentPath, 0o600) }
})

it('rejects a replaced parent even when the original directory is restored before reinspection', async () => {
  const f = await fixture()
  const parked = join(f.root, 'parked')
  const open = nativeFiles.openNativeFileStream
  vi.spyOn(nativeFiles, 'openNativeFileStream').mockImplementation(async (...args) => {
    await rename(f.workspace, parked)
    await mkdir(f.workspace)
    await writeFile(f.currentPath, 'replaced')
    try {
      return await open(...args)
    }
    finally {
      await rm(f.workspace, { recursive: true })
      await rename(parked, f.workspace)
    }
  })
  await expect(readArtifactFile(f, 1024)).rejects.toMatchObject({ code: 'FILE_READ_FAILED' })
})

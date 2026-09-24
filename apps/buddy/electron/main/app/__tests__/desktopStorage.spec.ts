import { mkdirSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateDirectoryError } from '../../../../platform/windows/privateDirectories'
import { checkDesktopDirectories, prepareDesktopPrivateStorage } from '../desktopStorage'

const native = vi.hoisted(() => ({ failure: undefined as unknown }))
vi.mock('../../../../platform/filesystem/privateDirectories', () => {
  const prepare = (paths: string[]) => {
    if (native.failure)
      throw native.failure
    for (const path of paths)
      mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  return { ensurePrivateDirectories: async (paths: string[]) => prepare(paths), ensurePrivateDirectoriesSync: prepare }
})
beforeEach(() => {
  native.failure = undefined
})

describe('startup data directory checks', () => {
  it('verifies file access and cleans up only its own probe, preserving existing data', async () => {
    const directory = await createTemporaryDirectory('buddy-storage-')
    await writeFile(join(directory, 'preserved.txt'), 'existing data')
    await checkDesktopDirectories({ lexora_home: directory, user_data: directory })
    expect(await readdir(directory)).toEqual(['preserved.txt'])
    expect(await readFile(join(directory, 'preserved.txt'), 'utf8')).toBe('existing data')
  })

  it('creates private product storage before nested Electron directories', async () => {
    const directory = await createTemporaryDirectory('buddy-storage-')
    const home = join(directory, 'product')
    prepareDesktopPrivateStorage(home)
    expect(await readdir(home)).toEqual([])
    await checkDesktopDirectories({ lexora_home: home, user_data: join(home, '.runtime', 'electron') })
    expect(await readdir(home)).toEqual(['.runtime'])
    expect(await readdir(join(home, '.runtime', 'electron'))).toEqual([])
  })

  it('does not create runtime directories when private product storage is rejected', async () => {
    const directory = await createTemporaryDirectory('buddy-storage-')
    native.failure = new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNSAFE', { kind: 'private_directories', operation: 'validate_acl', directoryIndex: 0 })
    expect(() => prepareDesktopPrivateStorage(directory)).toThrow(native.failure)
    await expect(checkDesktopDirectories({ lexora_home: directory, user_data: join(directory, 'electron') })).rejects.toMatchObject({ failure: { directoryRole: 'lexora_home' } })
    expect(await readdir(directory)).toEqual([])
  })

  it('checks ordinary Electron storage availability without imposing a private ACL policy', async () => {
    const directory = await createTemporaryDirectory('buddy-storage-')
    native.failure = new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNSAFE', { kind: 'private_directories', operation: 'validate_acl' })
    await writeFile(join(directory, 'preserved.txt'), 'existing session data')
    await checkDesktopDirectories({ user_data: directory, session_data: join(directory, 'session'), window_state: join(directory, 'state') })
    expect(await readFile(join(directory, 'preserved.txt'), 'utf8')).toBe('existing session data')
    expect((await readdir(directory)).sort()).toEqual(['preserved.txt', 'session', 'state'])
  })

  it('reports directory creation conflicts without overwriting existing data', async () => {
    const directory = await createTemporaryDirectory('buddy-storage-')
    const conflict = join(directory, 'conflict')
    await writeFile(conflict, 'existing data')
    await expect(checkDesktopDirectories({ user_data: conflict })).rejects.toMatchObject({ code: 'DESKTOP_BOOTSTRAP_FAILED', failure: { kind: 'desktop_bootstrap', operation: 'create_directory', directoryRole: 'user_data', systemCode: 'EEXIST' } })
    expect(await readFile(conflict, 'utf8')).toBe('existing data')
  })
})

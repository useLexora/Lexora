import { mkdirSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateDirectoryError } from '../../../../platform/windows/privateDirectories'
import { checkDesktopDirectories, prepareDesktopPrivateStorage } from '../desktopStorage'
import { inheritMissingChromiumState } from '../windowsChromiumSession'

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

  it('does not guess a key when two historical states disagree', async () => {
    const directory = await createTemporaryDirectory('buddy-ambiguous-state-')
    const session = join(directory, 'chromium')
    const candidates = ['one', 'two'].map(name => join(directory, name))
    mkdirSync(session)
    for (const [i, candidate] of candidates.entries()) {
      mkdirSync(candidate)
      await writeFile(join(candidate, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: `fixture-${i}` } }))
    }
    for (const order of [candidates, candidates.toReversed()])
      expect(inheritMissingChromiumState(session, order)).toBe('conflict')
    expect(await readdir(session)).toEqual([])
    for (const [i, candidate] of candidates.entries())
      expect(JSON.parse(await readFile(join(candidate, 'Local State'), 'utf8')).os_crypt.encrypted_key).toBe(`fixture-${i}`)
  })

  it('inherits a missing Chromium state once without overwriting or backfilling other profiles', async () => {
    const directory = await createTemporaryDirectory('buddy-local-state-')
    const session = join(directory, 'chromium')
    const older = join(directory, 'old')
    const missing = join(directory, 'never-used')
    mkdirSync(session)
    mkdirSync(older)
    const original = JSON.stringify({ os_crypt: { encrypted_key: 'fixture-A' } })
    const different = JSON.stringify({ os_crypt: { encrypted_key: 'fixture-B' } })
    await writeFile(join(older, 'Local State'), original)
    inheritMissingChromiumState(session, [missing, older])
    expect(await readFile(join(session, 'Local State'), 'utf8')).toBe(original)
    await writeFile(join(older, 'Local State'), different)
    inheritMissingChromiumState(session, [older, missing])
    expect(await readFile(join(session, 'Local State'), 'utf8')).toBe(original)
    expect(await readFile(join(older, 'Local State'), 'utf8')).toBe(different)
    await expect(readdir(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

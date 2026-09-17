import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { localTransports } from '../localTransport'

describe.skipIf(process.platform === 'win32')('unix socket directory ownership', () => {
  it('creates a private endpoint parent and rejects public or redirected parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-socket-'))
    try {
      const parent = join(root, 'private')
      await localTransports.unix(join(parent, 'browser.sock')).prepare()
      expect((await lstat(parent)).mode & 0o777).toBe(0o700)
      const publicDirectory = join(root, 'public')
      await mkdir(publicDirectory)
      await chmod(publicDirectory, 0o777)
      await expect(localTransports.unix(join(publicDirectory, 'browser.sock')).prepare()).rejects.toThrow('private directory')
      await symlink(parent, join(root, 'alias'))
      await expect(localTransports.unix(join(root, 'alias/browser.sock')).prepare()).rejects.toThrow('private directory')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

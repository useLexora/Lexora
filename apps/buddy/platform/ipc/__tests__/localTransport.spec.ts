import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
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

it.skipIf(process.platform === 'win32')('never unlinks an active socket or a socket it did not bind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-owned-socket-'))
  const address = join(root, 'active.sock')
  const server = createServer(socket => socket.destroy())
  try {
    await new Promise<void>(resolve => server.listen(address, resolve))
    const original = await lstat(address)
    const contender = localTransports.unix(address, { ownsProfileLease: () => true })
    await expect(contender.prepare()).rejects.toThrow('already owned')
    await contender.dispose()
    expect((await lstat(address)).ino).toBe(original.ino)
  }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

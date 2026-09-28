import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { WebContentCache } from '../WebContentCache'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir), writeFile: vi.fn(actual.writeFile) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(readdir).mockReset()
  vi.mocked(writeFile).mockReset()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(readdir).mockImplementation(actual.readdir)
  vi.mocked(writeFile).mockImplementation(actual.writeFile)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'web-cache-events-'))
  roots.push(root)
  return new WebContentCache(new BuddyDataPaths(root))
}

describe('web cache commit boundary', () => {
  it('returns the committed file even when old cache enumeration fails', async () => {
    const cache = await fixture()
    vi.mocked(readdir).mockRejectedValueOnce(new Error('cleanup-failed'))
    const receipt = await cache.write('conversation', 'committed content')
    expect(receipt).toMatchObject({ cleanup: 'failed', removed: 0, bytes: 17 })
    expect(await readFile(receipt.path, 'utf8')).toBe('committed content')
    await cache.dispose()
  })

  it('finishes an admitted write after cancellation and drains it before disposal', async () => {
    const cache = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return actual.writeFile(...args)
    })
    const controller = new AbortController()
    const write = cache.write('conversation', 'accepted', controller.signal)
    await entered.promise
    controller.abort()
    let disposed = false
    const disposing = cache.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve()
    const receipt = await write
    await disposing
    expect(await readFile(receipt.path, 'utf8')).toBe('accepted')
    await expect(cache.write('conversation', 'late')).rejects.toThrow('WEB_CACHE_STOPPED')
  })

  it('does not remove an existing file when exclusive creation rejects', async () => {
    const cache = await fixture()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let existing = ''
    vi.mocked(writeFile).mockImplementationOnce(async (path) => {
      existing = String(path)
      await actual.writeFile(path, 'previous owner', { flag: 'wx' })
      throw Object.assign(new Error('file already exists'), { code: 'EEXIST' })
    })
    await expect(cache.write('conversation', 'new content')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(existing, 'utf8')).toBe('previous owner')
    await cache.dispose()
  })

  it('does not start a queued write after its cancellation', async () => {
    const cache = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(cache.write('conversation', 'not written', controller.signal)).rejects.toThrow()
    expect(writeFile).not.toHaveBeenCalled()
    await cache.dispose()
  })
})

import type { AuthInfo } from 'electron'
import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deferred } from '@buddy-tests/deferred'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { autoUpdater } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MacUpdateInstaller } from '../MacUpdateInstaller'

const transport = vi.hoisted(() => ({
  feed: '',
  login: undefined as ((auth: AuthInfo) => Promise<string[]>) | undefined,
  check: vi.fn(),
  download: vi.fn(),
  finish: vi.fn(),
  close: vi.fn(),
  nativeCheck: vi.fn(),
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { autoUpdater: Object.assign(new EventEmitter(), { checkForUpdates: transport.nativeCheck }) }
})
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: { MacUpdater: class extends EventEmitter {
    netSession = { closeAllConnections: transport.close }
    constructor() {
      super()
      transport.login = auth => new Promise(resolve => this.emit('login', auth, (username: string, password: string) => resolve([username, password])))
    }

    setFeedURL(input: { url: string }) { transport.feed = input.url }
    checkForUpdates = transport.check
    downloadUpdate = transport.download
    quitAndInstall = transport.finish
  } } }
})

const body = Buffer.from('isolated macOS update archive')
const update = { version: '1.2.3', name: 'Lexora-Buddy-1.2.3-macos-arm64.zip', url: 'https://github.com/useLexora/Lexora/releases/download/v1.2.3/Lexora-Buddy-1.2.3-macos-arm64.zip', sha256: 'a'.repeat(64), size: body.length }
const proxy: AuthInfo = { isProxy: true, host: '127.0.0.1', port: 12345, scheme: 'basic', realm: 'fixture' }

beforeEach(() => {
  transport.check.mockReset()
  transport.download.mockReset()
  transport.close.mockResolvedValue(undefined)
  transport.nativeCheck.mockReset()
  transport.finish.mockReset()
  autoUpdater.removeAllListeners()
})
afterEach(() => vi.useRealTimers())

async function fixture() {
  const directory = await createTemporaryDirectory('mac-update-installer-')
  const path = join(directory, update.name)
  await writeFile(path, body)
  const installer = new MacUpdateInstaller((auth, callback) => {
    if (!auth.isProxy || auth.host !== proxy.host || auth.port !== proxy.port)
      return false
    callback('fixture-user', 'fixture-password')
    return true
  })
  return { installer, path, directory }
}

it('serves the verified archive, authenticates only the host proxy, and waits for native staging before offering installation', async () => {
  const f = await fixture()
  const staged = deferred<void>()
  const operations: string[] = []
  transport.check.mockImplementation(async () => {
    expect(await transport.login!(proxy)).toEqual(['fixture-user', 'fixture-password'])
    expect(await transport.login!({ ...proxy, isProxy: false })).toEqual(['', ''])
    expect(await transport.login!({ ...proxy, port: proxy.port + 1 })).toEqual(['', ''])
    const response = await fetch(`${transport.feed}latest-mac.yml`)
    const metadata = await response.json()
    expect(metadata).toMatchObject({ version: update.version, files: [{ url: update.name, size: body.length }] })
    operations.push('metadata')
    return { updateInfo: metadata }
  })
  transport.download.mockImplementation(async () => {
    const response = await fetch(`${transport.feed}${update.name}`)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body)
    operations.push('archive')
  })
  transport.nativeCheck.mockImplementation(() => {
    staged.resolve()
  })
  transport.finish.mockImplementation(() => {
    operations.push('install')
  })
  const pending = f.installer.prepare(f.path, update, f.directory)
  await staged.promise
  expect(operations).toEqual(['metadata', 'archive'])
  autoUpdater.emit('update-downloaded')
  const install = await pending
  await expect(fetch(transport.feed)).rejects.toThrow()
  install()
  expect(operations).toEqual(['metadata', 'archive', 'install'])
})

it.each(['metadata', 'download', 'native'] as const)('bounds %s preparation and rejects late completion after timeout', async (stage) => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const entered = deferred<void>()
  const finish = deferred<void>()
  const operations: string[] = []
  const cancellationToken = { cancel: () => {
    operations.push('cancel')
  } }
  transport.check.mockImplementation(async () => {
    operations.push('metadata')
    if (stage === 'metadata') {
      entered.resolve()
      await finish.promise
    }
    return { updateInfo: { version: update.version }, cancellationToken }
  })
  transport.download.mockImplementation(async () => {
    operations.push('download')
    if (stage === 'download') {
      entered.resolve()
      await finish.promise
    }
  })
  transport.nativeCheck.mockImplementation(() => {
    operations.push('native')
    entered.resolve()
  })
  transport.finish.mockImplementation(() => {
    operations.push('install')
  })
  const pending = f.installer.prepare(f.path, update, f.directory)
  const rejection = expect(pending).rejects.toThrow('UPDATE_INSTALL_TIMEOUT')
  await entered.promise
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  await rejection
  if (stage !== 'metadata')
    expect(operations).toContain('cancel')
  const afterTimeout = [...operations]
  finish.resolve()
  autoUpdater.emit('update-downloaded')
  await Promise.resolve()
  await Promise.resolve()
  expect(operations).toEqual(afterTimeout)
  vi.useRealTimers()
  await expect(fetch(transport.feed)).rejects.toThrow()
})

it('propagates native signature failure without an installation callback', async () => {
  const f = await fixture()
  transport.check.mockResolvedValue({ updateInfo: { version: update.version } })
  transport.download.mockResolvedValue([])
  transport.nativeCheck.mockImplementation(() => {
    autoUpdater.emit('error', new Error('Signature rejected'))
  })
  await expect(f.installer.prepare(f.path, update, f.directory)).rejects.toThrow('Signature rejected')
  await expect(fetch(transport.feed)).rejects.toThrow()
})

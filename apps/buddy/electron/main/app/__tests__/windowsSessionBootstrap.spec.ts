import type { PlatformHostConnection } from '../../runtime/platformHostBootstrap'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { beforeEach, expect, it, vi } from 'vitest'
import { storageBootstrapRoot } from '../../../../platform/storage/StorageLocationStore'
import { openBuddyDatabase } from '../../../../service/src/storage/database'
import { prepareDesktopEnvironment } from '../environment'

const f = vi.hoisted(() => ({ root: '', active: '', legacy: '', session: '', ready: false }))
vi.mock('electron', () => ({ app: {
  commandLine: { hasSwitch: () => false },
  getVersion: () => '0.0.0',
  getAppPath: () => f.root,
  isReady: () => f.ready,
  requestSingleInstanceLock: () => true,
  setName() {},
  once() {},
  setPath(name: string, path: string) {
    if (name === 'sessionData')
      f.session = path
  },
} }))
vi.mock('../desktopIcons', () => ({ desktopIcons: { test: { app: '', tray: '' } } }))
vi.mock('../../../../platform/currentPlatform', () => ({ currentPlatform: { id: 'win32' } }))
vi.mock('../../../../platform/native/nativeHost', async original => ({ ...await original<typeof import('../../../../platform/native/nativeHost')>(), resolveBuddyPrivateDirectories: () => undefined }))
vi.mock('../../../../platform/filesystem/privateDirectories', () => ({ ensurePrivateDirectoriesSync: (paths: string[]) => paths.forEach(path => mkdirSync(path, { recursive: true })) }))
vi.mock('../../../../platform/storage/StorageRootLease', () => ({ acquireStorageRootLease: () => () => {} }))
vi.mock('../desktopRuntimePaths', () => ({ resolveDesktopRuntimePaths: () => ({ lexoraHome: f.root, profile: 'test', userData: join(f.legacy, 'electron'), sessionData: join(f.legacy, 'chromium'), windowState: join(f.legacy, 'state', 'window.json') }) }))

function host(root: string) {
  return { bootstrap: { profileRoot: root, profile: 'test' }, peer: { closed: false } } as PlatformHostConnection
}
beforeEach(async () => {
  const parent = await createTemporaryDirectory('buddy-window-session-')
  f.root = join(parent, 'default')
  f.active = join(parent, 'active')
  f.legacy = join(parent, 'legacy')
  f.session = ''
  f.ready = false
  const bootstrap = storageBootstrapRoot(f.root)
  const identity = { version: 1, layoutVersion: 1, dataId: randomUUID(), generation: randomUUID() }
  await Promise.all([bootstrap, f.root, f.active].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(f.active, 'storage.json'), JSON.stringify(identity))
  await writeFile(join(bootstrap, 'location.json'), JSON.stringify({ version: 1, identity, activeRoot: f.active, pending: null, history: [] }))
})

it('uses the verified active root for Chromium without importing another test or development profile', async () => {
  await mkdir(join(f.active, 'buddy', 'secrets'), { recursive: true })
  await mkdir(join(f.legacy, 'chromium'), { recursive: true })
  await writeFile(join(f.legacy, 'chromium', 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'other' } }))
  await prepareDesktopEnvironment(host(f.active))
  expect(f.session).toBe(join(f.active, 'device', 'chromium'))
  expect(existsSync(join(f.session, 'Local State'))).toBe(false)
  expect(existsSync(join(f.root, 'device'))).toBe(false)
})

it('rejects a host root mismatch without initializing either device directory', async () => {
  await expect(prepareDesktopEnvironment(host(f.root))).rejects.toThrow('PLATFORM_HOST_PROFILE_CHANGED')
  expect(existsSync(join(f.root, 'device'))).toBe(false)
  expect(existsSync(join(f.active, 'device'))).toBe(false)
})

it('keeps a newly discovered database upgrade off the active Chromium session', async () => {
  vi.stubEnv('LEXORA_BUDDY_STORAGE_AUTHORITY', 'sqlite')
  try {
    openBuddyDatabase({ databasePath: join(f.active, 'buddy', 'buddy.sqlite3') }).close()
    const environment = await prepareDesktopEnvironment()
    expect(environment.storage.state.pending?.kind).toBe('upgrade')
    expect(f.session).toBe(join(storageBootstrapRoot(f.root), 'migration-session'))
    expect(existsSync(join(f.active, 'device'))).toBe(false)
  }
  finally { vi.unstubAllEnvs() }
})

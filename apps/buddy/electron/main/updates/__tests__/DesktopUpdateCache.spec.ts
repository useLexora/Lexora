import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { deferred } from '@buddy-tests/deferred'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { DesktopUpdateCache } from '../DesktopUpdateCache'
import { DesktopUpdateDelivery } from '../DesktopUpdateDelivery'
import { DesktopUpdatePolicy } from '../DesktopUpdatePolicy'

const body = Buffer.from('verified update fixture')
const update = { version: '1.2.3', name: 'Lexora-Buddy-1.2.3-windows-x64.exe', url: 'https://github.com/useLexora/Lexora/releases/download/v1.2.3/Lexora-Buddy-1.2.3-windows-x64.exe', sha256: createHash('sha256').update(body).digest('hex'), size: body.length }
const plan = { mode: 'restart' as const, reason: null, update, fallback: null }
const policy = new DesktopUpdatePolicy({ schemaVersion: 1, format: 'nsis', architecture: 'x64', signing: 'none' })

async function fixture() {
  const directory = await createTemporaryDirectory('desktop-update-cache-')
  const cache = new DesktopUpdateCache(directory, policy, '1.0.0')
  const installed: string[] = []
  let online = true
  const options = { directory, cache, get: async () => {
    if (!online)
      throw new Error('offline')
    return new Response(body)
  }, requestInstall: async (prepare: () => Promise<(() => void) | void>) => {
    await prepare()
    return true
  }, launchInstaller: async (path: string) => { installed.push(path) }, openPackage: async () => {}, reportFailure: () => {} }
  return { directory, cache, options, installed, offline: () => {
    online = false
  } }
}

it('restores a verified installer after relaunch and permits installation offline', async () => {
  const f = await fixture()
  const first = new DesktopUpdateDelivery(f.options)
  first.discover(plan)
  await first.download()
  await first.dispose()
  f.offline()
  const second = new DesktopUpdateDelivery(f.options)
  await second.restore(update.version)
  expect(second.state).toMatchObject({ status: 'ready', version: update.version, downloadedBytes: body.length, totalBytes: body.length })
  await second.install()
  expect(f.installed).toEqual([join(f.directory, 'pending', update.name)])
  expect(await readFile(f.installed[0]!)).toEqual(body)
  await second.dispose()
})

it('keeps the verified Linux package for recovery when a failed transaction already changed the app version', async () => {
  const directory = await createTemporaryDirectory('linux-update-recovery-')
  const linuxPolicy = new DesktopUpdatePolicy({ schemaVersion: 1, format: 'deb', architecture: 'x64', signing: 'none' })
  linuxPolicy.linuxInstallation = { available: true, failedVersion: update.version }
  const name = 'Lexora-Buddy-1.2.3-linux-amd64.deb'
  const linuxUpdate = { ...update, name, url: `https://github.com/useLexora/Lexora/releases/download/v1.2.3/${name}` }
  const cache = new DesktopUpdateCache(directory, linuxPolicy, update.version)
  const recovery = { mode: 'manual' as const, reason: 'installer-unavailable' as const, update: linuxUpdate, fallback: null }
  await cache.remember(recovery)
  await mkdir(join(directory, 'pending'))
  await writeFile(join(directory, 'pending', name), body)
  const restored = await cache.readPlan(update.version)
  expect(restored).toMatchObject(recovery)
  await cache.cleanup(restored!)
  expect(await cache.verifiedPath(linuxUpdate)).toBe(join(directory, 'pending', name))
  linuxPolicy.linuxInstallation.failedVersion = null
  expect(await cache.readPlan(update.version)).toBeNull()
})

it('refuses restored installers whose bytes, version, architecture or source no longer match', async () => {
  const f = await fixture()
  const first = new DesktopUpdateDelivery(f.options)
  first.discover(plan)
  await first.download()
  await first.dispose()
  const otherArchitecture = new DesktopUpdateCache(f.directory, new DesktopUpdatePolicy({ schemaVersion: 1, format: 'nsis', architecture: 'arm64', signing: 'none' }), '1.0.0')
  expect(await otherArchitecture.readPlan(update.version)).toBeNull()
  expect(await f.cache.readPlan('1.2.4')).toBeNull()
  expect(await new DesktopUpdateCache(f.directory, policy, update.version).readPlan(update.version)).toBeNull()
  await writeFile(join(f.directory, 'pending', update.name), Buffer.alloc(body.length))
  const restored = new DesktopUpdateDelivery(f.options)
  await restored.restore(update.version)
  expect(restored.state.status).toBe('available')
  await expect(restored.install()).rejects.toThrow('UPDATE_INSTALL_UNAVAILABLE')
  expect(f.installed).toEqual([])
  await restored.dispose()
  const record = JSON.parse(await readFile(join(f.directory, 'download.json'), 'utf8'))
  record.packages[0].url = 'https://example.invalid/installer.exe'
  await writeFile(join(f.directory, 'download.json'), JSON.stringify(record))
  expect(await f.cache.readPlan(update.version)).toBeNull()
})

it('cleans only owned obsolete packages, protects the pending update, and leaves unrelated files and links untouched', async () => {
  const f = await fixture()
  const pending = join(f.directory, 'pending')
  await mkdir(pending)
  const old = join(pending, 'Lexora-Buddy-0.9.0-windows-x64.exe')
  const unrelated = join(pending, 'personal-notes.txt')
  const current = join(pending, update.name)
  await Promise.all([writeFile(old, 'old'), writeFile(unrelated, 'keep'), writeFile(current, body)])
  if (process.platform !== 'win32')
    await symlink(unrelated, join(pending, 'Lexora-Buddy-0.8.0-windows-x64.exe'))
  expect(await f.cache.summary()).toEqual({ files: 2, bytes: 3 + body.length })
  await f.cache.cleanup(plan)
  await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(current)).toEqual(body)
  expect(await readFile(unrelated, 'utf8')).toBe('keep')
  await f.cache.clear()
  expect(await f.cache.summary()).toEqual({ files: 0, bytes: 0 })
  expect(await readFile(unrelated, 'utf8')).toBe('keep')
  if (process.platform !== 'win32')
    expect(await readFile(join(pending, 'Lexora-Buddy-0.8.0-windows-x64.exe'), 'utf8')).toBe('keep')
})

it('clears a ready update without immediately redownloading it and requires a new explicit download', async () => {
  const f = await fixture()
  const delivery = new DesktopUpdateDelivery(f.options)
  delivery.discover(plan)
  await delivery.download()
  await delivery.clearCache()
  delivery.reconcile(true, true)
  expect(delivery.state.status).toBe('available')
  expect(await delivery.cacheSummary()).toEqual({ files: 0, bytes: 0 })
  await expect(delivery.install()).rejects.toThrow('UPDATE_INSTALL_UNAVAILABLE')
  await delivery.download()
  expect(delivery.state.status).toBe('ready')
  await delivery.dispose()
})

it.skipIf(process.platform === 'win32').each(['root', 'pending'])('refuses a redirected cache %s without changing the target files', async (target) => {
  const f = await fixture()
  const delivery = new DesktopUpdateDelivery(f.options)
  delivery.discover(plan)
  await delivery.download()
  await delivery.dispose()
  let cache = f.cache
  let packagePath = join(f.directory, 'pending', update.name)
  if (target === 'root') {
    const link = join(await createTemporaryDirectory('desktop-update-cache-link-'), 'updates')
    await symlink(f.directory, link)
    cache = new DesktopUpdateCache(link, policy, '1.0.0')
  }
  else {
    const redirected = join(f.directory, 'redirected')
    await rename(join(f.directory, 'pending'), redirected)
    await symlink(redirected, join(f.directory, 'pending'))
    packagePath = join(redirected, update.name)
  }
  await expect(cache.verifiedPath(update)).rejects.toThrow('UPDATE_CACHE_INVALID')
  await expect(cache.clear()).rejects.toThrow('UPDATE_CACHE_INVALID')
  expect(await readFile(packagePath)).toEqual(body)
  expect(JSON.parse(await readFile(join(f.directory, 'download.json'), 'utf8')).packages[0].version).toBe(update.version)
})

it('preserves an active partial download while removing abandoned partial files older than one day', async () => {
  const f = await fixture()
  const pending = join(f.directory, 'pending')
  await mkdir(pending)
  const active = join(pending, `${update.name}.download`)
  const abandoned = join(pending, 'Lexora-Buddy-1.3.0-windows-x64.exe.download')
  const recent = join(pending, 'Lexora-Buddy-1.3.1-windows-x64.exe.download')
  await Promise.all([writeFile(active, 'active'), writeFile(abandoned, 'abandoned'), writeFile(recent, 'recent')])
  const yesterday = new Date(Date.now() - 25 * 60 * 60_000)
  await Promise.all([utimes(active, yesterday, yesterday), utimes(abandoned, yesterday, yesterday)])
  await f.cache.cleanup(plan, update.name)
  expect(await readFile(active, 'utf8')).toBe('active')
  expect(await readFile(recent, 'utf8')).toBe('recent')
  await expect(readFile(abandoned)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps the verified installation target protected until its handoff completes, then applies a newer release', async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const proceed = deferred<void>()
  const delivery = new DesktopUpdateDelivery({ ...f.options, requestInstall: async (prepare) => {
    entered.resolve()
    await proceed.promise
    await prepare()
    return true
  } })
  delivery.discover(plan)
  await delivery.download()
  const installation = delivery.install()
  await entered.promise
  const newer = { ...update, version: '1.3.0', name: update.name.replaceAll('1.2.3', '1.3.0'), url: update.url.replaceAll('1.2.3', '1.3.0') }
  delivery.discover({ ...plan, update: newer })
  expect(delivery.state).toMatchObject({ status: 'installing', version: update.version })
  await expect(delivery.clearCache()).rejects.toThrow('UPDATE_CACHE_BUSY')
  expect(await readFile(join(f.directory, 'pending', update.name))).toEqual(body)
  proceed.resolve()
  await installation
  expect(f.installed).toEqual([join(f.directory, 'pending', update.name)])
  await delivery.download()
  expect(delivery.state).toMatchObject({ status: 'ready', version: newer.version })
  expect(await readFile(join(f.directory, 'pending', newer.name))).toEqual(body)
  await expect(readFile(join(f.directory, 'pending', update.name))).rejects.toMatchObject({ code: 'ENOENT' })
  await delivery.dispose()
})

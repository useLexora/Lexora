import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '../fixtures/electron.mjs'

const buddyPackage = fileURLToPath(new URL('../../../apps/buddy/package.json', import.meta.url))
const buddyRequire = createRequire(buddyPackage)
const { build } = createRequire(buddyRequire.resolve('electron-vite'))('esbuild')

test('cached update notifications resolve missing package details on first open and recover from offline checks without reopening', async ({ buddy }, testInfo) => {
  const bundle = testInfo.outputPath('cached-update-runtime.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../fixtures/update-download-runtime.mjs', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', banner: { js: `var require = require('node:module').createRequire(${JSON.stringify(buddyPackage)});` }, logLevel: 'silent' })
  const instance = await buddy.createInstance('cached-update')
  const { app, page, diagnostics } = await instance.launch()
  await app.evaluate(async ({ ipcMain, BrowserWindow, shell }, { bundle, directory }) => {
    const { DesktopUpdateDelivery, DesktopUpdateCache, DesktopUpdatePolicy } = process.getBuiltinModule('node:module').createRequire(bundle)(bundle)
    const { createHash } = process.getBuiltinModule('node:crypto')
    const body = 'verified-deb-package'
    const version = '0.12.0'
    const name = `Lexora-Buddy-${version}-linux-amd64.deb`
    const policy = new DesktopUpdatePolicy({ schemaVersion: 1, format: 'deb', architecture: 'x64', signing: 'none' })
    policy.linuxInstallation = { available: true, failedVersion: null }
    const state = { revision: 100, checking: false, enabled: true, lastCheckedAt: Date.now(), lastSuccessfulCheckAt: Date.now(), checkFailed: false, ignoredVersion: null, reminderDueAt: null, notification: { id: 'desktop.update', revision: version, kind: 'app.update-available', origin: 'desktop', attention: 'unseen', occurredAt: new Date().toISOString(), action: { type: 'open-app-update' }, payload: { version } }, result: { currentVersion: '0.11.2', latestVersion: version, status: 'update_available', releaseUrl: `https://github.com/useLexora/Lexora/releases/tag/v${version}`, releaseNotes: '## 更新内容\n\n- 改进文件与网页引用' } }
    const publish = () => {
      state.revision++
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('lexora:app:updates:changed', state)
    }
    const fixture = globalThis.cachedUpdateFixture = { finish: null, urls: [] }
    shell.openExternal = async url => fixture.urls.push(url)
    const delivery = new DesktopUpdateDelivery({ directory, cache: new DesktopUpdateCache(directory, policy, '0.11.2'), get: async () => new Response(body), requestInstall: async () => false, launchInstaller: async () => {}, openPackage: async () => {}, reportFailure: () => {} })
    await delivery.restore(version)
    state.delivery = delivery.state
    delivery.onDidChange((next) => {
      state.delivery = next
      publish()
    })
    const handlers = {
      'lexora:app:updates:state': () => state,
      'lexora:app:updates:acknowledge': () => state,
      'lexora:app:updates:download': () => delivery.download(),
      'lexora:app:check-for-updates': async () => {
        state.checking = true
        publish()
        try {
          await new Promise((resolve, reject) => {
            fixture.finish = success => success ? resolve() : reject(new Error('offline'))
          })
          delivery.discover(policy.resolveCached([{ version, name, url: `https://github.com/useLexora/Lexora/releases/download/v${version}/${name}`, size: body.length, sha256: createHash('sha256').update(body).digest('hex') }]))
          state.checkFailed = false
          return state.result
        }
        catch (error) {
          state.checkFailed = true
          throw error
        }
        finally {
          fixture.finish = null
          state.checking = false
          publish()
        }
      },
    }
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    publish()
  }, { bundle, directory: path.join(instance.home, 'cache/updates') })
  await page.locator('.desktop-app-sidebar__notification-trigger').click()
  await page.locator('.desktop-notification-item').filter({ hasText: 'Lexora 0.12.0' }).click()
  const dialog = page.locator('.desktop-update-dialog')
  await expect(dialog.getByRole('button', { name: '正在检查…', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '前往下载', exact: true })).toHaveCount(0)
  await app.evaluate(() => globalThis.cachedUpdateFixture.finish(false))
  await expect(dialog.getByRole('button', { name: '手动下载', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '重试检查', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '正在检查…', exact: true })).toBeDisabled()
  await app.evaluate(() => globalThis.cachedUpdateFixture.finish(true))
  await dialog.getByRole('button', { name: '下载更新', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '重启并安装更新', exact: true })).toBeVisible()
  expect(await fs.readFile(path.join(instance.home, 'cache/updates/pending/Lexora-Buddy-0.12.0-linux-amd64.deb'), 'utf8')).toBe('verified-deb-package')
  expect(await app.evaluate(() => globalThis.cachedUpdateFixture.urls)).toEqual([])
  expect(diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
})

test('Linux installation fallback keeps the package and exposes a copyable command in the minimum window', async ({ buddy }, testInfo) => {
  const bundle = testInfo.outputPath('linux-update-runtime.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../fixtures/update-download-runtime.mjs', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', banner: { js: `var require = require('node:module').createRequire(${JSON.stringify(buddyPackage)});` }, logLevel: 'silent' })
  const instance = await buddy.createInstance('linux-update')
  const { app, page, diagnostics } = await instance.launch()
  await app.evaluate(async ({ ipcMain, BrowserWindow }, { bundle, directory }) => {
    const { linuxManualInstallation, DesktopUpdateDelivery } = process.getBuiltinModule('node:module').createRequire(bundle)(bundle)
    const { createHash } = process.getBuiltinModule('node:crypto')
    const body = 'verified-linux-package'
    const manual = linuxManualInstallation({ schemaVersion: 1, format: 'pacman', architecture: 'x64', signing: 'none' }, '0.12.0', `${directory}/pending`)
    const state = { revision: 100, checking: false, enabled: false, lastCheckedAt: Date.now(), lastSuccessfulCheckAt: Date.now(), checkFailed: false, ignoredVersion: null, notification: null, reminderDueAt: null, manualInstallation: manual, result: {
      currentVersion: '0.11.2',
      latestVersion: '0.12.0',
      status: 'update_available',
      releaseUrl: 'https://github.com/useLexora/Lexora/releases/tag/v0.12.0',
      releaseNotes: '## 更新内容\n\n- 更方便地引用文件与网页内容\n- 改进工作区文件管理与图标主题',
    } }
    const publish = () => {
      state.revision++
      BrowserWindow.getAllWindows()[0].webContents.send('lexora:app:updates:changed', state)
    }
    globalThis.linuxUpdateFixture = { manual, publish }
    const delivery = new DesktopUpdateDelivery({
      directory,
      get: async () => new Response(body),
      requestInstall: async (prepare) => {
        await prepare()
        return true
      },
      launchInstaller: async () => { throw new Error('UPDATE_INSTALL_UNAVAILABLE') },
      openPackage: async () => { throw new Error('File association must not be opened') },
      reportFailure: () => {},
    })
    delivery.onDidChange((next) => {
      state.delivery = next
      publish()
    })
    delivery.discover({ mode: 'restart', reason: 'system-package', fallback: null, update: { version: '0.12.0', name: manual.packageName, url: `https://github.com/useLexora/Lexora/releases/download/v0.12.0/${manual.packageName}`, size: body.length, sha256: createHash('sha256').update(body).digest('hex') } })
    await delivery.download()
    const handlers = {
      'lexora:app:check-for-updates': () => state.result,
      'lexora:app:updates:state': () => state,
      'lexora:app:updates:install': () => delivery.install(),
    }
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    BrowserWindow.getAllWindows()[0].setSize(980, 640)
    publish()
  }, { bundle, directory: path.join(instance.home, 'cache/安装包 \'local\'/updates') })
  await page.locator('.desktop-window-menu').getByRole('button', { name: 'Lexora Buddy', exact: true }).click()
  await page.getByRole('menuitem').filter({ hasText: '检查更新…' }).click()
  const update = page.locator('.desktop-update-dialog')
  await update.getByRole('button', { name: '安装更新', exact: true }).click()
  await expect(update.getByRole('button', { name: '查看安装步骤', exact: true })).toBeVisible()
  await update.getByRole('button', { name: '查看安装步骤', exact: true }).click()
  const steps = page.locator('.desktop-update-install-dialog')
  await steps.getByRole('button', { name: '复制命令', exact: true }).click()
  await expect(steps.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  await app.evaluate(() => globalThis.linuxUpdateFixture.publish())
  await expect(steps.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(await app.evaluate(() => globalThis.linuxUpdateFixture.manual.command))
  await expect(steps.getByRole('button', { name: '退出 Lexora', exact: true })).toBeInViewport()
  const bounds = await steps.boundingBox()
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
  expect(await steps.locator('pre').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(update.getByRole('button', { name: '查看安装步骤', exact: true })).toBeVisible()
  expect(diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
})

test('update downloads use real Electron redirects, report repeated failures, allow cancellation and offer manual downloads', async ({ buddy }, testInfo) => {
  const bundle = testInfo.outputPath('update-runtime.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../fixtures/update-download-runtime.mjs', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', banner: { js: `var require = require('node:module').createRequire(${JSON.stringify(buddyPackage)});` }, logLevel: 'silent' })
  const instance = await buddy.createInstance('update-download')
  const { app, page, diagnostics } = await instance.launch()
  try {
    await app.evaluate(async ({ ipcMain, BrowserWindow, shell }, { bundle, directory }) => {
      const { DesktopNetwork, DesktopUpdateDelivery } = process.getBuiltinModule('node:module').createRequire(bundle)(bundle)
      const { Buffer } = process.getBuiltinModule('node:buffer')
      const { createHash } = process.getBuiltinModule('node:crypto')
      const { createServer } = process.getBuiltinModule('node:http')
      const body = Buffer.alloc(512 * 1024, 'verified-update-fixture')
      const version = '0.11.2'
      const url = `https://github.com/useLexora/Lexora/releases/download/v${version}/Lexora-Buddy-${version}-windows-x64.exe`
      const assetUrl = 'https://release-assets.githubusercontent.com/installer'
      BrowserWindow.getAllWindows()[0].setSize(980, 640)
      const fixture = globalThis.updateDownloadFixture = { mode: 'fail', finish: null, finishInstallation: null, urls: [] }
      const sockets = new Set()
      const server = createServer((request, response) => {
        if (request.url === '/download') {
          response.writeHead(fixture.mode === 'fail' ? 503 : 302, { location: assetUrl }).end()
          return
        }
        const bytes = fixture.mode === 'corrupt' ? Buffer.alloc(body.length) : body
        response.writeHead(200, { 'content-length': bytes.length })
        response.write(bytes.subarray(0, body.length / 4))
        fixture.finish = () => response.end(bytes.subarray(body.length / 4))
        response.on('close', () => {
          fixture.finish = null
        })
      })
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const network = new DesktopNetwork()
      await network.start({ mode: 'direct', server: '' })
      const state = { revision: 100, checking: false, enabled: false, lastCheckedAt: Date.now(), lastSuccessfulCheckAt: Date.now(), checkFailed: false, ignoredVersion: null, notification: null, reminderDueAt: null, result: {
        currentVersion: '0.11.1',
        latestVersion: version,
        status: 'update_available',
        releaseUrl: `https://github.com/useLexora/Lexora/releases/tag/v${version}`,
        releaseNotes: `## 更新说明\n\n${'- 应用内下载、完整性校验与手动安装\n'.repeat(12)}`,
      } }
      const publish = () => {
        state.revision++
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send('lexora:app:updates:changed', state)
      }
      const delivery = new DesktopUpdateDelivery({
        directory,
        get: async (target, init) => {
          if (![url, assetUrl].includes(target))
            throw new Error('Unexpected update URL')
          return network.download(`http://127.0.0.1:${server.address().port}/${target === url ? 'download' : 'asset'}`, init)
        },
        requestInstall: () => new Promise((resolve) => { fixture.finishInstallation = resolve }),
        launchInstaller: async () => {},
        openPackage: async () => {},
        reportFailure: () => {},
      })
      delivery.onDidChange((next) => {
        state.delivery = next
        publish()
      })
      delivery.discover({ mode: 'restart', reason: null, update: { version, name: `Lexora-Buddy-${version}-windows-x64.exe`, url, sha256: createHash('sha256').update(body).digest('hex'), size: body.length }, fallback: null })
      const handlers = {
        'lexora:app:check-for-updates': () => state.result,
        'lexora:app:updates:state': () => state,
        'lexora:app:updates:download': () => delivery.download(),
        'lexora:app:updates:cancel-download': () => delivery.cancel(),
        'lexora:app:updates:install': () => delivery.install(),
      }
      for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      shell.openExternal = async (target) => {
        fixture.urls.push(target)
      }
      fixture.delivery = delivery
      fixture.dispose = async () => {
        fixture.finishInstallation?.(false)
        await delivery.dispose()
        await network.stop()
        for (const socket of sockets)
          socket.destroy()
        await new Promise(resolve => server.close(resolve))
      }
      publish()
    }, { bundle, directory: path.join(instance.home, 'cache/updates') })
    await page.locator('.desktop-window-menu').getByRole('button', { name: 'Lexora Buddy', exact: true }).click()
    await page.getByRole('menuitem').filter({ hasText: '检查更新…' }).click()
    const dialog = page.locator('.desktop-update-dialog')
    const deliveryStatus = dialog.locator('.desktop-update-delivery-status')
    await expect(dialog.getByRole('button', { name: '下载更新', exact: true })).toBeVisible()
    await app.evaluate(() => globalThis.updateDownloadFixture.delivery.reconcile(true, true))
    await expect(deliveryStatus.getByRole('alert')).toContainText('前往发布页手动下载安装包')
    await expect(page.locator('.n-message')).toHaveCount(0)
    for (let attempt = 1; attempt <= 2; attempt++) {
      await dialog.getByRole('button', { name: '重新下载', exact: true }).click()
      await expect(deliveryStatus.getByRole('alert')).toContainText('前往发布页手动下载安装包')
      await expect(dialog.getByRole('button', { name: '手动下载', exact: true })).toBeVisible()
      await expect(page.locator('.n-message').filter({ hasText: '更新下载失败' })).toHaveCount(1)
      await expect(page.locator('.n-message').filter({ hasText: '更新下载失败' })).toHaveCount(0)
    }
    const manualDownload = dialog.getByRole('button', { name: '手动下载', exact: true })
    const box = await dialog.boundingBox()
    const viewportHeight = await page.evaluate(() => innerHeight)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight)
    await manualDownload.click()
    expect(await app.evaluate(() => globalThis.updateDownloadFixture.urls)).toEqual(['https://github.com/useLexora/Lexora/releases/tag/v0.11.2'])
    await app.evaluate(() => globalThis.updateDownloadFixture.mode = 'success')
    await dialog.getByRole('button', { name: '重新下载', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '取消下载', exact: true })).toBeEnabled()
    await expect(deliveryStatus).toContainText('128 KB / 512 KB')
    await dialog.getByRole('button', { name: '取消下载', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '下载更新', exact: true })).toBeVisible()
    await expect(deliveryStatus.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.n-message').filter({ hasText: '更新下载失败' })).toHaveCount(0)
    expect(await fs.readdir(path.join(instance.home, 'cache/updates/pending'))).toEqual([])
    await app.evaluate(() => globalThis.updateDownloadFixture.mode = 'corrupt')
    await dialog.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(deliveryStatus).toContainText('128 KB / 512 KB')
    await app.evaluate(() => globalThis.updateDownloadFixture.finish())
    await expect(deliveryStatus.getByRole('alert')).toContainText('未通过完整性校验')
    expect(await fs.readdir(path.join(instance.home, 'cache/updates/pending'))).toEqual([])
    await app.evaluate(() => globalThis.updateDownloadFixture.mode = 'success')
    await dialog.getByRole('button', { name: '重新下载', exact: true }).click()
    await expect(deliveryStatus).toContainText('128 KB / 512 KB')
    await app.evaluate(() => globalThis.updateDownloadFixture.finish())
    await expect(dialog.getByRole('button', { name: '重启并安装更新', exact: true })).toBeVisible()
    expect(await fs.readFile(path.join(instance.home, 'cache/updates/pending/Lexora-Buddy-0.11.2-windows-x64.exe'))).toEqual(Buffer.alloc(512 * 1024, 'verified-update-fixture'))
    await dialog.getByRole('button', { name: '重启并安装更新', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '正在准备更新…', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '稍后', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '跳过此版本', exact: true })).toBeDisabled()
    await app.evaluate(() => globalThis.updateDownloadFixture.finishInstallation(false))
    await expect(dialog.getByRole('button', { name: '重启并安装更新', exact: true })).toBeEnabled()
    expect(diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
  }
  finally {
    await app.evaluate(() => globalThis.updateDownloadFixture?.dispose()).catch(() => {})
  }
})

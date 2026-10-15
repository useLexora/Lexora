import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '../fixtures/electron.mjs'

const buddyPackage = fileURLToPath(new URL('../../../apps/buddy/package.json', import.meta.url))
const buddyRequire = createRequire(buddyPackage)
const { build } = createRequire(buddyRequire.resolve('electron-vite'))('esbuild')

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

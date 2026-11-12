import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

async function captureThemes(page, instance, scenario) {
  for (const appearance of ['light', 'dark']) {
    await page.evaluate(id => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id } }), `lexora.themes.classic-${appearance}`)
    await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', appearance)
    await page.screenshot({
      path: path.join(instance.artifactDirectory, `${scenario}-${appearance}.png`),
      animations: 'disabled',
      mask: [page.locator('.desktop-app-sidebar footer')],
      maskColor: '#808080',
    })
  }
}

async function openSettings(page, label) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.desktop-settings-sidebar').getByRole('link', { name: label, exact: true }).click()
}

test('cloud backup state load failure recovers through retry and change events without enabling backup', async ({ buddy }) => {
  const instance = await buddy.createInstance('cloud-backup-recovery')
  const { page, app, diagnostics } = await instance.launch()
  const before = await page.evaluate(() => window.lexoraDesktop.sync.state())
  expect(before.enabled).toBe(false)
  await app.evaluate(({ ipcMain }) => {
    const channel = 'lexora:sync'
    const original = ipcMain._invokeHandlers.get(channel)
    globalThis.syncReadProbe = { fail: true, gate: null }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, input) => {
      if (input.action === 'state') {
        const probe = globalThis.syncReadProbe
        if (probe.fail)
          throw new Error('SYNC_CONFIGURATION_INVALID')
        await probe.gate?.promise
      }
      return original(event, input)
    })
  })
  await openSettings(page, '数据存储')
  const panel = page.getByRole('region', { name: '云备份', exact: true })
  const retry = panel.getByRole('button', { name: '重试', exact: true })
  const toggle = panel.getByRole('switch', { name: '启用云备份', exact: true })
  const notice = page.locator('.n-message').filter({ hasText: '云备份连接配置无法读取' })
  await expect(retry).toBeVisible()
  await expect(notice).toHaveCount(1)
  await expect(panel).toContainText('云备份状态暂时无法读取，请重试。')
  await panel.scrollIntoViewIfNeeded()
  await captureThemes(page, instance, '01-cloud-backup-failed')
  const originalNotice = await notice.elementHandle()
  await retry.click()
  await expect(retry).toBeVisible()
  await expect(notice).toHaveCount(1)
  expect(await originalNotice.evaluate(element => element.isConnected)).toBe(true)
  await app.evaluate(() => {
    globalThis.syncReadProbe.fail = false
    globalThis.syncReadProbe.gate = Promise.withResolvers()
  })
  await retry.click()
  await expect(toggle).toBeDisabled()
  await expect(page.locator('.n-message')).toHaveCount(1)
  await expect(page.locator('.n-message')).toContainText('正在读取云备份状态')
  await app.evaluate(() => globalThis.syncReadProbe.gate.resolve())
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  await expect(panel).toContainText('未开启')
  await expect(notice).toHaveCount(0)
  expect(await page.evaluate(() => window.lexoraDesktop.sync.state())).toEqual(before)
  await captureThemes(page, instance, '02-cloud-backup-recovered')
  await page.getByRole('link', { name: '常规', exact: true }).click()
  await app.evaluate(() => globalThis.syncReadProbe.fail = true)
  await page.getByRole('link', { name: '数据存储', exact: true }).click()
  await expect(retry).toBeVisible()
  await app.evaluate(({ BrowserWindow }, state) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('lexora:sync:changed', state)
  }, before)
  await expect(retry).toHaveCount(0)
  await expect(notice).toHaveCount(0)
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

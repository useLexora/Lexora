import { expect, test } from '../fixtures/electron.mjs'

test('browser controls block concurrent saves until the current change is committed', async ({ buddy }) => {
  const instance = await buddy.createInstance('settings-controls')
  const desktop = await instance.launch()
  const { page, app } = desktop
  await app.evaluate(({ ipcMain }) => {
    const channel = 'lexora:settings:update'
    const original = ipcMain._invokeHandlers.get(channel)
    globalThis.settingProbe = { gate: null }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, patch) => {
      const probe = globalThis.settingProbe
      await probe.gate?.promise
      return original(event, patch)
    })
  })
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '浏览器', exact: true }).click()
  const freeze = page.getByRole('switch', { name: '暂停后台页面', exact: true })
  const before = await freeze.getAttribute('aria-checked')
  await app.evaluate(() => {
    globalThis.settingProbe.gate = Promise.withResolvers()
  })
  await freeze.click()
  await expect(freeze).toBeDisabled()
  await expect(page.getByRole('switch', { name: '暂停闲置的前台页面', exact: true })).toBeDisabled()
  await app.evaluate(() => {
    globalThis.settingProbe.gate.resolve()
    globalThis.settingProbe.gate = null
  })
  await expect(freeze).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')
  await expect(freeze).toBeEnabled()
  expect(await page.evaluate(async () => (await window.lexoraDesktop.settings.get()).browser.freezeBackground)).toBe(before !== 'true')
})

test('domain permission rows keep long hosts accessible and save changes without affecting other rules', async ({ buddy }) => {
  const instance = await buddy.createInstance('domain-permission-table')
  const { page, diagnostics } = await instance.launch()
  const longHost = `${'long-subdomain-'.repeat(4)}app.another-subdomain.example.com`
  await page.evaluate(async (longHost) => {
    await window.lexoraDesktop.settings.update({
      browser: {
        networkPermissions: {
          defaults: { access: 'ask', download: 'ask', upload: 'ask' },
          rules: [
            { id: 'short', match: 'exact', pattern: 'example.com', access: 'allow', download: 'ask', upload: 'ask' },
            { id: 'long', match: 'exact', pattern: longHost, access: 'allow', download: 'ask', upload: 'ask' },
          ],
        },
      },
    })
  }, longHost)
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '浏览器', exact: true }).click()
  const table = page.getByTestId('network-permissions').getByRole('table')
  const longLabel = table.locator('.n-ellipsis').filter({ hasText: longHost })
  await expect(table.getByRole('row')).toHaveCount(4)
  await longLabel.hover()
  await expect(page.locator('.n-popover').filter({ hasText: longHost })).toBeVisible()
  await page.mouse.move(0, 0)
  const shortRow = table.getByRole('row').filter({ hasText: 'example.com' }).filter({ hasNotText: longHost })
  await shortRow.locator('.n-select').first().click()
  await page.locator('.n-base-select-menu:visible').getByText('始终拒绝', { exact: true }).click()
  const permissions = () => page.evaluate(async () => (await window.lexoraDesktop.settings.get()).browser.networkPermissions)
  await expect.poll(async () => (await permissions()).rules[0].access).toBe('deny')
  await shortRow.getByRole('button', { name: '删除规则', exact: true }).click()
  await expect.poll(permissions).toEqual({
    defaults: { access: 'ask', download: 'ask', upload: 'ask' },
    rules: [{ id: 'long', match: 'exact', pattern: longHost, access: 'allow', download: 'ask', upload: 'ask' }],
  })
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(longLabel).toHaveText(longHost)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('subtask notification settings save independently, survive restart and preserve opt-out across the master switch', async ({ buddy }) => {
  const instance = await buddy.createInstance('subtask-notifications')
  let desktop = await instance.launch()
  const open = async () => {
    await desktop.page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await desktop.page.getByRole('link', { name: '通知', exact: true }).click()
  }
  const toggle = name => desktop.page.getByRole('switch', { name, exact: true })
  const settings = () => desktop.page.evaluate(async () => {
    const { notificationsEnabled, subtaskNotificationsEnabled, notifyWhenFocused } = (await window.lexoraDesktop.settings.get()).desktop
    return { notificationsEnabled, subtaskNotificationsEnabled, notifyWhenFocused }
  })
  await open()
  await expect(toggle('系统通知')).not.toBeChecked()
  await expect(toggle('子任务通知')).toHaveCount(0)
  await toggle('系统通知').click()
  await expect(toggle('子任务通知')).toBeChecked()
  await toggle('子任务通知').click()
  await expect(toggle('子任务通知')).not.toBeChecked()
  await expect.poll(settings).toEqual({ notificationsEnabled: true, subtaskNotificationsEnabled: false, notifyWhenFocused: false })
  await toggle('系统通知').click()
  await expect(toggle('子任务通知')).toHaveCount(0)
  await toggle('系统通知').click()
  await expect(toggle('子任务通知')).not.toBeChecked()
  await instance.stop()
  desktop = await instance.launch()
  await open()
  await expect(toggle('子任务通知')).not.toBeChecked()
  await expect.poll(settings).toEqual({ notificationsEnabled: true, subtaskNotificationsEnabled: false, notifyWhenFocused: false })
  await desktop.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('lexora:settings:update')
    ipcMain.handle('lexora:settings:update', () => {
      throw new Error('Isolated notification settings failure')
    })
  })
  await toggle('子任务通知').click()
  await expect(desktop.page.getByText('保存失败，已恢复原设置', { exact: true })).toBeVisible()
  await expect(toggle('子任务通知')).not.toBeChecked()
  await expect(toggle('子任务通知')).toBeEnabled()
  expect(await settings()).toEqual({ notificationsEnabled: true, subtaskNotificationsEnabled: false, notifyWhenFocused: false })
})

test('download proxies retain edits, order and deletions across the master switch and restart', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('download-proxies')
  let desktop = await instance.launch()
  const open = async () => {
    await desktop.page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await desktop.page.getByRole('link', { name: '网络代理', exact: true }).click()
  }
  const panel = () => desktop.page.getByTestId('download-proxy-settings')
  const rows = () => panel().getByTestId('download-proxy-row')
  const action = async (row, name) => {
    await row.getByTestId('download-proxy-actions').click()
    await desktop.page.getByRole('menuitem', { name, exact: true }).click()
  }
  const settings = () => desktop.page.evaluate(async () => (await window.lexoraDesktop.settings.get()).downloads)
  const master = () => panel().getByRole('switch', { name: '启用下载代理', exact: true })
  await open()
  await expect(rows()).toHaveCount(3)
  await expect(master()).toBeChecked()
  await rows().filter({ hasText: 'gh-proxy.com' }).getByRole('button', { name: '编辑', exact: true }).click()
  let dialog = desktop.page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill('自定义下载源')
  await dialog.getByLabel('代理地址', { exact: true }).fill('https://mirror.example/cache')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await action(rows().filter({ hasText: '自定义下载源' }), '上移')
  await expect(rows().first()).toContainText('自定义下载源')
  await rows().first().getByRole('switch').click()
  await expect(rows().first().getByRole('switch')).not.toBeChecked()
  await action(rows().filter({ hasText: 'gh.monlor.com' }), '删除')
  await expect(rows()).toHaveCount(2)
  const saved = await settings()
  expect(saved.proxies.map(proxy => proxy.id)).toEqual(['gh-proxy.com', 'ghfast.top'])
  expect(saved.proxies[0]).toMatchObject({ name: '自定义下载源', url: 'https://mirror.example/cache/', enabled: false })
  await master().click()
  await expect(master()).not.toBeChecked()
  expect(await settings()).toEqual({ ...saved, enabled: false })
  await master().click()
  await expect(master()).toBeChecked()
  expect(await settings()).toEqual(saved)
  await testInfo.attach('download-proxy-settings', { body: await panel().screenshot(), contentType: 'image/png' })
  await instance.stop()
  desktop = await instance.launch()
  await open()
  expect(await settings()).toEqual(saved)
  await expect(rows()).toHaveCount(2)

  await desktop.app.evaluate(({ ipcMain }) => {
    const channel = 'lexora:settings:update'
    const original = ipcMain._invokeHandlers.get(channel)
    let fail = true
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, patch) => {
      if (patch.downloads && fail) {
        fail = false
        throw new Error('Isolated download settings failure')
      }
      return original(event, patch)
    })
  })
  await panel().getByRole('button', { name: '添加代理', exact: true }).click()
  dialog = desktop.page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill('新增代理')
  await dialog.getByLabel('代理地址', { exact: true }).fill('not a URL')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByLabel('代理地址', { exact: true }).fill('https://another.example/')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(desktop.page.getByText('保存失败，已恢复原设置', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('新增代理')
  expect(await settings()).toEqual(saved)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(rows()).toHaveCount(3)
  for (let remaining = 3; remaining > 0; remaining--) {
    await action(rows().first(), '删除')
    await expect(rows()).toHaveCount(remaining - 1)
  }
  await instance.stop()
  desktop = await instance.launch()
  await open()
  await expect(rows()).toHaveCount(0)
  expect(await settings()).toEqual({ enabled: true, proxies: [] })
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

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
  await page.evaluate(() => window.location.hash = '/settings/browser')
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

test('subtask notification settings save independently, survive restart and preserve opt-out across the master switch', async ({ buddy }) => {
  const instance = await buddy.createInstance('subtask-notifications')
  let desktop = await instance.launch()
  const open = () => desktop.page.evaluate(() => window.location.hash = '/settings/notifications')
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

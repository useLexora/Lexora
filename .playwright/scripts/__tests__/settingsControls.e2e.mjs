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
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

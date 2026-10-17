import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

const archive = { schemaVersion: 1, label: 'Isolated theme', appearance: 'dark', document: { schemaVersion: 1, colors: { accent: '#96304d' } } }

test('theme selector follows system appearance, toggles from its label and persists its choice', async ({ buddy }) => {
  const instance = await buddy.createInstance('theme-selector')
  let { app, page, diagnostics } = await instance.launch()
  const selectTheme = id => page.evaluate(id => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id } }), id)
  await selectTheme('system')
  const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  await app.evaluate(({ nativeTheme }, dark) => {
    globalThis.systemThemeDescriptor = Object.getOwnPropertyDescriptor(nativeTheme, 'shouldUseDarkColors')
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { configurable: true, get: () => !dark })
    nativeTheme.emit('updated')
  }, systemDark)
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', systemDark ? 'light' : 'dark')
  await selectTheme(`lexora.themes.classic-${systemDark ? 'dark' : 'light'}`)
  await app.evaluate(({ nativeTheme }) => {
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', globalThis.systemThemeDescriptor)
    delete globalThis.systemThemeDescriptor
    nativeTheme.emit('updated')
  })
  await selectTheme('system')
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', systemDark ? 'dark' : 'light')
  expect(await app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))).toEqual({ source: 'system', dark: systemDark })
  await page.evaluate(() => window.location.hash = '/settings/appearance')
  const select = () => page.getByTestId('desktop-theme-select')
  const label = () => select().locator('.n-base-selection-label')
  await expect(select().locator('input')).toHaveCount(0)
  await label().click()
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(1)
  await label().click()
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await label().click()
  await select().press('Escape')
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await label().click()
  // Pick a visible catalog entry without relying on search or virtualized offscreen options.
  await page.locator('.n-base-select-option').nth(1).click()
  const selectedTheme = () => page.evaluate(async () => (await window.lexoraDesktop.themes.request({ action: 'active' })).preference.id)
  await expect.poll(selectedTheme).not.toBe('system')
  const selectedId = await selectedTheme()
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme-id', selectedId)
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'selected-theme.png'), animations: 'disabled' })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await instance.stop()
  ;({ page, diagnostics } = await instance.launch())
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme-id', selectedId)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

for (const [directory, filename, content, code] of [
  ['extensions', 'installed.json', '{"version":1,"installed":', 'EXTENSION_REGISTRY_UNREADABLE'],
  ['themes', 'user-themes.json', '{"version":1,"themes":', 'EXTENSION_THEME_STORE_UNREADABLE'],
]) {
  test(`workbench starts and preserves damaged ${directory} data`, async ({ buddy }) => {
    const instance = await buddy.createInstance(`damaged-${directory}`)
    const file = path.join(instance.home, 'buddy', directory, filename)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
    const { page, diagnostics } = await instance.launch()
    await expect(page.locator('.desktop-chat-composer__prosemirror')).toBeVisible()
    await page.locator('.desktop-chat-composer__prosemirror').fill('Isolated draft remains editable.')
    await expect(page.locator('.desktop-chat-composer__prosemirror')).toHaveText('Isolated draft remains editable.')
    const snapshot = await page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'active' }))
    expect(snapshot.active.descriptor.appearance).toBe('light')
    const error = await page.evaluate(async ({ directory, archive }) => {
      try {
        if (directory === 'extensions')
          await window.lexoraDesktop.extensions.list()
        else
          await window.lexoraDesktop.themes.request({ action: 'save', archive })
        return null
      }
      catch (error) { return error.message }
    }, { directory, archive })
    expect(error).toContain(code)
    await expect.poll(() => page.evaluate(async code => (await window.lexoraDesktop.app.logs.query({ level: 'warn', search: code })).records.some(record => record.errorCode === code), code)).toBe(true)
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
    await instance.stop()
    expect(await fs.readFile(file, 'utf8')).toBe(content)
  })
}

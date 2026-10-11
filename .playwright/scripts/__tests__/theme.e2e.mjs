import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

const archive = { schemaVersion: 1, label: 'Isolated theme', appearance: 'dark', document: { schemaVersion: 1, colors: { accent: '#96304d' } } }

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

test('system appearance resynchronizes without a native update and preview commits publish once and survive restart', async ({ buddy }) => {
  const instance = await buddy.createInstance('theme-lifecycle')
  let { app, page, diagnostics } = await instance.launch()
  const select = id => page.evaluate(id => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id } }), id)
  await select('system')
  const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  await app.evaluate(({ nativeTheme }, dark) => {
    globalThis.systemThemeDescriptor = Object.getOwnPropertyDescriptor(nativeTheme, 'shouldUseDarkColors')
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { configurable: true, get: () => !dark })
    nativeTheme.emit('updated')
  }, systemDark)
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', systemDark ? 'light' : 'dark')
  await select(`lexora.themes.classic-${systemDark ? 'dark' : 'light'}`)
  await app.evaluate(({ nativeTheme }) => {
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', globalThis.systemThemeDescriptor)
    delete globalThis.systemThemeDescriptor
    nativeTheme.emit('updated')
  })
  await page.evaluate(() => {
    window.themeChanges = []
    window.lexoraDesktop.themes.onDidChange(snapshot => window.themeChanges.push(snapshot))
  })
  const restored = await select('system')
  expect(restored.active.descriptor.appearance).toBe(systemDark ? 'dark' : 'light')
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', systemDark ? 'dark' : 'light')
  await expect.poll(() => page.evaluate(() => window.themeChanges.length)).toBe(1)
  expect(await app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))).toEqual({ source: 'system', dark: systemDark })

  const lease = await page.evaluate(archive => window.lexoraDesktop.themes.request({ action: 'beginPreview', archive }), archive)
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme-id', 'user.preview')
  await page.evaluate(() => window.themeChanges = [])
  const saved = await page.evaluate(lease => window.lexoraDesktop.themes.request({ action: 'commitPreview', ...lease }), lease)
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme-id', saved.id)
  await expect.poll(() => page.evaluate(() => window.themeChanges.length)).toBe(1)
  expect(await page.evaluate(() => window.themeChanges[0])).toMatchObject({ preview: false, preference: { id: saved.id }, active: { descriptor: { id: saved.id } } })
  await page.evaluate(() => window.location.hash = '/settings/appearance')
  await expect(page.locator('.desktop-appearance-settings')).toContainText('Isolated theme')
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'saved-theme.png'), animations: 'disabled' })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await instance.stop()
  ;({ app, page, diagnostics } = await instance.launch())
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme-id', saved.id)
  expect((await page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'active' }))).preview).toBe(false)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

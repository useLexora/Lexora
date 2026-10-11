import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

test('typography follows the system by default and preserves independent font choices through theme changes, restart and failed saves', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('typography')
  let desktop = await instance.launch()
  const info = await desktop.page.evaluate(() => window.lexoraDesktop.app.getInfo())
  const bodyFont = info.platform === 'win32' ? 'SimSun' : 'Noto Serif CJK SC'
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setContentSize(1440, 1000))
  await seedReading(desktop, instance.home)
  await desktop.page.reload()
  await openTask(desktop.page, true)
  const paragraph = () => desktop.page.locator('[data-message-id="typography-answer"] .buddy-chat-markdown p').first()
  await expect(paragraph()).toHaveCSS('font-size', '14px')
  await expect(paragraph()).toHaveCSS('line-height', '24px')
  expect(await paragraph().evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^system-ui,/)
  const defaultEvidence = await fontEvidence(desktop.page, paragraph())
  await desktop.page.screenshot({ path: testInfo.outputPath('system-reading.png'), animations: 'disabled' })
  await desktop.page.evaluate(() => {
    const query = window.queryLocalFonts.bind(window)
    window.typographyFontQueries = 0
    window.queryLocalFonts = async () => {
      window.typographyFontQueries++
      if (window.typographyFontQueries === 1)
        throw new Error('Isolated font enumeration failure')
      const result = await query()
      window.typographyInstalledFonts = [...new Set(result.map(font => font.family))].sort((left, right) => left.localeCompare(right))
      return result
    }
  })
  await openAppearance(desktop.page)
  expect(await desktop.page.evaluate(() => window.typographyFontQueries)).toBe(0)
  await expect(desktop.page.getByTestId('typography-uiFont')).toContainText('系统字体')
  await desktop.page.getByTestId('typography-uiFont').locator('.n-select').click()
  await expect(desktop.page.getByText('无法读取本机字体，请重新打开下拉框重试', { exact: true })).toBeVisible()
  await desktop.page.keyboard.press('Escape')
  await desktop.page.getByTestId('typography-uiFont').locator('.n-select').click()
  await expect.poll(() => desktop.page.evaluate(() => window.typographyInstalledFonts?.length ?? 0)).toBeGreaterThan(0)
  const installedFonts = await desktop.page.evaluate(() => window.typographyInstalledFonts)
  const codeFont = installedFonts.find(font => /^(?:Consolas|Adwaita Mono)$/.test(font)) ?? installedFonts.find(font => /mono/i.test(font))
  expect(installedFonts).toContain(bodyFont)
  expect(installedFonts).toContain(codeFont)
  await expect(desktop.page.locator('.n-base-select-option').first()).toContainText('系统字体')
  await expect(desktop.page.getByText('无法读取本机字体，请重新打开下拉框重试', { exact: true })).not.toBeVisible()
  await desktop.page.screenshot({ path: testInfo.outputPath('installed-fonts.png'), animations: 'disabled' })
  await desktop.page.keyboard.press('Escape')
  await desktop.page.screenshot({ path: testInfo.outputPath('system-settings.png'), animations: 'disabled' })

  await select(desktop.page, 'bodyFont', bodyFont)
  await select(desktop.page, 'bodySize', '15 px')
  await select(desktop.page, 'codeFont', codeFont)
  const uiSelect = desktop.page.getByTestId('typography-uiFont')
  await uiSelect.locator('.n-select').click()
  await uiSelect.locator('input').fill('Arial')
  expect((await settings(desktop.page)).uiFont).toBe('')
  await uiSelect.locator('input').press('Enter')
  await expect.poll(() => settings(desktop.page)).toEqual({ uiFont: 'Arial', bodyFont, codeFont, bodySize: 15 })
  await expect(desktop.page.getByTestId('typography-preview').locator('p')).toHaveCSS('font-size', '15px')
  await expect(desktop.page.getByTestId('typography-preview').locator('p')).toHaveCSS('line-height', '26px')
  expect(await desktop.page.evaluate(() => window.typographyFontQueries)).toBe(2)
  await desktop.page.screenshot({ path: testInfo.outputPath('custom-settings.png'), animations: 'disabled' })

  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: { id: 'lexora.themes.classic-dark' } } }))
  await expect(desktop.page.locator('html')).toHaveAttribute('data-buddy-theme', 'dark')
  expect(await desktop.page.locator('html').evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^Arial,/)
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: { id: 'lexora.themes.classic-light' } } }))
  await openTask(desktop.page)
  await expect(paragraph()).toHaveCSS('font-size', '15px')
  expect(await paragraph().evaluate(element => getComputedStyle(element).fontFamily)).toContain(bodyFont)
  const customEvidence = await fontEvidence(desktop.page, paragraph())
  expect(customEvidence.fonts.some(font => font.familyName === bodyFont)).toBe(true)
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { typography: { bodySize: 20 } } }))
  await expect(paragraph()).toHaveCSS('font-size', '20px')
  const heading = desktop.page.locator('[data-message-id="typography-answer"] .buddy-chat-markdown h2')
  expect(await heading.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(20)
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { typography: { bodySize: 15 } } }))
  await expect(paragraph()).toHaveCSS('font-size', '15px')
  const composer = desktop.page.locator('.desktop-chat-composer__prosemirror:visible')
  await expect(composer).toHaveCSS('font-size', '15px')
  expect(await composer.evaluate(element => getComputedStyle(element).fontFamily)).toContain(bodyFont)
  await desktop.page.screenshot({ path: testInfo.outputPath('custom-reading.png'), animations: 'disabled' })
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])

  await instance.stop()
  desktop = await instance.launch()
  await openAppearance(desktop.page)
  expect(await settings(desktop.page)).toEqual({ uiFont: 'Arial', bodyFont, codeFont, bodySize: 15 })
  await expect(desktop.page.getByTestId('typography-preview').locator('p')).toHaveCSS('font-size', '15px')
  await desktop.app.evaluate(({ ipcMain }) => {
    const channel = 'lexora:settings:update'
    globalThis.typographySettingsHandler = ipcMain._invokeHandlers.get(channel)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => {
      throw new Error('Isolated typography save failure')
    })
  })
  await clear(desktop.page, 'bodyFont')
  await expect(desktop.page.getByText('保存失败，已恢复原设置', { exact: true })).toBeVisible()
  await expect(desktop.page.getByTestId('typography-bodySize')).toContainText('15 px')
  await expect(desktop.page.getByTestId('typography-preview').locator('p')).toHaveCSS('font-size', '15px')
  await expect(desktop.page.getByTestId('typography-bodyFont')).toContainText(bodyFont)
  expect((await settings(desktop.page)).bodyFont).toBe(bodyFont)
  expect(await desktop.page.getByTestId('typography-preview').locator('p').evaluate(element => getComputedStyle(element).fontFamily)).toContain(bodyFont)
  await desktop.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('lexora:settings:update')
    ipcMain.handle('lexora:settings:update', globalThis.typographySettingsHandler)
    delete globalThis.typographySettingsHandler
  })
  const beforeReset = await desktop.page.evaluate(() => window.lexoraDesktop.settings.get())
  const expected = { ...beforeReset.desktop.typography }
  for (const [field, value, label] of [['uiFont', '', '系统字体'], ['bodyFont', '', '系统字体'], ['codeFont', '', '系统等宽字体'], ['bodySize', 14, '14 px']]) {
    await clear(desktop.page, field)
    expected[field] = value
    await expect.poll(() => settings(desktop.page)).toEqual(expected)
    const control = desktop.page.getByTestId(`typography-${field}`)
    await expect(control).toContainText(label)
    await expect(control.locator('[data-clear]')).toHaveCount(0)
  }
  await expect(desktop.page.getByTestId('typography-preview').locator('p')).toHaveCSS('font-family', defaultEvidence.computed.family)
  await expect(desktop.page.getByTestId('typography-preview').locator('p')).toHaveCSS('font-size', '14px')
  await expect.poll(() => settings(desktop.page)).toEqual({ uiFont: '', bodyFont: '', codeFont: '', bodySize: 14 })
  const afterReset = await desktop.page.evaluate(() => window.lexoraDesktop.settings.get())
  expect(afterReset).toEqual({ ...beforeReset, desktop: { ...beforeReset.desktop, typography: { uiFont: '', bodyFont: '', codeFont: '', bodySize: 14 } } })
  await instance.stop()
  desktop = await instance.launch()
  await openAppearance(desktop.page)
  expect(await settings(desktop.page)).toEqual({ uiFont: '', bodyFont: '', codeFont: '', bodySize: 14 })
  await expect(desktop.page.getByTestId('typography-preview').locator('p')).toHaveCSS('font-size', '14px')
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await fs.writeFile(testInfo.outputPath('fonts.json'), JSON.stringify({ platform: info.platform, electron: info.electronVersion, chromium: info.chromiumVersion, installedFonts, defaults: defaultEvidence, custom: customEvidence }, null, 2))
})

async function settings(page) {
  return page.evaluate(async () => (await window.lexoraDesktop.settings.get()).desktop.typography)
}

async function openAppearance(page) {
  await page.evaluate(() => window.location.hash = '/settings/appearance')
  await expect(page.getByTestId('typography-settings')).toBeVisible()
}

async function clear(page, field) {
  const control = page.getByTestId(`typography-${field}`)
  await control.locator('.n-select').hover()
  await control.locator('[data-clear]').click()
}

async function select(page, field, label) {
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  const control = page.getByTestId(`typography-${field}`)
  await control.locator('.n-select').click()
  if (field !== 'bodySize')
    await control.locator('input').fill(label)
  await page.locator('.n-base-select-menu:visible').getByText(label, { exact: true }).click()
}

async function openTask(page, dismissProvider = false) {
  await page.evaluate(() => window.location.hash = '/tasks')
  await page.locator('[data-task-id="typography-task"] .desktop-task-sidebar__task').click()
  const dismiss = page.getByRole('button', { name: '忽略本次', exact: true })
  if (dismissProvider || await dismiss.isVisible())
    await dismiss.click()
  await expect(page.locator('[data-message-id="typography-answer"] .buddy-chat-markdown')).toBeVisible()
}

async function fontEvidence(page, paragraph) {
  await page.evaluate(() => document.fonts.ready)
  const computed = await paragraph.evaluate((element) => {
    const style = getComputedStyle(element)
    return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight, dpr: devicePixelRatio }
  })
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-message-id="typography-answer"] .buddy-chat-markdown p' })
    return { computed, ...(await cdp.send('CSS.getPlatformFontsForNode', { nodeId })) }
  }
  finally { await cdp.detach() }
}

async function seedReading({ app, page }, home) {
  await page.evaluate(() => window.lexoraDesktop.localChat.conversations.list(1))
  const text = '让文字安静地承载内容。Typography should feel effortless. 0123456789\n\n## 阅读与思考\n\n字体不需要抢走注意力。清晰的层级、适度的留白，以及稳定的中英文节奏，能让长时间阅读更轻松。\n\n系统字体优先，意味着在不同桌面上保留熟悉的阅读体验。用户也可以为正文选择自己喜欢的字体，而让菜单和按钮保持原来的密度。\n\n- 正文保持自然的大小与行距。\n- 界面文字保持紧凑、清晰。\n- 代码使用独立的等宽字体。\n\n```typescript\nconst message = "Hello, Lexora"\nconsole.log(message)\n```'
  await app.evaluate((_electron, { databasePath, text }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const now = new Date().toISOString()
      db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('typography-task', '字体与阅读体验', 'typography-branch', now, now)
      db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('typography-branch', 'typography-task', now)
      const insert = db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      insert.run('typography-question', 'typography-task', 'typography-branch', 'user', JSON.stringify({ text: '怎样让桌面上的长文阅读更舒适？' }), now)
      insert.run('typography-answer', 'typography-task', 'typography-branch', 'assistant', JSON.stringify({ text }), new Date(Date.parse(now) + 1000).toISOString())
    }
    finally { db.close() }
  }, { databasePath: path.join(home, 'buddy/buddy.sqlite3'), text })
}

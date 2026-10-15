import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

const version = '999.1.0'
const result = {
  currentVersion: '0.0.0',
  latestVersion: version,
  status: 'update_available',
  releaseUrl: `https://github.com/useLexora/Lexora/releases/tag/v${version}`,
  releaseNotes: '## 中文\n\n### 改进\n- **改善任务恢复**\n- 修复文件操作\n- 优化资源使用\n- 完整展示第四条更新\n\n[变更详情](https://github.com/useLexora/Lexora/pull/301)\n\n![external](https://example.invalid/image.png)\n\n<script>window.releaseNotesExecuted = true</script>\n\n## English\n\n### Improvements\n- **Restore tasks safely**\n- Fix file operations\n- Reduce resource usage\n- Show the fourth release note',
}

async function seedUpdate(instance, enabled = true) {
  await fs.mkdir(path.join(instance.home, 'buddy'), { recursive: true })
  await fs.writeFile(path.join(instance.home, 'buddy/updates.json'), JSON.stringify({
    version: 1,
    lastCheckedAt: Date.now(),
    lastNotifiedAt: null,
    notifiedVersion: null,
    ignoredVersion: null,
    seenVersion: null,
    discoveredAt: Date.now(),
    result,
  }))
  if (!enabled) {
    const config = path.join(instance.home, 'config.toml')
    await fs.writeFile(config, (await fs.readFile(config, 'utf8')).replace('[desktop]\n', '[desktop]\nupdate_notifications_enabled = false\n'))
  }
}

async function about(page) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.desktop-settings-sidebar').getByRole('link', { name: '关于', exact: true }).click()
}

async function checkFromApplicationMenu(page) {
  await page.locator('.desktop-window-menu').getByRole('button', { name: 'Lexora Buddy', exact: true }).click()
  await page.getByRole('menuitem').filter({ hasText: '检查更新…' }).click()
}

function toggle(page) {
  return page.getByRole('switch', { name: '自动检查更新', exact: true })
}

async function focus(app) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('lexora-app:'))
    window.show()
    window.focus()
  })
}

async function decisions(instance) {
  return JSON.parse(await fs.readFile(path.join(instance.home, 'buddy/updates.json'), 'utf8'))
}

async function exposeAutomaticCheckSettings(desktop) {
  const info = await desktop.page.evaluate(() => window.lexoraDesktop.app.getInfo())
  await desktop.app.evaluate(({ ipcMain }, info) => {
    ipcMain.removeHandler('lexora:app:get-info')
    ipcMain.handle('lexora:app:get-info', () => ({ ...info, updateCapabilities: { ...info.updateCapabilities, automaticCheck: true } }))
  }, info)
  await desktop.page.reload()
  await desktop.page.waitForFunction(async () => (await window.lexoraDesktop.app.startup.getState()).status === 'ready')
}

async function exposeDownloadSettings(desktop, directory) {
  const info = await desktop.page.evaluate(() => window.lexoraDesktop.app.getInfo())
  const state = await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())
  await desktop.app.evaluate(({ ipcMain, BrowserWindow }, { info, state, directory }) => {
    ipcMain.removeHandler('lexora:app:get-info')
    ipcMain.handle('lexora:app:get-info', () => ({ ...info, updateCapabilities: { automaticCheck: true, download: true, install: false } }))
    globalThis.updateSettingsFixture = { ...state, downloadDirectory: directory }
    ipcMain.removeHandler('lexora:app:updates:state')
    ipcMain.handle('lexora:app:updates:state', () => globalThis.updateSettingsFixture)
    for (const window of BrowserWindow.getAllWindows()) {
      const send = window.webContents.send.bind(window.webContents)
      window.webContents.send = (channel, ...args) => {
        if (channel === 'lexora:app:updates:changed') {
          args[0] = { ...args[0], downloadDirectory: directory }
          globalThis.updateSettingsFixture = args[0]
        }
        send(channel, ...args)
      }
    }
  }, { info, state, directory })
  await desktop.page.reload()
  await desktop.page.waitForFunction(async () => (await window.lexoraDesktop.app.startup.getState()).status === 'ready')
}

test('updates stay discoverable after dismissal, persist and restore skips, and keep manual checks available after opting out', async ({ buddy }) => {
  const instance = await buddy.createInstance('updates')
  await seedUpdate(instance)
  let desktop = await instance.launch()
  await focus(desktop.app)
  const reminder = () => desktop.page.getByTestId('update-reminder')
  await expect(reminder()).toBeVisible()
  await expect.poll(() => decisions(instance)).toMatchObject({ notifiedVersion: version, seenVersion: null })
  for (const theme of ['light', 'dark']) {
    await desktop.page.evaluate(id => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id } }), `lexora.themes.classic-${theme}`)
    await expect(desktop.page.locator('html')).toHaveAttribute('data-buddy-theme', theme)
    await expect(reminder().locator('.n-alert')).toHaveCSS('background-color', /^rgb\(\d+, \d+, \d+\)$/)
  }
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 640))
  await expect(reminder().getByRole('button', { name: '查看更新', exact: true })).toBeInViewport()
  await reminder().locator('.n-alert__close').click()
  await expect(reminder()).toHaveCount(0)
  await desktop.page.locator('.desktop-app-sidebar__notification-trigger').click()
  await desktop.page.locator('.desktop-notification-item').filter({ hasText: `Lexora ${version}` }).click()
  const dialog = () => desktop.page.locator('.desktop-update-dialog')
  await expect(dialog()).toBeVisible()
  await expect(dialog()).toContainText('完整展示第四条更新')
  await expect(dialog()).toContainText('Show the fourth release note')
  await expect(dialog().locator('img')).toHaveCount(0)
  expect(await desktop.page.evaluate(() => window.releaseNotesExecuted)).toBeUndefined()
  await expect.poll(() => decisions(instance)).toMatchObject({ seenVersion: version })
  await desktop.app.evaluate(({ shell }) => {
    globalThis.updateOpenedUrls = []
    shell.openExternal = async (url) => {
      globalThis.updateOpenedUrls.push(url)
    }
  })
  await dialog().getByRole('link').filter({ hasText: '变更详情' }).click()
  await expect.poll(() => desktop.app.evaluate(() => globalThis.updateOpenedUrls)).toEqual(['https://github.com/useLexora/Lexora/pull/301'])
  await dialog().getByRole('button', { name: '前往下载', exact: true }).click()
  await expect.poll(() => desktop.app.evaluate(() => globalThis.updateOpenedUrls)).toEqual(['https://github.com/useLexora/Lexora/pull/301', result.releaseUrl])
  await dialog().getByRole('button', { name: '稍后', exact: true }).click()
  await desktop.page.getByRole('menuitem', { name: '暂时关闭', exact: true }).click()
  expect((await decisions(instance)).ignoredVersion).toBeNull()
  await about(desktop.page)
  await desktop.page.locator('.desktop-about-settings').getByRole('button', { name: '查看更新', exact: true }).click()
  await dialog().getByRole('button', { name: '跳过此版本', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  await expect.poll(() => decisions(instance)).toMatchObject({ ignoredVersion: version })
  await instance.stop()
  desktop = await instance.launch()
  expect((await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())).notification).toBeNull()
  await expect(reminder()).toHaveCount(0)
  await about(desktop.page)
  const settings = () => desktop.page.locator('.desktop-update-settings')
  await expect(settings()).toContainText(`已跳过 v${version}`)
  await expect(settings().getByTestId('update-check-status')).toContainText('已检查')
  await settings().getByRole('button', { name: '恢复此版本提醒', exact: true }).click()
  await expect.poll(() => decisions(instance)).toMatchObject({ ignoredVersion: null })
  expect((await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())).notification?.attention).toBe('unseen')
  await expect(settings()).not.toContainText(`已跳过 v${version}`)
  await desktop.page.locator('.desktop-about-settings').getByRole('button', { name: '查看更新', exact: true }).click()
  await dialog().getByRole('button', { name: '跳过此版本', exact: true }).click()
  await exposeAutomaticCheckSettings(desktop)
  await about(desktop.page)
  await expect(toggle(desktop.page)).toBeChecked()
  await toggle(desktop.page).click()
  await expect(toggle(desktop.page)).not.toBeChecked()
  await instance.stop()
  desktop = await instance.launch()
  await about(desktop.page)
  await expect(toggle(desktop.page)).not.toBeChecked()
  expect((await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())).enabled).toBe(false)
  await desktop.app.evaluate(({ ipcMain, app }, result) => {
    ipcMain.removeHandler('lexora:app:check-for-updates')
    ipcMain.handle('lexora:app:check-for-updates', () => ({ ...result, currentVersion: app.getVersion() }))
  }, result)
  await desktop.page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
  await checkFromApplicationMenu(desktop.page)
  await expect(dialog()).toContainText(version)
  await expect(reminder()).toHaveCount(0)
  await expect(dialog()).toContainText('已跳过')
  await expect(dialog().getByRole('button', { name: '恢复此版本提醒', exact: true })).toBeVisible()
  await dialog().getByRole('button', { name: '稍后', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  expect(desktop.diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
})

test('update settings persist independent preferences, confirm cache clearing and redact failures', async ({ buddy }) => {
  const instance = await buddy.createInstance('update-settings')
  await seedUpdate(instance, false)
  const directory = path.join(instance.home, 'cache', 'updates', 'pending')
  let desktop = await instance.launch()
  await exposeDownloadSettings(desktop, directory)
  await about(desktop.page)
  const settings = () => desktop.page.locator('.desktop-update-settings')
  const download = () => settings().getByRole('switch', { name: '自动下载更新', exact: true })
  await expect(toggle(desktop.page)).not.toBeChecked()
  await expect(download()).toBeChecked()
  await download().click()
  await expect(download()).not.toBeChecked()
  const config = path.join(instance.home, 'config.toml')
  await expect.poll(() => fs.readFile(config, 'utf8')).toContain('auto_download_updates = false')
  expect(await fs.readFile(config, 'utf8')).toContain('update_notifications_enabled = false')
  await instance.stop()
  desktop = await instance.launch()
  await desktop.app.evaluate(({ ipcMain }) => {
    let summary = { bytes: 1024 * 1024, files: 1 }
    ipcMain.removeHandler('lexora:app:updates:cache-summary')
    ipcMain.handle('lexora:app:updates:cache-summary', () => summary)
    ipcMain.removeHandler('lexora:app:updates:clear-cache')
    ipcMain.handle('lexora:app:updates:clear-cache', () => {
      summary = { bytes: 0, files: 0 }
    })
    ipcMain.removeHandler('lexora:app:updates:open-directory')
    ipcMain.handle('lexora:app:updates:open-directory', () => {
      throw new Error('fixture-private-directory')
    })
  })
  await exposeDownloadSettings(desktop, directory)
  await about(desktop.page)
  await expect(toggle(desktop.page)).not.toBeChecked()
  await expect(download()).not.toBeChecked()
  await expect(settings()).toContainText(directory)
  await settings().getByRole('button', { name: '打开下载位置', exact: true }).click()
  await expect(desktop.page.locator('.n-message')).toHaveCount(1)
  await expect(desktop.page.locator('.n-message')).toContainText('操作失败')
  await expect(desktop.page.locator('body')).not.toContainText('fixture-private-directory')
  await expect(settings()).toContainText('1 MB')
  async function openClear() {
    await settings().getByRole('button', { name: '缓存操作', exact: true }).click()
    await desktop.page.getByRole('menuitem', { name: '清理更新缓存', exact: true }).click()
  }
  await openClear()
  const confirmation = desktop.page.locator('.n-dialog')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(settings()).toContainText('1 MB')
  await openClear()
  await confirmation.getByRole('button', { name: '清理更新缓存', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(settings()).not.toContainText('1 MB')
  expect(desktop.diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
})

test('explicit reminder deferrals survive relaunch and are consumed only after the deferred reminder is shown', async ({ buddy }) => {
  const instance = await buddy.createInstance('update-snooze')
  await seedUpdate(instance)
  let desktop = await instance.launch()
  await about(desktop.page)
  await desktop.page.locator('.desktop-about-settings').getByRole('button', { name: '查看更新', exact: true }).click()
  const dialog = () => desktop.page.locator('.desktop-update-dialog')
  await dialog().getByRole('button', { name: '稍后', exact: true }).click()
  await desktop.page.getByRole('menuitem', { name: '30 分钟后提醒', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  await expect.poll(() => decisions(instance)).toMatchObject({ version: 2, ignoredVersion: null, snoozedReminder: { version } })
  const scheduled = (await decisions(instance)).snoozedReminder.until
  await instance.stop()
  desktop = await instance.launch()
  await focus(desktop.app)
  expect((await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())).reminderDueAt).toBe(scheduled)
  await expect(desktop.page.getByTestId('update-reminder')).toHaveCount(0)
  await instance.stop()
  const record = await decisions(instance)
  record.snoozedReminder.until = Date.now() - 1
  await fs.writeFile(path.join(instance.home, 'buddy/updates.json'), JSON.stringify(record))
  desktop = await instance.launch()
  await focus(desktop.app)
  const reminder = desktop.page.getByTestId('update-reminder')
  await expect(reminder).toBeVisible()
  await expect.poll(() => decisions(instance)).toMatchObject({ snoozedReminder: { reminded: true }, notifiedVersion: version })
  await reminder.getByRole('button', { name: '稍后', exact: true }).click()
  await desktop.page.getByRole('menuitem', { name: '明天提醒', exact: true }).click()
  await expect(reminder).toHaveCount(0)
  await expect.poll(async () => (await decisions(instance)).snoozedReminder?.until ?? 0).toBeGreaterThan(Date.now() + 23 * 60 * 60_000)
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { updateNotificationsEnabled: false } }))
  await about(desktop.page)
  await desktop.page.locator('.desktop-about-settings').getByRole('button', { name: '查看更新', exact: true }).click()
  await expect(dialog()).toContainText('已安排')
  await dialog().getByRole('button', { name: '稍后', exact: true }).click()
  await desktop.page.getByRole('menuitem', { name: '取消延期提醒', exact: true }).click()
  await expect(dialog()).not.toContainText('已安排')
  await expect.poll(() => decisions(instance)).toMatchObject({ snoozedReminder: null })
  expect((await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())).enabled).toBe(false)
  expect(desktop.diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
})

test('failed real update checks retain the last successful time and describe the cached result inline', async ({ buddy }) => {
  const instance = await buddy.createInstance('update-check-offline')
  await seedUpdate(instance, false)
  const desktop = await instance.launch()
  await about(desktop.page)
  const before = await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())
  const tag = desktop.page.getByTestId('update-check-status')
  const checked = await tag.textContent()
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ proxy: { mode: 'custom', server: 'http://127.0.0.1:9' } }))
  await desktop.page.locator('.desktop-about-settings').getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(desktop.page.locator('.n-message')).toContainText('暂时无法检查更新')
  const after = await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())
  expect(after.checkFailed).toBe(true)
  expect(after.lastSuccessfulCheckAt).toBe(before.lastSuccessfulCheckAt)
  expect(after.result).toEqual(before.result)
  await expect(tag).toHaveText(checked)
  await expect(desktop.page.locator('.desktop-update-settings')).toContainText('本次检查未完成，显示上次结果')
  await expect(desktop.page.getByRole('button', { name: '重试检查', exact: true })).toBeVisible()
  expect(desktop.diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
})

test('updates defer for all running tasks and pending approvals, then notify when the window is idle', async ({ buddy }) => {
  const instance = await buddy.createInstance('updates-busy')
  await seedUpdate(instance, false)
  const { app, page, diagnostics } = await instance.launch()
  const databasePath = path.join(instance.home, 'buddy/buddy.sqlite3')
  await app.evaluate((_electron, databasePath) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const now = new Date().toISOString()
      db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('update-fixture-task', 'Isolated running task', now, now)
      db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('update-fixture-branch', 'update-fixture-task', now)
      db.prepare('INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at) VALUES (?, ?, ?, ?, ?, ?, \'chat\', \'running\', ?)').run('update-fixture-run', 'update-fixture-task', 'update-fixture-branch', 'update-fixture-input', 'fixture', 'fixture', now)
      db.prepare('INSERT INTO approvals (id, run_id, tool_call_id, kind, status, summary, payload_json, created_at) VALUES (?, ?, ?, \'test\', \'pending\', \'Isolated approval\', \'{}\', ?)').run('update-fixture-approval', 'update-fixture-run', 'fixture-tool', now)
    }
    finally { db.close() }
  }, databasePath)
  await exposeAutomaticCheckSettings({ app, page })
  await about(page)
  await toggle(page).click()
  await expect(toggle(page)).toBeChecked()
  await focus(app)
  expect(await page.evaluate(() => window.lexoraDesktop.app.updates.takeReminder())).toBeNull()
  await expect(page.getByTestId('update-reminder')).toHaveCount(0)
  await app.evaluate((_electron, databasePath) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      db.exec('UPDATE runs SET status = \'completed\' WHERE id = \'update-fixture-run\'')
    }
    finally { db.close() }
  }, databasePath)
  expect(await page.evaluate(() => window.lexoraDesktop.app.updates.takeReminder())).toBeNull()
  expect((await decisions(instance)).notifiedVersion).toBeNull()
  await app.evaluate(({ BrowserWindow }, databasePath) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      db.exec('UPDATE approvals SET status = \'approved\' WHERE id = \'update-fixture-approval\'')
    }
    finally { db.close() }
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('lexora-app:'))
    window.webContents.send('lexora:buddy:runs:event', { type: 'run.completed', runId: 'update-fixture-run', sequence: 1, createdAt: new Date().toISOString(), payload: {} })
  }, databasePath)
  await expect(page.getByTestId('update-reminder')).toBeVisible()
  await toggle(page).click()
  await expect(page.getByTestId('update-reminder')).toHaveCount(0)
  expect((await page.evaluate(() => window.lexoraDesktop.app.updates.getState())).notification).toBeNull()
  expect(diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
})

test('update delivery waits for verification and requires review of changed versions', async ({ buddy }) => {
  const instance = await buddy.createInstance('update-delivery')
  await seedUpdate(instance, false)
  const { app, page, diagnostics } = await instance.launch()
  await app.evaluate(({ ipcMain, BrowserWindow }, result) => {
    const state = { revision: 100, checking: false, enabled: false, lastCheckedAt: Date.now(), lastSuccessfulCheckAt: Date.now(), checkFailed: false, ignoredVersion: null, result, notification: null, reminderDueAt: null, delivery: { mode: 'restart', reason: null, status: 'verifying', version: result.latestVersion, progressPercent: 0 } }
    globalThis.updateDeliveryFixture = state
    ipcMain.removeHandler('lexora:app:check-for-updates')
    ipcMain.handle('lexora:app:check-for-updates', () => globalThis.updateDeliveryFixture.result)
    ipcMain.removeHandler('lexora:app:updates:state')
    ipcMain.handle('lexora:app:updates:state', () => state)
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('lexora:app:updates:changed', state)
  }, result)
  await checkFromApplicationMenu(page)
  const dialog = page.locator('.desktop-update-dialog')
  await expect(dialog.getByRole('button', { name: '正在校验…', exact: true })).toBeDisabled()
  const staleActions = await page.evaluate(async () => {
    const updates = window.lexoraDesktop.app.updates
    return Promise.all([updates.download, updates.cancelDownload, updates.install, updates.openPackage].map(async (operation) => {
      try {
        await operation('998.0.0')
        return 'accepted'
      }
      catch (error) {
        return error.message
      }
    }))
  })
  for (const response of staleActions)
    expect(response).toContain('UPDATE_TARGET_CHANGED')
  await app.evaluate(({ BrowserWindow }) => {
    const state = globalThis.updateDeliveryFixture
    state.revision++
    state.result = { ...state.result, latestVersion: '999.2.0', releaseUrl: 'https://github.com/useLexora/Lexora/releases/tag/v999.2.0', releaseNotes: '新版本的更新说明' }
    state.delivery = { ...state.delivery, mode: 'restart', reason: null, status: 'ready', version: '999.2.0' }
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('lexora:app:updates:changed', state)
  })
  await expect(dialog).toContainText(`Lexora Buddy ${version}`)
  await expect(dialog).toContainText('发现更新的版本 v999.2.0')
  await expect(dialog.getByRole('button', { name: '跳过此版本', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '重启并安装更新', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: '查看新版本', exact: true }).click()
  await expect(dialog).toContainText('Lexora Buddy 999.2.0')
  await expect(dialog).toContainText('新版本的更新说明')
  await expect(dialog.getByRole('button', { name: '重启并安装更新', exact: true })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    const state = globalThis.updateDeliveryFixture
    state.revision++
    state.result = { ...state.result, latestVersion: '0.0.0', status: 'up_to_date', releaseNotes: '' }
    state.delivery = { mode: 'release', reason: null, status: 'idle', version: null, progressPercent: 0 }
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('lexora:app:updates:changed', state)
  })
  await dialog.getByRole('button', { name: '查看检查结果', exact: true }).click()
  await expect(dialog).toContainText('已是最新版本')
  await expect(dialog.getByRole('button', { name: '跳过此版本', exact: true })).toHaveCount(0)
  expect(diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
})

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
  return page.locator('.desktop-application-toggle').filter({ hasText: '更新通知' }).getByRole('switch')
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

test('updates stay discoverable after dismissal, persist skips and opt-out, and keep manual checks available', async ({ buddy }) => {
  const instance = await buddy.createInstance('updates')
  await seedUpdate(instance)
  let desktop = await instance.launch()
  await focus(desktop.app)
  const reminder = () => desktop.page.getByTestId('update-reminder')
  await expect(reminder()).toBeVisible()
  await expect.poll(() => decisions(instance)).toMatchObject({ notifiedVersion: version, seenVersion: null })
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
  await dialog().getByRole('button', { name: '忽略此版本', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  await expect.poll(() => decisions(instance)).toMatchObject({ ignoredVersion: version })
  await instance.stop()
  desktop = await instance.launch()
  expect((await desktop.page.evaluate(() => window.lexoraDesktop.app.updates.getState())).notification).toBeNull()
  await expect(reminder()).toHaveCount(0)
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
  await dialog().getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  await desktop.app.evaluate(({ ipcMain, app }) => {
    const currentVersion = app.getVersion()
    ipcMain.removeHandler('lexora:app:check-for-updates')
    ipcMain.handle('lexora:app:check-for-updates', () => ({
      currentVersion,
      latestVersion: currentVersion,
      status: 'up_to_date',
      releaseUrl: `https://github.com/useLexora/Lexora/releases/tag/v${currentVersion}`,
      releaseNotes: '',
    }))
  })
  await checkFromApplicationMenu(desktop.page)
  await expect(dialog()).toContainText('已是最新版本')
  await expect(dialog().getByRole('button', { name: '忽略此版本', exact: true })).toHaveCount(0)
  await expect(dialog().getByRole('button', { name: '前往下载', exact: true })).toHaveCount(0)
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

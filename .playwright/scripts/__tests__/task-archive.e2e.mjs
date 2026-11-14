import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { expect, test } from '../fixtures/electron.mjs'
import { prepareTaskArchiveProfile, taskExists } from '../fixtures/task-archive.mjs'

const pluginId = 'p95e8d9a8d120433d9ba2058e1c844ed0.legacy-task-cleanup'

test.use({ developmentRenderer: false })

async function archiveTask(page, id) {
  const row = page.locator(`[data-task-id="${id}"]`)
  await row.click({ button: 'right' })
  await page.locator('.n-dropdown-menu:visible').getByText('归档', { exact: true }).click()
  const confirm = page.getByTestId('task-archive-confirm')
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '归档', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(row).toBeHidden()
}

async function openManager(page) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  const link = page.locator('.desktop-settings-sidebar').getByRole('link', { name: '任务归档', exact: true })
  await link.click()
  await expect(page.locator('.desktop-settings-page__title')).toHaveText('任务归档')
  const manager = page.getByTestId('task-archive-manager')
  await expect(manager).toBeVisible()
  return manager
}

async function launchArchiveInstance(instance, authority) {
  const session = await instance.launch({ storageAuthority: authority })
  await expect.poll(() => session.page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).toMatchObject({ status: 'ready' })
  return session
}

async function capture(page, testInfo, name) {
  const screenshot = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' })
}

for (const authority of ['legacy_jsonl', 'sqlite']) {
  test.describe(authority, () => {
    test('archived history stays read-only until explicit restoration', async ({ buddy }, testInfo) => {
      test.setTimeout(180000)
      const instance = await buddy.createInstance(`task-archive-legacy-${authority}`)
      await prepareTaskArchiveProfile(instance.home, testInfo.outputPath('profile-preparation'), authority)
      const { page } = await launchArchiveInstance(instance, authority)
      const row = page.locator('[data-task-id="archive-active"]')
      await expect(row).toBeVisible()
      await row.locator('.desktop-task-sidebar__task').click()
      await expect(page.locator('.desktop-chat-page:visible')).toBeVisible()
      await archiveTask(page, 'archive-active')
      await page.getByRole('button', { name: '撤销归档', exact: true }).click()
      await expect(row).toBeVisible()
      await archiveTask(page, 'archive-active')
      const manager = await openManager(page)
      const archived = manager.locator('[data-archive-id="archive-active"]')
      await expect(archived).toBeVisible()
      await archived.getByRole('button', { name: '可归档的历史任务', exact: true }).click()
      await expect(manager).toBeHidden()
      await expect(page.getByText('此任务已归档，仅可阅读历史。取消归档不会自动恢复执行或权限。')).toBeVisible()
      await expect(page.locator('.desktop-chat-page:visible .tiptap:visible')).toHaveCount(0)
      await expect(page.locator('.desktop-chat-page:visible')).toContainText('保留的历史内容 archive-active')
      await expect(row).toBeHidden()
      await page.getByRole('button', { name: '取消归档', exact: true }).click()
      await expect(row).toBeVisible()
      await expect(page.locator('.desktop-chat-page:visible .tiptap:visible')).toBeVisible()
      expect(await page.evaluate(() => window.lexoraDesktop.localChat.conversations.get('archive-active'))).toMatchObject({ archivedAt: null })
    })

    test('active task deletion requires confirmation and permanently removes only task-owned data', async ({ buddy }, testInfo) => {
      test.setTimeout(180000)
      const instance = await buddy.createInstance(`active-task-delete-${authority}`)
      const fixture = await prepareTaskArchiveProfile(instance.home, testInfo.outputPath('profile-preparation'), authority)
      const { app, page } = await launchArchiveInstance(instance, authority)
      const row = page.locator('[data-task-id="archive-active"]')
      await expect(row).toBeVisible()
      const before = await page.evaluate(() => window.lexoraDesktop.localChat.conversations.get('archive-active'))
      expect(before).toMatchObject({ archivedAt: null, deletedAt: null })
      const openDeletion = async () => {
        await row.click({ button: 'right' })
        await page.locator('.n-dropdown-menu:visible').getByText('删除', { exact: true }).click()
        const confirmation = page.getByRole('dialog').filter({ hasText: '删除任务？' })
        await expect(confirmation).toContainText('将永久删除“可归档的历史任务”')
        await expect(confirmation).toContainText('不可恢复')
        await expect(confirmation).toContainText('外部目录及其中的文件不受影响')
        return confirmation
      }
      let confirmation = await openDeletion()
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      await expect(confirmation).toBeHidden()
      await expect(row).toBeVisible()
      expect(await taskExists(app, fixture.databasePath, 'archive-active')).toBe(true)
      expect(await page.evaluate(() => window.lexoraDesktop.localChat.conversations.get('archive-active'))).toMatchObject({ deletedAt: null, metadataRevision: before.metadataRevision })
      expect(await fs.readFile(path.join(fixture.activeOwned, 'owned.txt'), 'utf8')).toBe('Task-owned fixture')
      confirmation = await openDeletion()
      await confirmation.getByRole('button', { name: '删除', exact: true }).click()
      await expect(confirmation).toBeHidden()
      await expect(row).toBeHidden()
      await expect.poll(() => taskExists(app, fixture.databasePath, 'archive-active')).toBe(false)
      await expect.poll(() => fs.access(fixture.activeOwned).then(() => true, () => false)).toBe(false)
      expect(await fs.readFile(path.join(fixture.external, 'keep.txt'), 'utf8')).toBe('External fixture must survive')
      expect(await taskExists(app, fixture.databasePath, 'archive-existing')).toBe(true)
      expect(await taskExists(app, fixture.databasePath, 'archive-legacy')).toBe(true)
    })

    test('official legacy cleanup plugin owns confirmation and preserves external files', async ({ buddy }, testInfo) => {
      test.skip(!process.env.LEXORA_TEST_LEGACY_CLEANUP_ARCHIVE, 'Provide the separately built legacy cleanup plugin archive')
      test.setTimeout(180000)
      const instance = await buddy.createInstance(`legacy-task-cleanup-${authority}`)
      const fixture = await prepareTaskArchiveProfile(instance.home, testInfo.outputPath('profile-preparation'), authority, { legacyTasks: 32, legacyFiles: 64 })
      const { app, page } = await launchArchiveInstance(instance, authority)
      await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
      await app.evaluate(({ dialog }, archive) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] })
      }, process.env.LEXORA_TEST_LEGACY_CLEANUP_ARCHIVE)
      await page.getByTestId('extension-install-options').click()
      await page.getByTestId('extension-install').click()
      const review = page.getByTestId('extension-install-review')
      await expect(review).toBeVisible()
      await expect(review.locator('[data-permission="legacyTaskCleanup"]')).toContainText('不允许删除活动任务或任意文件')
      await review.getByTestId('extension-confirm-install').click()
      await expect(review).toBeHidden()
      await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id)?.enabled, pluginId)).toBe(true)
      const card = page.locator(`article[data-extension-id="${pluginId}"]`)
      await expect(card.getByRole('button', { name: '打开', exact: true })).toHaveCount(0)
      await expect(page.locator('.desktop-app-sidebar').getByRole('button', { name: '旧版任务清理', exact: true })).toHaveCount(0)
      const runCleanup = async () => {
        await card.getByTestId('extension-card-more').click()
        await page.getByTestId('extension-actions').hover()
        const action = page.locator(`[data-extension-action="${pluginId}.action"]`)
        await expect(action).toHaveText('清理任务残留…')
        await action.click()
      }
      const pluginFrame = async () => {
        let frame
        await expect.poll(async () => {
          for (const candidate of page.frames()) {
            if (await candidate.getByTestId('legacy-task-cleanup-panel').count().catch(() => 0)) {
              frame = candidate
              return true
            }
          }
          return false
        }).toBe(true)
        return frame
      }
      const showResult = async () => {
        await card.getByTestId('extension-card-more').click()
        await page.getByTestId('extension-actions').hover()
        await page.locator(`[data-extension-action="${pluginId}.result-action"]`).click()
        return pluginFrame()
      }
      const lifecycleWindow = await app.browserWindow(page)
      await lifecycleWindow.evaluate(window => window.focus())
      await runCleanup()
      let frame = await pluginFrame()
      const confirmation = () => frame.getByTestId('cleanup-preview')
      await expect(confirmation()).toBeVisible()
      await expect(frame.getByTestId('cleanup-preview-total')).toHaveText('32')
      await expect(confirmation()).toContainText('不可恢复')
      await expect(confirmation()).toContainText('不处理活动或已归档任务')
      await expect(confirmation()).toContainText('不删除用户工作区及外部文件')
      await expect(frame.getByTestId('legacy-task-cleanup-panel')).toHaveAttribute('data-phase', 'confirming')
      for (const appearance of ['light', 'dark']) {
        await page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id: 'system' } }))
        await app.evaluate(({ nativeTheme }, appearance) => {
          Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { configurable: true, get: () => appearance === 'dark' })
          nativeTheme.emit('updated')
        }, appearance)
        await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', appearance)
        await capture(page, testInfo, `legacy-cleanup-confirm-${appearance}`)
      }
      const originalBounds = await lifecycleWindow.evaluate(window => window.getBounds())
      await lifecycleWindow.evaluate(window => window.setBounds({ width: 980, height: 640 }))
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(980)
      await expect(frame.getByTestId('cleanup-confirm-delete')).toBeInViewport()
      await capture(page, testInfo, 'legacy-cleanup-confirm-minimum')
      await lifecycleWindow.evaluate((window, bounds) => window.setBounds(bounds), originalBounds)
      await frame.getByTestId('cleanup-cancel').click()
      await expect(confirmation()).toBeHidden()
      await expect(frame.getByTestId('legacy-task-cleanup-panel')).toHaveAttribute('data-phase', 'cancelled')
      expect(await taskExists(app, fixture.databasePath, 'archive-legacy')).toBe(true)
      expect(await fs.readFile(path.join(fixture.owned, 'owned.txt'), 'utf8')).toBe('Task-owned fixture')
      await frame.getByRole('button', { name: '关闭', exact: true }).click()
      await runCleanup()
      frame = await pluginFrame()
      await expect(confirmation()).toBeVisible()
      await lifecycleWindow.evaluate(window => window.hide())
      await expect(frame.getByTestId('legacy-task-cleanup-panel')).toHaveAttribute('data-phase', 'cancelled')
      await lifecycleWindow.evaluate((window) => {
        window.show()
        window.focus()
      })
      await expect(confirmation()).toBeHidden()
      expect(await taskExists(app, fixture.databasePath, 'archive-legacy')).toBe(true)
      await frame.getByRole('button', { name: '关闭', exact: true }).click()
      await runCleanup()
      frame = await pluginFrame()
      await expect(confirmation()).toBeVisible()
      await frame.evaluate(() => {
        window.cleanupProgressSnapshots = []
        const panel = document.querySelector('[data-testid="legacy-task-cleanup-panel"]')
        new MutationObserver(() => {
          if (panel.dataset.phase === 'running')
            window.cleanupProgressSnapshots.push(Number(panel.querySelector('[data-testid="cleanup-processed"]').textContent))
        }).observe(panel, { subtree: true, attributes: true, childList: true, characterData: true })
      })
      await frame.getByTestId('cleanup-confirm-delete').click()
      await expect(confirmation()).toBeHidden()
      await expect(frame.getByTestId('legacy-task-cleanup-panel')).toHaveAttribute('data-phase', 'running')
      await expect.poll(() => frame.evaluate(() => window.cleanupProgressSnapshots.some(count => count > 0 && count < 32))).toBe(true)
      await capture(page, testInfo, 'legacy-cleanup-plugin-progress')
      await frame.getByRole('button', { name: /^(后台继续|关闭)$/ }).click()
      await expect(card.getByTestId('extension-card-more')).toBeEnabled()
      await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
      await expect.poll(() => taskExists(app, fixture.databasePath, 'archive-legacy-31')).toBe(false)
      await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
      frame = await showResult()
      await expect(frame.getByTestId('legacy-task-cleanup-panel')).toHaveAttribute('data-phase', 'completed')
      await expect(frame.getByTestId('cleanup-deleted')).toHaveText('32')
      await expect(frame.getByTestId('cleanup-pending')).toHaveText('0')
      await expect(frame.getByTestId('cleanup-failed')).toHaveText('0')
      await capture(page, testInfo, 'legacy-cleanup-plugin-result-dark')
      await app.evaluate(({ nativeTheme }) => {
        Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { configurable: true, get: () => false })
        nativeTheme.emit('updated')
      })
      await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', 'light')
      await capture(page, testInfo, 'legacy-cleanup-plugin-result-light')
      await lifecycleWindow.evaluate(window => window.setBounds({ width: 980, height: 640 }))
      await expect(frame.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
      await capture(page, testInfo, 'legacy-cleanup-plugin-result-minimum')
      await lifecycleWindow.evaluate((window, bounds) => window.setBounds(bounds), originalBounds)
      await lifecycleWindow.dispose()
      for (const id of fixture.legacyTaskIds)
        expect(await taskExists(app, fixture.databasePath, id)).toBe(false)
      await expect.poll(() => fs.access(fixture.owned).then(() => true, () => false)).toBe(false)
      expect(await fs.readFile(path.join(fixture.external, 'keep.txt'), 'utf8')).toBe('External fixture must survive')
      expect(await taskExists(app, fixture.databasePath, 'archive-active')).toBe(true)
      expect(await taskExists(app, fixture.databasePath, 'archive-existing')).toBe(true)
      await frame.getByRole('button', { name: '关闭', exact: true }).click()
      await runCleanup()
      frame = await pluginFrame()
      await expect(frame.getByTestId('legacy-task-cleanup-panel')).toHaveAttribute('data-phase', 'completed')
      await expect(frame.getByTestId('cleanup-total')).toHaveText('0')
      await expect(frame.getByTestId('legacy-task-cleanup-panel')).toContainText('没有可清理的旧版任务')
      await capture(page, testInfo, 'legacy-cleanup-plugin-empty')
      await frame.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(page.locator('.n-message')).toHaveCount(0, { timeout: 15000 })
      await card.getByTestId('extension-card-more').click()
      await page.getByTestId('extension-actions').hover()
      await capture(page, testInfo, 'legacy-cleanup-plugin-menu')
      await page.keyboard.press('Escape')
      await card.getByTestId('extension-disable').click()
      await expect(card.getByTestId('extension-enable')).toBeVisible()
      await card.getByTestId('extension-card-more').click()
      await expect(page.getByTestId('extension-actions')).toHaveCount(0)
    })
  })
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

test('registered builtin settings preserve navigation, failed-save rollback and restart persistence', async ({ buddy }) => {
  const instance = await buddy.createInstance('settings')
  let desktop = await instance.launch()
  await openSettings(desktop.page)
  const globalToggle = () => desktop.page.getByTestId('context-panel-global-setting').getByRole('switch')
  await expect(globalToggle()).not.toBeChecked()
  await globalToggle().click()
  await expect(globalToggle()).toBeChecked()
  await desktop.page.getByTestId('context-panel-mode-setting').locator('.n-select').click()
  await desktop.page.locator('.n-base-select-menu').getByText('独立浏览', { exact: true }).click()
  await expect.poll(() => panelSettings(desktop.page)).toEqual({ global: true, mode: 'independent' })

  const entries = await desktop.page.locator('.desktop-settings-sidebar a').evaluateAll(links => links.map(link => ({ label: link.textContent.trim(), href: link.getAttribute('href') })))
  expect(entries.length).toBeGreaterThanOrEqual(13)
  for (const { label, href } of entries) {
    await desktop.page.locator('.desktop-settings-sidebar').getByRole('link', { name: label, exact: true }).click()
    await expect(desktop.page.locator('.desktop-settings-page__title')).toHaveText(label)
    await expect(desktop.page.locator('.settings-groups')).toBeVisible()
    await expect(desktop.page.locator(`.desktop-settings-sidebar a[href="${href}"]`)).toHaveAttribute('aria-current', 'page')
  }
  await desktop.page.evaluate(() => window.location.hash = '/settings/app')
  await expect(desktop.page).toHaveURL(/#\/settings\/general$/)
  await desktop.page.evaluate(() => window.location.hash = '/settings/extensions')
  await expect(desktop.page).toHaveURL(/#\/extensions$/)
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])

  await instance.stop()
  desktop = await instance.launch()
  await openSettings(desktop.page)
  expect(await panelSettings(desktop.page)).toEqual({ global: true, mode: 'independent' })
  await expect(globalToggle()).toBeChecked()
  await expect(desktop.page.getByTestId('context-panel-mode-setting').locator('.n-base-selection-label')).toHaveText('独立浏览')
  await desktop.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('lexora:settings:update')
    ipcMain.handle('lexora:settings:update', () => {
      throw new Error('Isolated settings save failure')
    })
  })
  await globalToggle().click()
  await expect(desktop.page.getByText('保存失败，已恢复原设置', { exact: true })).toBeVisible()
  await expect(globalToggle()).toBeEnabled()
  await expect(globalToggle()).toBeChecked()
  expect(await panelSettings(desktop.page)).toEqual({ global: true, mode: 'independent' })
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('registered plugin settings share groups, recover read/save errors and withdraw without deleting values', async ({ buddy }) => {
  const instance = await buddy.createInstance('settings-registry')
  let { app, page, diagnostics } = await instance.launch()
  const directory = path.join(instance.home, 'settings-plugin')
  await writeSettingsPlugin(directory, true)
  await app.evaluate(({ ipcMain, dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    const original = ipcMain._invokeHandlers.get('lexora:extensions:request')
    globalThis.settingsFixtureFailures = { load: true, save: false }
    globalThis.settingsFixtureSaves = []
    ipcMain.removeHandler('lexora:extensions:request')
    ipcMain.handle('lexora:extensions:request', async (event, request) => {
      if (request.action === 'settingConditions') {
        globalThis.settingsFixtureConditionReads = (globalThis.settingsFixtureConditionReads ?? 0) + 1
        await globalThis.settingsFixtureConditionGate
      }
      if (request.action === 'configure') {
        globalThis.settingsFixtureSaves.push(request.patch)
        await globalThis.settingsFixtureSaveGate
      }
      const { load, save } = globalThis.settingsFixtureFailures
      if ((load && request.action === 'configurationSnapshot') || (save && request.action === 'configure'))
        throw new Error('private-settings-fixture-detail')
      return original(event, request)
    })
  }, directory)
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-development').click()
  await page.getByTestId('extension-confirm-install').click()
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.extensions.list()).length)).toBe(1)
  await openSettings(page)
  const inline = () => page.locator('[data-setting-id="tests.settings.inline"]').getByRole('switch')
  await expect(page.locator('[data-settings-group="settings.general.general"] [data-setting-id="tests.settings.inline"]')).toBeVisible()
  await expect(page.locator('[data-settings-group="tests.settings.extra"]')).toContainText('附加分组')
  await page.getByRole('link', { name: '注册设置', exact: true }).click()
  const toggle = () => page.locator('[data-setting-id="tests.settings.enabled"]').getByRole('switch')
  await expect(toggle()).toBeDisabled()
  await expect(page.locator('.plugin-settings-status__entry')).toHaveCount(1)
  await app.evaluate(() => globalThis.settingsFixtureFailures.load = false)
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(toggle()).toBeEnabled()
  await expect(page.locator('.plugin-settings-status__entry')).toHaveCount(0)
  await expect(toggle()).not.toBeChecked()

  await app.evaluate(() => globalThis.settingsFixtureFailures.save = true)
  await toggle().click()
  await expect(page.locator('.n-message')).toHaveCount(1)
  await expect(toggle()).not.toBeChecked()
  await expect(toggle()).toBeEnabled()
  await expect(page.locator('body')).not.toContainText('private-settings-fixture-detail')
  await app.evaluate(() => globalThis.settingsFixtureFailures.save = false)
  await toggle().click()
  await expect(toggle()).toBeChecked()

  const label = () => page.locator('[data-setting-id="tests.settings.label"] input')
  await expect(label()).toBeEnabled()
  await app.evaluate(() => {
    globalThis.settingsFixtureConditionReads = 0
    globalThis.settingsFixtureConditionGate = new Promise(resolve => globalThis.releaseSettingsFixtureCondition = resolve)
  })
  await label().pressSequentially('editable', { delay: 75 })
  await expect(label()).toHaveValue('editable')
  await expect(label()).toBeFocused()
  await expect(label()).toBeEnabled()
  await expect.poll(() => app.evaluate(() => globalThis.settingsFixtureConditionReads)).toBeGreaterThan(0)
  await app.evaluate(() => globalThis.releaseSettingsFixtureCondition())
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ label: '' })
  await app.evaluate(() => {
    globalThis.settingsFixtureSaves = []
    globalThis.settingsFixtureSaveGate = new Promise(resolve => globalThis.releaseSettingsFixtureSave = resolve)
  })
  await label().press('Tab')
  await expect(label()).toBeDisabled()
  await expect(label()).toHaveValue('editable')
  expect(await app.evaluate(() => globalThis.settingsFixtureSaves)).toEqual([{ label: 'editable' }])
  await app.evaluate(() => globalThis.releaseSettingsFixtureSave())
  await expect(label()).toBeEnabled()
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ label: 'editable' })
  await app.evaluate(() => globalThis.settingsFixtureFailures.save = true)
  await label().fill('rejected')
  await expect(label()).toHaveValue('rejected')
  await label().press('Enter')
  await expect(label()).toHaveValue('editable')
  await expect(label()).toBeEnabled()
  await app.evaluate(() => globalThis.settingsFixtureFailures.save = false)
  await label().fill('')
  const ime = await page.context().newCDPSession(page)
  await ime.send('Input.imeSetComposition', { text: '组合输入', selectionStart: 4, selectionEnd: 4 })
  await expect(label()).toHaveValue('组合输入')
  await expect(label()).toBeFocused()
  await expect(label()).toBeEnabled()
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ label: 'editable' })
  await page.keyboard.insertText('组合输入')
  await expect(label()).toHaveValue('组合输入')
  await expect(label()).toBeFocused()
  await ime.detach()
  await label().fill('粘贴后的名称')
  await expect(label()).toHaveValue('粘贴后的名称')
  await label().press('Enter')
  await expect.poll(() => page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ label: '粘贴后的名称' })

  await page.getByRole('link', { name: '常规', exact: true }).click()
  const number = () => page.locator('[data-setting-id="tests.settings.extra-item"] input')
  await expect(number()).toBeEnabled()
  await app.evaluate(() => {
    globalThis.settingsFixtureSaves = []
    globalThis.settingsFixtureSaveGate = new Promise(resolve => globalThis.releaseSettingsFixtureSave = resolve)
  })
  await number().fill('')
  await number().pressSequentially('12')
  await expect(number()).toHaveValue('12')
  await expect(number()).toBeEnabled()
  expect(await app.evaluate(() => globalThis.settingsFixtureSaves)).toEqual([])
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ extra: 0 })
  await number().press('Enter')
  await expect(number()).toBeDisabled()
  await expect(number()).toHaveValue('12')
  expect(await app.evaluate(() => globalThis.settingsFixtureSaves)).toEqual([{ extra: 12 }])
  await app.evaluate(() => globalThis.releaseSettingsFixtureSave())
  await expect(number()).toBeEnabled()
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ extra: 12 })
  await app.evaluate(() => globalThis.settingsFixtureFailures.save = true)
  await number().fill('34')
  await number().press('Tab')
  await expect(number()).toHaveValue('12')
  await expect(number()).toBeEnabled()
  await app.evaluate(() => globalThis.settingsFixtureFailures.save = false)
  await number().fill('56')
  await number().press('Tab')
  await expect.poll(() => page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ extra: 56 })
  await inline().click()
  await expect(inline()).toBeChecked()
  await expect(page.locator('.n-message')).toHaveCount(0)
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'registered-settings-light.png'), animations: 'disabled' })
  await page.getByRole('link', { name: '外观', exact: true }).click()
  await page.locator('.desktop-settings-row').filter({ has: page.getByText('主题', { exact: true }) }).locator('.n-select').click()
  await page.locator('.n-base-select-menu').getByText('深色', { exact: true }).click()
  await expect(page.locator('.buddy-app')).toHaveClass(/is-dark/)
  await page.getByRole('link', { name: '常规', exact: true }).click()
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'registered-settings-dark.png'), animations: 'disabled' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(980, 680))
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'registered-settings-narrow.png'), animations: 'disabled' })
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.locator('[data-settings-group="tests.settings.logs"]')).toContainText('日志附加分组')
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'registered-settings-fill.png'), animations: 'disabled' })

  await page.getByRole('link', { name: '注册设置', exact: true }).click()
  await page.evaluate(() => window.lexoraDesktop.extensions.enable('tests.settings', false))
  await expect(page.getByRole('link', { name: '注册设置', exact: true })).toHaveCount(0)
  await expect(page.locator('.desktop-settings-page').getByRole('status')).toContainText('此设置模块暂不可用')
  await page.evaluate(() => window.lexoraDesktop.extensions.enable('tests.settings', true))
  await expect(toggle()).toBeChecked()
  await expect(page.getByRole('link', { name: '注册设置', exact: true })).toHaveAttribute('aria-current', 'page')

  await instance.stop()
  const workbenchPath = path.join(instance.home, 'buddy/workbench.json')
  const retainedWorkbench = JSON.parse(await fs.readFile(workbenchPath, 'utf8'))
  retainedWorkbench.configuration['workbench.controls.model.reasoning'] = 'tests.settings.retired-control'
  retainedWorkbench.configuration['workbench.slots.composer.accessory'] = JSON.stringify(['tests.settings.retired-slot', 'tests.settings-other.retained'])
  await fs.writeFile(workbenchPath, JSON.stringify(retainedWorkbench))
  ;({ app, page, diagnostics } = await instance.launch())
  await openSettings(page)
  await expect(inline()).toBeChecked()
  await expect(number()).toHaveValue('56')
  await page.getByRole('link', { name: '注册设置', exact: true }).click()
  await expect(toggle()).toBeChecked()
  await expect(label()).toHaveValue('粘贴后的名称')
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await page.locator('[data-extension-id="tests.settings"]').getByTestId('extension-card-more').click()
  await page.getByTestId('extension-uninstall').click()
  const regularDialog = page.getByRole('dialog').filter({ hasText: '卸载扩展？' })
  await expect(regularDialog.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await regularDialog.getByRole('button', { name: '卸载', exact: true }).click()
  await expect(page.locator('[data-extension-id="tests.settings"]')).toHaveCount(0)
  expect(JSON.parse(await fs.readFile(path.join(instance.home, 'buddy/extensions/data/tests.settings/configuration.json'), 'utf8'))).toMatchObject({ enabled: true, inline: true })
  await openSettings(page)
  await expect(page.getByRole('link', { name: '注册设置', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: '常规', exact: true }).click()
  await expect(page.locator('[data-setting-id="tests.settings.inline"]')).toHaveCount(0)
  await expect(page.getByTestId('context-panel-global-setting')).toBeVisible()

  async function reinstall() {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, directory)
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
    await page.getByTestId('extension-install-options').click()
    await page.getByTestId('extension-development').click()
    await page.getByTestId('extension-confirm-install').click()
    await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.extensions.list()).map(plugin => plugin.manifest.id))).toContain('tests.settings')
    await expect(page.locator('[data-extension-id="tests.settings"]')).toBeVisible()
  }
  const card = () => page.locator('[data-extension-id="tests.settings"]')
  await reinstall()
  await card().getByRole('button', { name: '打开', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings\/plugins\/tests.settings.module$/)
  await expect(toggle()).toBeChecked()
  await page.evaluate(() => window.lexoraDesktop.extensions.execute('tests.settings', 'tests.settings.open', null))
  await expect.poll(() => page.evaluate(async () => Object.values((await window.lexoraDesktop.workbench.read()).layout.views).filter(view => view.resource.data.extensionId === 'tests.settings').length)).toBe(1)
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  const showUninstall = async () => {
    await card().getByTestId('extension-card-more').click()
    await page.getByTestId('extension-uninstall').click()
  }
  await showUninstall()
  const uninstallDialog = () => page.getByRole('dialog').filter({ hasText: '卸载扩展？' })
  await expect(uninstallDialog()).toContainText('无法撤销')
  await expect(uninstallDialog().getByRole('button', { name: '取消', exact: true })).toBeFocused()
  const cleanBounds = await uninstallDialog().getByRole('button', { name: '卸载并清理', exact: true }).boundingBox()
  const cancelBounds = await uninstallDialog().getByRole('button', { name: '取消', exact: true }).boundingBox()
  expect(cleanBounds.x).toBeLessThan(cancelBounds.x)
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'uninstall-options.png'), animations: 'disabled' })
  await uninstallDialog().getByRole('button', { name: '取消', exact: true }).press('Enter')
  await expect(uninstallDialog()).toHaveCount(0)
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ enabled: true })
  await app.evaluate(({ ipcMain }) => {
    const write = ipcMain._invokeHandlers.get('lexora:workbench:write')
    globalThis.failCleanupCheckpoint = true
    ipcMain.removeHandler('lexora:workbench:write')
    ipcMain.handle('lexora:workbench:write', (event, state, options) => {
      if (options?.resetRecovery && globalThis.failCleanupCheckpoint)
        throw new Error('Isolated cleanup persistence failure')
      return write(event, state, options)
    })
  })
  await showUninstall()
  await uninstallDialog().getByRole('button', { name: '卸载并清理', exact: true }).click()
  await expect(page.getByText('操作未完成: EXTENSION_DATA_CLEANUP_FAILED', { exact: true })).toBeVisible()
  await expect(uninstallDialog()).toBeVisible()
  expect(JSON.parse(await fs.readFile(path.join(instance.home, 'buddy/extensions/data/tests.settings/state.json'), 'utf8'))).toMatchObject({ value: { retained: true } })
  await app.evaluate(() => globalThis.failCleanupCheckpoint = false)
  await uninstallDialog().getByRole('button', { name: '卸载并清理', exact: true }).click()
  await expect(card()).toHaveCount(0)
  await expect(uninstallDialog()).toHaveCount(0)
  await expect(fs.stat(path.join(instance.home, 'buddy/extensions/data/tests.settings'))).rejects.toMatchObject({ code: 'ENOENT' })
  for (const filename of ['workbench.json', 'workbench.previous.json']) {
    const snapshot = JSON.parse(await fs.readFile(path.join(instance.home, 'buddy', filename), 'utf8'))
    expect(Object.values(snapshot.layout.views).filter(view => view.resource.data.extensionId === 'tests.settings')).toEqual([])
    expect(snapshot.configuration['workbench.controls.model.reasoning']).toBeUndefined()
    expect(JSON.parse(snapshot.configuration['workbench.slots.composer.accessory'])).toEqual(['tests.settings-other.retained'])
  }
  await instance.stop()
  ;({ app, page, diagnostics } = await instance.launch())
  await reinstall()
  await card().getByRole('button', { name: '打开', exact: true }).click()
  await expect(toggle()).not.toBeChecked()
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ enabled: false, inline: false })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('scoped wildcard observers coexist with explicit configuration application and recover incompatible upgrades', async ({ buddy }) => {
  const instance = await buddy.createInstance('settings-events')
  let { app, page, diagnostics } = await instance.launch()
  const directory = path.join(instance.home, 'event-plugin')
  await writeSettingsPlugin(directory)
  await fs.writeFile(path.join(directory, 'extension.js'), `
export function activate(context) {
  let once = 0;
  let aliases = 0;
  context.events.on(['configuration:*', 'configuration:changed'], () => { once++; }, { once: true });
  context.configuration.onChange(() => { aliases++; });
  const stopped = new AbortController();
  context.events.on('configuration:**', () => { throw new Error('disposed listener'); }, { signal: stopped.signal });
  stopped.abort();
  context.events.on('configuration:**', async event => {
    await Promise.resolve();
    await context.storage.set({ once, aliases, configuration: event.data.configuration, changedKeys: event.data.changedKeys });
    await context.views.broadcast({ label: event.data.configuration.label });
  });
  context.commands.register('tests.settings.open', () => context.views.open('tests.settings.view', { state: {} }));
}`)
  await fs.writeFile(path.join(directory, 'view.js'), `
export function render(context, container) {
  container.dataset.instance = crypto.randomUUID();
  const output = document.createElement('output');
  output.textContent = 'waiting';
  container.append(output);
  let deliveries = 0;
  context.events.on(['view:**', 'view:message:received'], event => {
    if (event.type === 'view:message:received') {
      output.textContent = event.data.message.label;
      container.dataset.deliveries = String(++deliveries);
    }
  });
}`)
  async function install(updating = false) {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, directory)
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
    await page.getByTestId('extension-install-options').click()
    await page.getByTestId('extension-development').click()
    await page.getByTestId('extension-confirm-install').click()
    await expect.poll(() => page.evaluate(async (updating) => {
      const plugin = (await window.lexoraDesktop.extensions.list())[0]
      return !!plugin && (!updating || !!plugin.pending)
    }, updating)).toBe(true)
  }
  await install()
  await page.evaluate(() => window.lexoraDesktop.extensions.execute('tests.settings', 'tests.settings.open', null))
  await expect.poll(() => page.frames().some(frame => frame.url().includes('/__view.html'))).toBe(true)
  const frame = page.frames().find(frame => frame.url().includes('/__view.html'))
  await expect(frame.locator('output')).toHaveText('waiting')
  const viewInstance = await frame.locator('main').getAttribute('data-instance')
  const generation = await page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].generation)
  await openSettings(page)
  await page.getByRole('link', { name: '注册设置', exact: true }).click()
  const label = page.locator('[data-setting-id="tests.settings.label"] input')
  for (const value of ['first', 'retained']) {
    await expect(label).toBeEnabled()
    await label.fill(value)
    await label.press('Enter')
    await expect(frame.locator('output')).toHaveText(value)
    await expect(label).toBeEnabled()
  }
  expect(await frame.locator('main').getAttribute('data-instance')).toBe(viewInstance)
  expect(await frame.locator('main').getAttribute('data-deliveries')).toBe('2')
  expect(await page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].generation)).toBe(generation)
  const stored = JSON.parse(await fs.readFile(path.join(instance.home, 'buddy/extensions/data/tests.settings/state.json'), 'utf8'))
  expect(stored.value).toMatchObject({ once: 1, aliases: 2, configuration: { label: 'retained' }, changedKeys: ['label'] })
  await page.evaluate(() => window.lexoraDesktop.extensions.configure('tests.settings', { extra: 56 }))
  const manifestPath = path.join(directory, 'extension.json')
  const upgraded = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  upgraded.version = '1.1.0'
  upgraded.contributes.settings.items.find(item => item.key === 'extra').max = 10
  await fs.writeFile(manifestPath, JSON.stringify(upgraded))
  await install(true)
  await page.evaluate(() => window.lexoraDesktop.extensions.restart('tests.settings'))
  await openSettings(page)
  const number = page.locator('[data-setting-id="tests.settings.extra-item"]')
  await expect(number.getByRole('status')).toContainText('原值已保留')
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configurationSnapshot('tests.settings'))).toMatchObject({ values: { extra: 56, label: 'retained' }, invalidKeys: ['extra'] })
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'configuration-upgrade-recovery.png'), animations: 'disabled' })
  await number.getByRole('button', { name: '恢复默认值', exact: true }).click()
  await expect(number.getByRole('status')).toHaveCount(0)
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configuration('tests.settings'))).toMatchObject({ extra: 0, label: 'retained' })
  await instance.stop()
  ;({ app, page, diagnostics } = await instance.launch())
  expect(await page.evaluate(() => window.lexoraDesktop.extensions.configurationSnapshot('tests.settings'))).toMatchObject({ values: { extra: 0, label: 'retained' }, invalidKeys: [] })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('codemode defaults off and its runtime switch persists across restart and language changes', async ({ buddy }) => {
  const instance = await buddy.createInstance('codemode-settings')
  let desktop = await instance.launch()
  const openRuntime = async () => {
    await openSettings(desktop.page)
    await desktop.page.locator('.desktop-settings-sidebar').getByRole('link', { name: '运行时', exact: true }).click()
  }
  const toggle = () => desktop.page.getByTestId('codemode-setting').getByRole('switch')
  const preference = () => desktop.page.evaluate(async () => (await window.lexoraDesktop.settings.get()).runtime.codemode)
  await openRuntime()
  await expect(toggle()).toHaveAttribute('aria-checked', 'false')
  expect(await preference()).toBe(false)
  await toggle().click()
  await expect.poll(preference).toBe(true)
  await expect(toggle()).toHaveAttribute('aria-checked', 'true')
  await desktop.page.screenshot({ path: path.join(instance.artifactDirectory, 'codemode-runtime-enabled.png'), animations: 'disabled' })
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { language: 'en-US' } }))
  await expect(toggle()).toHaveAccessibleName('Codemode tool orchestration')
  await expect(toggle()).toHaveAttribute('aria-checked', 'true')
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { language: 'zh-CN' } }))
  await instance.stop()
  desktop = await instance.launch()
  await openRuntime()
  await expect(toggle()).toHaveAttribute('aria-checked', 'true')
  await toggle().click()
  await expect.poll(preference).toBe(false)
  await instance.stop()
  desktop = await instance.launch()
  await openRuntime()
  await expect(toggle()).toHaveAttribute('aria-checked', 'false')
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('global model retry settings preserve finite, unlimited and disabled values across restart', async ({ buddy }) => {
  const instance = await buddy.createInstance('model-retry-settings')
  let desktop = await instance.launch()
  await openSettings(desktop.page)
  await desktop.page.locator('.desktop-settings-sidebar').getByRole('link', { name: '运行时', exact: true }).click()
  const row = () => desktop.page.getByTestId('model-retry-limit-setting')
  const countRow = () => desktop.page.getByTestId('model-retry-count-setting')
  const input = () => countRow().locator('input.n-input__input-el')
  const limit = () => desktop.page.evaluate(async () => (await window.lexoraDesktop.settings.get()).runtime.modelRetryLimit)
  const mode = label => row().getByRole('button', { name: label, exact: true })
  const select = label => mode(label).click()
  const expectCapsuleAligned = () => expect.poll(() => row().evaluate((element) => {
    const capsule = element.querySelector('.n-tabs-capsule')?.getBoundingClientRect()
    const selected = element.querySelector('[aria-pressed="true"]')?.getBoundingClientRect()
    return !!capsule && !!selected && Math.abs(capsule.x - selected.x) < 1 && Math.abs(capsule.width - selected.width) < 1
  })).toBe(true)
  await expect(row().getByRole('button')).toHaveCount(3)
  await expect(mode('次数')).toHaveAttribute('aria-pressed', 'true')
  await expect(row().locator('small')).toHaveText('遇到临时错误时重试模型请求。')
  await expect(desktop.page.locator('.runtime-settings__group > .runtime-settings__row')).toHaveCount(2)
  await expect(input()).toHaveValue('3')
  await input().fill('12')
  expect(await limit()).toBe(3)
  await input().press('Enter')
  await expect.poll(limit).toBe(12)
  await expect(input()).toBeEnabled()
  await select('次数')
  expect(await limit()).toBe(12)
  const modeBox = await row().boundingBox()
  const countBox = await countRow().boundingBox()
  expect(countBox.y).toBeCloseTo(modeBox.y + modeBox.height, 0)
  expect(countBox.x).toBe(modeBox.x)
  expect(countBox.width).toBe(modeBox.width)
  expect((await row().locator('.runtime-settings__retry-modes').boundingBox()).width).toBeLessThan(200)
  await expectCapsuleAligned()
  await desktop.page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-settings-finite-light.png'), animations: 'disabled' })
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { language: 'en-US' } }))
  await expect(mode('Limited')).toHaveAttribute('aria-pressed', 'true')
  await expectCapsuleAligned()
  await desktop.page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-settings-finite-english.png'), animations: 'disabled' })
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { language: 'zh-CN' } }))
  await expect(mode('次数')).toHaveAttribute('aria-pressed', 'true')
  await expectCapsuleAligned()
  await row().locator('.n-tabs-capsule').evaluate((element) => {
    const from = element.getBoundingClientRect().x
    window.retrySegmentMotion = null
    element.addEventListener('transitionrun', () => {
      const animation = element.getAnimations().find(item => item.transitionProperty === 'transform')
      if (!animation)
        return
      const duration = Number(animation.effect.getTiming().duration)
      animation.pause()
      animation.currentTime = duration / 2
      window.retrySegmentMotion = {
        from,
        middle: element.getBoundingClientRect().x,
        to: element.closest('.n-tabs').querySelector('[aria-pressed="true"]').getBoundingClientRect().x,
        duration,
      }
      animation.play()
    }, { once: true })
  })
  await mode('无限').press('Space')
  await expect.poll(limit).toBe('unlimited')
  await expect(mode('无限')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => desktop.page.evaluate(() => window.retrySegmentMotion)).not.toBeNull()
  const motion = await desktop.page.evaluate(() => window.retrySegmentMotion)
  expect(motion.duration).toBeGreaterThan(0)
  expect(motion.middle).toBeGreaterThan(motion.from)
  expect(motion.middle).toBeLessThan(motion.to)
  await expectCapsuleAligned()
  await expect(countRow()).toHaveCount(0)
  await expect(row().locator('small')).toHaveText('遇到临时错误时重试模型请求。')
  await desktop.page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(row().locator('.n-tabs-capsule')).toHaveCSS('transition-duration', '0s')
  await select('禁用')
  await expect.poll(limit).toBe(0)
  await expectCapsuleAligned()
  await select('无限')
  await expect.poll(limit).toBe('unlimited')
  await expectCapsuleAligned()
  await desktop.page.emulateMedia({ reducedMotion: 'no-preference' })
  await desktop.page.getByTestId('cache-warming-setting').locator('.n-select').click()
  await desktop.page.locator('.n-base-select-menu').getByText('任务执行期间', { exact: true }).click()
  await expect.poll(() => desktop.page.evaluate(async () => (await window.lexoraDesktop.settings.get()).runtime)).toEqual({ cacheWarming: 'streaming', codemode: false, modelRetryLimit: 'unlimited' })
  await desktop.page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-settings-light.png'), animations: 'disabled' })
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: 'dark' } }))
  await expect(desktop.page.locator('.buddy-app')).toHaveClass(/is-dark/)
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(980, 680))
  await desktop.page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-settings-dark.png'), animations: 'disabled' })
  await instance.stop()
  desktop = await instance.launch()
  await openSettings(desktop.page)
  await desktop.page.locator('.desktop-settings-sidebar').getByRole('link', { name: '运行时', exact: true }).click()
  await expect(mode('无限')).toHaveAttribute('aria-pressed', 'true')
  await expect(countRow()).toHaveCount(0)
  expect(await limit()).toBe('unlimited')
  await select('次数')
  await expect(input()).toHaveValue('3')
  await input().fill('5')
  await input().press('Tab')
  await expect.poll(limit).toBe(5)
  await expect(input()).toBeEnabled()
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(980, 680))
  await expect.poll(() => desktop.page.evaluate(() => window.innerWidth)).toBe(980)
  await expectCapsuleAligned()
  await desktop.page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-settings-finite-dark-narrow.png'), animations: 'disabled' })
  await select('禁用')
  await expect.poll(limit).toBe(0)
  await expect(countRow()).toHaveCount(0)
  expect(await fs.readFile(path.join(instance.home, 'config.toml'), 'utf8')).toContain('model_retry_limit = 0')
  await desktop.app.evaluate(({ ipcMain }) => {
    const gate = new Promise(resolve => globalThis.releaseRetrySettingFailure = resolve)
    ipcMain.removeHandler('lexora:settings:update')
    ipcMain.handle('lexora:settings:update', async () => {
      await gate
      throw new Error('Isolated retry-setting save failure')
    })
  })
  await select('次数')
  try {
    await expect(mode('次数')).toHaveAttribute('aria-pressed', 'true')
    await expect(mode('无限')).toBeDisabled()
    await expect(input()).toHaveValue('3')
    await expect(input()).toBeDisabled()
    expect(await limit()).toBe(0)
  }
  finally {
    await desktop.app.evaluate(() => globalThis.releaseRetrySettingFailure())
  }
  await expect(desktop.page.getByText('保存失败，已恢复原设置', { exact: true })).toBeVisible()
  await expect(mode('禁用')).toHaveAttribute('aria-pressed', 'true')
  await expect(mode('次数')).toBeEnabled()
  await expectCapsuleAligned()
  await expect(countRow()).toHaveCount(0)
  expect(await limit()).toBe(0)
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

async function openSettings(page) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.desktop-settings-sidebar').getByRole('link', { name: '常规', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings\/general$/)
}
function panelSettings(page) {
  return page.evaluate(async () => {
    const { desktop } = await window.lexoraDesktop.settings.get()
    return { global: desktop.contextPanelGlobal, mode: desktop.contextPanelMode }
  })
}
async function writeSettingsPlugin(directory, conditional = false) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'extension.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'tests.settings',
    name: '注册设置',
    version: '1.0.0',
    apiVersion: 3,
    engines: { lexora: '*' },
    entry: 'extension.js',
    contributes: { conditions: conditional ? [{ id: 'tests.settings.available', inputs: ['form'] }] : [], commands: [{ id: 'tests.settings.open', title: 'Open fixture' }], views: [{ id: 'tests.settings.view', title: 'Fixture view', resource: 'none', entry: 'view.js' }], settings: {
      modules: [{ id: 'tests.settings.module', title: '注册设置' }],
      groups: [
        { id: 'tests.settings.group', module: 'tests.settings.module', title: '插件分组' },
        { id: 'tests.settings.extra', module: 'settings.general', title: '附加分组', order: 5 },
        { id: 'tests.settings.logs', module: 'settings.logs', title: '日志附加分组' },
      ],
      items: [
        { id: 'tests.settings.enabled', key: 'enabled', group: 'tests.settings.group', type: 'boolean', title: '启用', default: false },
        { id: 'tests.settings.label', key: 'label', group: 'tests.settings.group', type: 'string', title: '名称', default: '', ...(conditional ? { enabledWhen: { condition: 'tests.settings.available' } } : {}) },
        { id: 'tests.settings.inline', key: 'inline', group: 'settings.general.general', type: 'boolean', title: '分组内单项', default: false },
        { id: 'tests.settings.extra-item', key: 'extra', group: 'tests.settings.extra', type: 'number', title: '数值', default: 0 },
        { id: 'tests.settings.logs-item', key: 'log', group: 'tests.settings.logs', type: 'boolean', title: '日志附加项', default: false },
      ],
    } },
  }))
  await fs.writeFile(path.join(directory, 'extension.js'), `export function activate(context) { ${conditional ? 'context.conditions.register(\'tests.settings.available\', () => true);' : ''} context.commands.register('tests.settings.open', async () => { await context.storage.set({ retained: true }); await context.views.open('tests.settings.view', { state: { position: 17 } }); }); }\n`)
  await fs.writeFile(path.join(directory, 'view.js'), 'export function render(context, container) { container.textContent = "Fixture view"; }\n')
}

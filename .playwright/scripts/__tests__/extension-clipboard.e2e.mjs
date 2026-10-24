import { expect, test } from '../fixtures/electron.mjs'
import { clipboardProbeId, writeClipboardProbe } from '../fixtures/extension-clipboard.mjs'

async function install(app, page, plugin, granted) {
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { featureAnnouncementsEnabled: false } }))
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] })
  }, plugin.archive)
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-install').click()
  const review = page.getByTestId('extension-install-review')
  await expect(review).toBeVisible()
  if (granted) {
    await expect(review.getByText('读取系统剪贴板', { exact: true })).toBeVisible()
    await expect(review.getByText('写入系统剪贴板', { exact: true })).toBeVisible()
  }
  await review.getByTestId('extension-confirm-install').click()
  await expect(review).toBeHidden()
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id)?.enabled, plugin.id)).toBe(true)
}

async function frameWithProbe(page) {
  let frame
  await expect.poll(async () => {
    frame = page.frames().find(item => item.url().startsWith('lexora-extension:') && !item.isDetached())
    return frame && await frame.locator('[data-clipboard-probe][data-ready="true"]').isVisible().catch(() => false)
  }).toBe(true)
  return frame
}

async function activateProbe(frame, name, operation) {
  const button = frame.getByRole('button', { name, exact: true })
  await button.focus()
  await expect(button).toBeFocused()
  await expect.poll(() => frame.evaluate(() => document.hasFocus())).toBe(true)
  await expect.poll(async () => {
    await button.hover()
    return button.evaluate(element => element.matches(':hover'))
  }).toBe(true)
  await button.click()
  await expect(frame.getByRole('status')).toContainText(`"operation":"${operation}"`)
}

for (const granted of [true, false]) {
  test(`plugin clipboard ${granted ? 'preserves rich content in a focused view and denies unfocused access' : 'denies reads and writes without declared permissions'}`, async ({ buddy }, testInfo) => {
    const plugin = await writeClipboardProbe(testInfo.outputPath('packages'), granted)
    const instance = await buddy.createInstance('extension-clipboard')
    const { app, page } = await instance.launch()
    await install(app, page, plugin, granted)
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '剪贴板验收', exact: true }).click()
    const frame = await frameWithProbe(page)
    await app.evaluate(({ clipboard }) => clipboard.writeText('保留原始剪贴板'))
    const window = await app.browserWindow(page)
    await window.evaluate(window => window.focus())
    await window.dispose()
    await activateProbe(frame, '写入剪贴板', 'write')
    const status = frame.getByRole('status')
    await expect(status).toContainText(`"ok":${granted}`)
    if (!granted) {
      await expect(status).toContainText('EXTENSION_METHOD_DENIED')
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('保留原始剪贴板')
      await activateProbe(frame, '读取剪贴板', 'read')
      await expect(status).toContainText('"ok":false')
      await expect(status).toContainText('EXTENSION_METHOD_DENIED')
      await expect(status).not.toContainText('保留原始剪贴板')
      return
    }
    const written = await app.evaluate(async ({ clipboard }) => {
      const [item] = await clipboard.read()
      return { text: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() }
    })
    expect(written.text).toBe('季度计划\t42')
    expect(written.html).toContain('data-copy-id="fixture-copy"')
    expect(written.html).toContain('<b>季度计划</b>')
    await app.evaluate(({ clipboard, ClipboardItem }) => clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['外部内容\t18'], { type: 'text/plain' }), 'text/html': new Blob(['<table><tr><td>外部内容</td><td>18</td></tr></table>'], { type: 'text/html' }) })]))
    await activateProbe(frame, '读取剪贴板', 'read')
    await expect(status).toContainText('外部内容')
    await expect(status).toContainText('<table>')
    const native = await frame.evaluate(async () => {
      try {
        await navigator.clipboard.readText()
        return 'allowed'
      }
      catch {
        return 'denied'
      }
    })
    expect(native).toBe('denied')
    expect(await frame.evaluate(() => ({ origin, node: typeof process, desktop: typeof window.lexoraDesktop }))).toEqual({ origin: 'null', node: 'undefined', desktop: 'undefined' })
    await page.evaluate(() => {
      document.body.tabIndex = -1
      document.body.focus()
    })
    expect(await frame.evaluate(() => globalThis.clipboardProbe.read())).toMatchObject({ ok: false })
    expect(await frame.evaluate(() => globalThis.clipboardProbe.write())).toMatchObject({ ok: false })
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('外部内容\t18')
    await activateProbe(frame, '读取剪贴板', 'read')
    await expect(status).toContainText('外部内容')
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
    await page.evaluate(id => window.lexoraDesktop.extensions.executeSlash(id, `${id}.open`, ''), clipboardProbeId)
    const editor = await frameWithProbe(page)
    await activateProbe(editor, '更新文件信息', 'title')
    await expect(editor.getByRole('status')).toContainText('"ok":true')
    await expect(page.locator('.desktop-task-context-panel__tab.is-active')).toContainText('季度计划.xlsx')
    await page.screenshot({ path: testInfo.outputPath('clipboard-document-info.png') })
    await editor.evaluate(() => {
      globalThis.clipboardProbe.installCloseGuard()
    })
    await page.locator('.desktop-task-context-panel__tab.is-active').getByRole('button', { name: /关闭/ }).click()
    await expect(page.getByRole('tab', { name: /季度计划.xlsx/ })).toHaveCount(0)

    await page.evaluate(id => window.lexoraDesktop.extensions.executeSlash(id, `${id}.open`, ''), clipboardProbeId)
    const saving = await frameWithProbe(page)
    await saving.evaluate(() => {
      globalThis.clipboardProbe.installCloseGuard(6000)
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    const exited = app.waitForEvent('close', { timeout: 20000 })
    await app.evaluate(({ app }) => {
      app.quit()
    })
    await exited
  })
}

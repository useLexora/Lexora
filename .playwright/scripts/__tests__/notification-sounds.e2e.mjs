import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

async function openSounds(page) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.desktop-settings-sidebar').getByRole('link', { name: '通知', exact: true }).click()
  await expect(page.locator('.desktop-notification-sound-settings')).toBeVisible()
  return page.locator('.desktop-notification-sound-settings')
}

const readPreferences = page => page.evaluate(async () => (await window.lexoraDesktop.settings.get()).desktop.notificationSound)

function wave(seconds) {
  const rate = 24000
  const bytes = Buffer.alloc(44 + rate * seconds * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  return bytes
}

async function pickFile(app, file) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
}

test('notification sounds preserve defaults, selection and volume and can preview while notifications are disabled', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('notification-sounds')
  let desktop = await instance.launch()
  let panel = await openSounds(desktop.page)
  expect(await readPreferences(desktop.page)).toEqual({ selected: 'system', volume: 0.6, sounds: [] })
  await expect(panel.locator('[data-sound-id="system"] input')).toBeChecked()
  await desktop.page.getByRole('switch', { name: '系统通知', exact: true }).click()
  await expect(panel.locator('[data-sound-id="bell"] input')).toBeEnabled()
  await panel.locator('[data-sound-id="bell"]').getByText('简洁提示', { exact: true }).click()
  await expect.poll(() => readPreferences(desktop.page)).toEqual({ selected: 'bell', volume: 0.6, sounds: [] })
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { notificationSound: { volume: 0 } } }))
  for (const [id, durationMs] of [['bell', 817], ['drop', 1561], ['ambient', 3159]]) {
    expect(await desktop.page.evaluate(id => window.lexoraDesktop.notificationSounds.preview(id), id)).toEqual({ durationMs })
    await desktop.page.evaluate(() => window.lexoraDesktop.notificationSounds.stopPreview())
  }
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { notificationsEnabled: false } }))
  await expect(panel.getByRole('radio').first()).toBeDisabled()
  await expect(panel.locator('[data-sound-id="drop"]').getByRole('button', { name: '试听', exact: true })).toBeEnabled()
  expect(await desktop.page.evaluate(() => window.lexoraDesktop.notificationSounds.preview('drop'))).toEqual({ durationMs: 1561 })
  await desktop.page.evaluate(() => window.lexoraDesktop.notificationSounds.stopPreview())
  const mainWindow = await desktop.app.browserWindow(desktop.page)
  await mainWindow.evaluate(window => window.setSize(980, 640))
  await desktop.page.screenshot({ path: testInfo.outputPath('notification-sounds-narrow.png') })
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await instance.stop()
  desktop = await instance.launch()
  panel = await openSounds(desktop.page)
  expect(await readPreferences(desktop.page)).toEqual({ selected: 'bell', volume: 0, sounds: [] })
  await expect(panel.locator('[data-sound-id="bell"] input')).toBeChecked()
  await desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { notificationsEnabled: true } }))
  await expect(panel.getByRole('radio').first()).toBeEnabled()
  await expect(desktop.page.getByRole('switch', { name: '系统通知', exact: true })).toBeChecked()
  const restoredWindow = await desktop.app.browserWindow(desktop.page)
  await restoredWindow.evaluate(window => window.setSize(1280, 820))
  await panel.getByRole('slider').focus()
  await desktop.page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await readPreferences(desktop.page)).volume).toBe(0.01)
  await desktop.page.screenshot({ path: testInfo.outputPath('notification-sounds-settings.png'), animations: 'disabled' })
  await desktop.page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id: 'lexora.themes.classic-dark' } }))
  await expect(desktop.page.locator('html')).toHaveAttribute('data-buddy-theme', 'dark')
  await expect(panel.locator('[data-sound-id="bell"] input')).toBeChecked()
  await desktop.page.screenshot({ path: testInfo.outputPath('notification-sounds-dark.png'), animations: 'disabled' })
})

test('a reloaded settings renderer cannot resume its delayed audio preview', async ({ buddy }) => {
  const instance = await buddy.createInstance('notification-preview-owner')
  const { app, page } = await instance.launch()
  await openSounds(page)
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { notificationSound: { volume: 0 } } }))
  await page.evaluate(() => window.lexoraDesktop.notificationSounds.preview('bell'))
  await page.evaluate(() => window.lexoraDesktop.notificationSounds.stopPreview())
  await app.evaluate(async ({ BrowserWindow }) => {
    const audio = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Lexora notification audio').webContents
    globalThis.notificationAudioProbe = audio
    await audio.executeJavaScript(`
      globalThis.previewGate = Promise.withResolvers();
      globalThis.previewPrepared = false;
      globalThis.previewReleased = false;
      globalThis.startedPreviews = 0;
      const originalPrepare = notificationAudio.prepare.bind(notificationAudio);
      const originalStart = notificationAudio.start.bind(notificationAudio);
      notificationAudio.prepare = async input => {
        const result = await originalPrepare(input);
        previewPrepared = true;
        await previewGate.promise;
        previewReleased = true;
        return result;
      };
      notificationAudio.start = token => {
        const started = originalStart(token);
        if (started) startedPreviews++;
        return started;
      };
      void 0;
    `)
  })
  await page.evaluate(() => {
    void window.lexoraDesktop.notificationSounds.preview('bell').catch(() => {})
  })
  await expect.poll(() => app.evaluate(() => globalThis.notificationAudioProbe.executeJavaScript('previewPrepared'))).toBe(true)
  await page.reload()
  await expect(page.locator('.desktop-notification-sound-settings')).toBeVisible()
  await app.evaluate(() => globalThis.notificationAudioProbe.executeJavaScript('previewGate.resolve()'))
  await expect.poll(() => app.evaluate(() => globalThis.notificationAudioProbe.executeJavaScript('previewReleased'))).toBe(true)
  expect(await app.evaluate(() => globalThis.notificationAudioProbe.executeJavaScript('startedPreviews'))).toBe(0)
  expect(await page.evaluate(() => window.lexoraDesktop.notificationSounds.preview('drop'))).toEqual({ durationMs: 1561 })
  expect(await app.evaluate(() => globalThis.notificationAudioProbe.executeJavaScript('startedPreviews'))).toBe(1)
  await page.evaluate(() => window.lexoraDesktop.notificationSounds.stopPreview())
})

test('notification audio imports validated owned copies, survives source removal and restart, and safely removes the selected asset', async ({ buddy }) => {
  const instance = await buddy.createInstance('notification-sound-import')
  let desktop = await instance.launch()
  await openSounds(desktop.page)
  const file = path.join(instance.home, 'custom.wav')
  await fs.writeFile(file, wave(1))
  await pickFile(desktop.app, file)
  const imported = await desktop.page.evaluate(() => window.lexoraDesktop.notificationSounds.import())
  expect(imported.status).toBe('imported')
  const id = imported.id
  expect(await readPreferences(desktop.page)).toEqual({ selected: 'system', volume: 0.6, sounds: [{ id, name: 'custom.wav', mimeType: 'audio/wav', durationMs: 1000 }] })
  await fs.unlink(file)
  await desktop.page.evaluate(id => window.lexoraDesktop.settings.update({ desktop: { notificationSound: { selected: id, volume: 0 } } }), id)
  expect(await desktop.page.evaluate(id => window.lexoraDesktop.notificationSounds.preview(id), id)).toEqual({ durationMs: 1000 })
  await desktop.page.evaluate(() => window.lexoraDesktop.notificationSounds.stopPreview())
  const before = await readPreferences(desktop.page)
  for (const [content, reason] of [[Buffer.from('not audio'), 'type'], [wave(11), 'duration'], [Buffer.alloc(5 * 1024 * 1024 + 1), 'size']]) {
    await fs.writeFile(file, content)
    await pickFile(desktop.app, file)
    expect(await desktop.page.evaluate(() => window.lexoraDesktop.notificationSounds.import())).toEqual({ status: 'failed', reason })
    expect(await readPreferences(desktop.page)).toEqual(before)
  }
  await expect(desktop.page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { notificationSound: { sounds: [] } } }))).rejects.toThrow()
  await expect(desktop.page.evaluate(() => window.lexoraDesktop.notificationSounds.remove('../outside'))).rejects.toThrow()
  await instance.stop()
  desktop = await instance.launch()
  const panel = await openSounds(desktop.page)
  const row = panel.locator(`[data-sound-id="${id}"]`)
  await expect(row.getByRole('radio')).toBeChecked()
  await expect(row).toContainText('custom.wav')
  expect(await desktop.page.evaluate(id => window.lexoraDesktop.notificationSounds.preview(id), id)).toEqual({ durationMs: 1000 })
  await desktop.page.evaluate(() => window.lexoraDesktop.notificationSounds.stopPreview())
  await row.getByRole('button', { name: '删除', exact: true }).click()
  await desktop.page.locator('.n-popconfirm').getByRole('button', { name: '删除', exact: true }).click()
  await expect(row).toHaveCount(0)
  expect(await readPreferences(desktop.page)).toEqual({ selected: 'system', volume: 0, sounds: [] })
  await expect(fs.access(path.join(instance.home, 'buddy/notification-sounds', `${id}.audio`))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('test notifications bypass automatic suppression, preserve settings and report delivery failures', async ({ buddy }, testInfo) => {
  testInfo.annotations.push({ type: 'coverage', description: 'Real renderer, preload, main Notification object and audio decoder; native delivery callbacks are controlled at Notification.show.' })
  const instance = await buddy.createInstance('test-notifications')
  const { app, page, diagnostics } = await instance.launch()
  await openSounds(page)
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: {
    notificationsEnabled: false,
    notifyWhenFocused: false,
    notificationSound: { selected: 'system', volume: 0.6 },
  } }))
  const settings = () => page.evaluate(async () => (await window.lexoraDesktop.settings.get()).desktop)
  const before = await settings()
  await app.evaluate(({ Notification }) => {
    globalThis.testNotificationTransport = { mode: 'show', delivered: [] }
    Notification.isSupported = () => true
    Notification.prototype.show = function () {
      const transport = globalThis.testNotificationTransport
      transport.delivered.push({ title: this.title, body: this.body, silent: this.silent })
      if (transport.mode === 'throw')
        throw new Error('Synthetic notification delivery failure')
      this.emit(transport.mode)
    }
  })
  const button = page.getByRole('button', { name: '测试通知', exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  await expect(page.locator('.n-message').filter({ hasText: '已发送测试通知' })).toHaveCount(1)
  expect(await settings()).toEqual(before)
  expect(await app.evaluate(() => globalThis.testNotificationTransport.delivered)).toEqual([{
    title: 'Lexora · 测试通知',
    body: '这是一条测试通知，用于确认通知横幅与提示音。',
    silent: false,
  }])
  await app.evaluate(() => {
    globalThis.testNotificationTransport.mode = 'failed'
  })
  await button.click()
  await expect(page.locator('.n-message').filter({ hasText: '未能确认测试通知已送达' })).toHaveCount(1)
  await expect(button).toBeEnabled()
  expect(await settings()).toEqual(before)
  await app.evaluate(({ Notification }) => {
    Notification.isSupported = () => false
  })
  await button.click()
  await expect(page.locator('.n-message').filter({ hasText: '当前系统不支持桌面通知' })).toHaveCount(1)
  expect(await app.evaluate(() => globalThis.testNotificationTransport.delivered.length)).toBe(2)
  await app.evaluate(({ Notification }) => {
    Notification.isSupported = () => true
    globalThis.testNotificationTransport.mode = 'show'
  })
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { notificationSound: { selected: 'ambient', volume: 0.01 } } }))
  const changed = await settings()
  await button.click()
  expect(await app.evaluate(() => globalThis.testNotificationTransport.delivered.at(-1).silent)).toBe(true)
  await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => {
    const audio = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Lexora notification audio')
    return audio ? await audio.webContents.executeJavaScript('typeof notificationAudio.start') : null
  })).toBe('function')
  expect(await settings()).toEqual(changed)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

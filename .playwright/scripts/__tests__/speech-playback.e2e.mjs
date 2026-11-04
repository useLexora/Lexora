import path from 'node:path'
import process from 'node:process'
import { expect, test } from '../fixtures/electron.mjs'

test('reply speech can be cancelled, stopped and retried without disrupting the composer', async ({ buddy }) => {
  const instance = await buddy.createInstance('speech-playback')
  const desktop = await instance.launch()
  const { page, app } = desktop
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('lexora:speech:prepare-system')
    ipcMain.handle('lexora:speech:prepare-system', () => true)
  })
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: {
    featureAnnouncementsEnabled: false,
    speech: { outputEnabled: true, output: 'system' },
  } }))
  await page.addInitScript(() => {
    let utterance
    window.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text }
    }
    const voice = { voiceURI: 'fixture-local', name: 'Fixture voice', lang: 'zh-CN', localService: true, default: true }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [voice],
      addEventListener() {},
      removeEventListener() {},
      speak(value) { utterance = value },
      cancel() { utterance = undefined },
    } })
    window.speechFixture = {
      ready() { return !!utterance },
      start() { utterance?.onstart?.(new Event('start')) },
      finish() { utterance?.onend?.(new Event('end')) },
      fail() { utterance?.onerror?.({ error: 'synthesis-failed' }) },
    }
  })
  await seedSpeechTask(page, app, instance)
  await page.reload()
  await page.locator('[data-task-id="speech-task"] .desktop-task-sidebar__task').click()
  const reply = page.locator('[data-message-id="speech-answer"]')
  const icon = reply.locator('.speech-read-aloud')
  const button = page.getByTestId('speech-read-message-speech-answer')
  const editor = page.locator('.desktop-chat-composer__prosemirror:visible')
  const composer = page.locator('.desktop-chat-composer:visible')
  await editor.fill('保留正在输入的内容')
  await reply.hover()
  const initialButton = await button.boundingBox()
  const initialComposer = await composer.boundingBox()
  await button.click()
  await expect(icon).toHaveAttribute('data-speech-phase', 'preparing')
  await expect(page.getByText('正在准备语音 · 点击取消', { exact: true })).toBeVisible()
  expect(await button.boundingBox()).toEqual(initialButton)
  expect(await composer.boundingBox()).toEqual(initialComposer)

  await button.click()
  await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
  await button.click()
  await expect.poll(() => page.evaluate(() => window.speechFixture.ready())).toBe(true)
  await page.evaluate(() => window.speechFixture.start())
  await expect(icon).toHaveAttribute('data-speech-phase', 'playing')
  await expect(page.getByText('正在朗读 · 点击停止', { exact: true })).toBeVisible()
  await editor.click()
  await page.mouse.move(5, 5)
  await expect(reply.locator('.buddy-chat-message__actions')).toHaveCSS('opacity', '1')
  expect(await button.boundingBox()).toEqual(initialButton)
  expect(await composer.boundingBox()).toEqual(initialComposer)
  await expect(editor).toHaveText('保留正在输入的内容')
  await button.click()
  await expect(icon).toHaveAttribute('data-speech-phase', 'idle')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await reply.hover()
  await button.focus()
  await expect(page.getByText('朗读回复', { exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(icon.locator('.speech-read-aloud__spinner')).toHaveCSS('animation-name', 'none')
  await expect.poll(() => page.evaluate(() => window.speechFixture.ready())).toBe(true)
  await page.evaluate(() => window.speechFixture.start())
  await expect(icon.locator('.speech-read-aloud__waves path').first()).toHaveCSS('animation-name', 'none')
  await page.evaluate(() => window.speechFixture.finish())
  await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
  await button.click()
  await expect.poll(() => page.evaluate(() => window.speechFixture.ready())).toBe(true)
  await page.evaluate(() => window.speechFixture.fail())
  await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
  await expect(page.getByText('朗读已中断，请检查模型服务和音频设备后重试。', { exact: true })).toBeVisible()
  await expect(button).toBeEnabled()
  await button.click()
  await expect(icon).toHaveAttribute('data-speech-phase', 'preparing')
  await button.click()
  await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
})

async function seedSpeechTask(page, app, instance) {
  await page.evaluate(() => window.lexoraDesktop.localChat.conversations.list(1))
  await app.evaluate((_electron, databasePath) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const now = new Date().toISOString()
      db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('speech-task', '朗读图标验收', 'speech-branch', now, now)
      db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('speech-branch', 'speech-task', now)
      db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('speech-answer', 'speech-task', 'speech-branch', 'assistant', JSON.stringify({ text: '这是一条用于验证朗读交互的回复。准备时保留扬声器，播放时声波轻轻律动。你可以边听边输入，点击同一个图标即可停止。' }), now)
    }
    finally { db.close() }
  }, path.join(instance.home, 'buddy/buddy.sqlite3'))
}

test('missing Linux speech service stays unavailable without crashing during startup or playback', async ({ buddy }) => {
  test.skip(process.platform !== 'linux', 'Speech Dispatcher is the Linux system backend')
  const instance = await buddy.createInstance('speech-unavailable')
  const { page, app, diagnostics } = await instance.launch()
  await app.evaluate((_electron, root) => {
    process.env.SPEECHD_ADDRESS = `unix_socket:${root}/missing-speech.sock`
    process.env.SPEECHD_CMD = `${root}/missing-speech-dispatcher`
  }, instance.home)
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { speech: { outputEnabled: true, output: 'system' } } }))
  await seedSpeechTask(page, app, instance)
  await page.reload()
  await page.locator('[data-task-id="speech-task"] .desktop-task-sidebar__task').click()
  const button = page.getByTestId('speech-read-message-speech-answer')
  await expect(button).toBeEnabled()
  await page.locator('[data-message-id="speech-answer"]').hover()
  await button.click()
  await expect(button).toHaveAttribute('aria-label', '暂无系统声音，请选择其他朗读方式。')
  expect((await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.desktop-settings-sidebar').getByRole('link', { name: '语音', exact: true }).click()
  const output = page.getByTestId('speech-output-settings')
  await expect(output.getByText('暂无系统声音，请选择其他朗读方式。', { exact: true })).toBeVisible()
  await expect(output.getByRole('button', { name: '试听', exact: true })).toBeDisabled()
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

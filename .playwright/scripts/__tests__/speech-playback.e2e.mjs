import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

test('reply speech stays in one icon without changing the composer layout', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('speech-playback')
  const desktop = await instance.launch()
  const { page, app } = desktop
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
      start() { utterance?.onstart?.(new Event('start')) },
      finish() { utterance?.onend?.(new Event('end')) },
      fail() { utterance?.onerror?.({ error: 'synthesis-failed' }) },
    }
  })
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
  await page.reload()
  await page.locator('[data-task-id="speech-task"] .desktop-task-sidebar__task').click()
  const reply = page.locator('[data-message-id="speech-answer"]')
  const icon = reply.locator('.speech-read-aloud')
  const button = page.getByTestId('speech-read-message-speech-answer')
  const editor = page.locator('.desktop-chat-composer__prosemirror:visible')
  const composer = page.locator('.desktop-chat-composer:visible')
  await editor.fill('保留正在输入的内容')
  for (const [theme, width] of [['light', 1200], ['dark', 900]]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), width)
    await page.evaluate(id => window.lexoraDesktop.settings.update({ desktop: { theme: { id } } }), `lexora.themes.classic-${theme}`)
    await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', theme)
    await reply.hover()
    const initialButton = await button.boundingBox()
    const initialComposer = await composer.boundingBox()
    await button.click()
    await expect(icon).toHaveAttribute('data-speech-phase', 'preparing')
    await expect(page.getByText('正在准备语音 · 点击取消', { exact: true })).toBeVisible()
    await expect(icon.locator('.speech-read-aloud__spinner')).toHaveCount(1)
    await expect(icon.locator('svg > path')).toHaveCount(1)
    expect(await button.boundingBox()).toEqual(initialButton)
    expect(await composer.boundingBox()).toEqual(initialComposer)
    await page.screenshot({ path: testInfo.outputPath(`speech-${theme}-preparing.png`) })

    await button.click()
    await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
    await button.click()
    await page.evaluate(() => window.speechFixture.start())
    await expect(icon).toHaveAttribute('data-speech-phase', 'playing')
    await expect(page.getByText('正在朗读 · 点击停止', { exact: true })).toBeVisible()
    await expect(icon.locator('.speech-read-aloud__waves')).toHaveCount(1)
    await editor.click()
    await page.mouse.move(5, 5)
    await expect(reply.locator('.buddy-chat-message__actions')).toHaveCSS('opacity', '1')
    expect(await button.boundingBox()).toEqual(initialButton)
    expect(await composer.boundingBox()).toEqual(initialComposer)
    await expect(editor).toHaveText('保留正在输入的内容')
    await expect(page.getByTestId('speech-playback-status')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`speech-${theme}-playing.png`) })
    await button.click()
    await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
  }

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await reply.hover()
  await button.focus()
  await expect(page.getByText('朗读回复', { exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(icon.locator('.speech-read-aloud__spinner')).toHaveCSS('animation-name', 'none')
  await page.evaluate(() => window.speechFixture.start())
  await expect(icon.locator('.speech-read-aloud__waves path').first()).toHaveCSS('animation-name', 'none')
  await page.evaluate(() => window.speechFixture.finish())
  await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
  await button.click()
  await page.evaluate(() => window.speechFixture.fail())
  await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
  await expect(page.getByText('朗读已中断，请检查模型服务和音频设备后重试。', { exact: true })).toBeVisible()
  await expect(button).toBeEnabled()
  await button.click()
  await expect(icon).toHaveAttribute('data-speech-phase', 'preparing')
  await button.click()
  await expect(icon).toHaveAttribute('data-speech-phase', 'idle')
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures/electron.mjs'

test('first send with a browser reference preserves the open resource panel and guest, and later sends keep it open', async ({ buddy }) => {
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Panel adoption fixture</title><button id="picked" style="margin:40px;padding:24px" onclick="window.clicked=true">Frozen browser text</button>')
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const common = { id: `panel-${requests.length}`, model: 'panel-fixture', object: 'chat.completion.chunk', created: 1 }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture reply.' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const instance = await buddy.createInstance('panel-draft-adoption')
  try {
    const { app, page, diagnostics } = await instance.launch()
    // Dummy credentials are confined to the isolated Test profile; never read the OS keychain.
    await app.evaluate(({ app, safeStorage }) => {
      if (app.getName() !== 'Lexora Buddy Test')
        throw new Error('Synthetic credentials require an isolated test instance')
      Object.defineProperties(safeStorage, {
        isEncryptionAvailable: { configurable: true, value: () => true },
        getSelectedStorageBackend: { configurable: true, value: () => 'offline-fixture' },
        encryptString: { configurable: true, value: value => Buffer.from(`offline-fixture:${value}`) },
        decryptString: { configurable: true, value: (value) => {
          const serialized = value.toString('utf8')
          if (!serialized.startsWith('offline-fixture:'))
            throw new Error('Unexpected credential in isolated fixture')
          return serialized.slice('offline-fixture:'.length)
        } },
      })
    })
    await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
    const origin = `http://127.0.0.1:${server.address().port}`
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ desktop: { contextPanelMode: 'task' } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'panel-fixture', displayName: 'Panel fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'panel-fixture', name: 'Panel fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'panel-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('panel-fixture', 'api_key')
      }
      finally {
        stop()
      }
      await providers.setDefaultModel({ providerId: 'panel-fixture', modelId: 'panel-fixture', reasoning: null })
    }, `${origin}/v1`)
    await page.reload()
    const input = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
    await expect(input).toBeVisible()
    await input.fill('Keep the browser open after sending.')
    await page.keyboard.press('Control+Shift+P')
    await page.getByPlaceholder('输入命令名称').fill('浏览器')
    await page.getByPlaceholder('输入命令名称').press('Enter')
    const address = page.getByTestId('browser-address')
    await address.fill(`${origin}/page`)
    await address.press('Enter')
    const pick = page.getByTestId('browser-pick-element')
    await expect(pick).toBeEnabled()
    await pick.click()
    await expect.poll(() => app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
      return guest?.executeJavaScript('Boolean(document.querySelector("[data-lexora-element-picker]"))')
    }, `${origin}/page`)).toBe(true)
    await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
      const point = await guest.executeJavaScript('(() => { const r = document.querySelector("#picked").getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()')
      const x = Math.round(point.x * guest.getZoomFactor())
      const y = Math.round(point.y * guest.getZoomFactor())
      guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y })
      guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y })
    }, `${origin}/page`)
    await expect(page.locator('.desktop-chat-composer-wrap .resource-quote-card')).toHaveCount(1)
    const before = await page.evaluate(() => window.lexoraDesktop.browser.listGuests())
    const toggle = page.getByTestId('context-panel-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await input.click()
    await expect(address).toBeVisible()
    const send = page.getByRole('button', { name: '发送消息', exact: true })
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => completedRuns(instance.home)).toBe(1)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(address).toBeVisible()
    await expect(address).toHaveValue(`${origin}/page`)
    expect(await page.evaluate(() => window.lexoraDesktop.browser.listGuests())).toEqual(before)
    expect(JSON.stringify(requests[0].messages)).toContain('Frozen browser text')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'panel-after-first-send.png'), animations: 'disabled' })
    await input.fill('Keep the same panel open on the next send too.')
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => completedRuns(instance.home)).toBe(2)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(address).toBeVisible()
    expect(await page.evaluate(() => window.lexoraDesktop.browser.listGuests())).toEqual(before)
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

function completedRuns(home) {
  const database = new DatabaseSync(path.join(home, 'buddy/buddy.sqlite3'), { readOnly: true })
  try {
    return database.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count
  }
  finally {
    database.close()
  }
}

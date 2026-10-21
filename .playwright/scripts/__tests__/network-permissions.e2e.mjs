import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

test('real network requests enforce saved access, file download, redirects and manual takeover', async ({ buddy }, testInfo) => {
  const requests = []
  const hits = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      const pathname = new URL(request.url, 'http://permission.example.test').pathname
      hits.push(pathname)
      if (pathname === '/redirect') {
        response.writeHead(302, { location: 'http://redirect.example.test/landing' }).end()
        return
      }
      if (pathname === '/landing') {
        response.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Redirect fixture</title><link rel="icon" href="data:,"></head><body>Redirected page<img src="http://blocked.example.test/pixel"></body></html>')
        return
      }
      const file = pathname === '/file'
      response.writeHead(200, file
        ? { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.txt"' }
        : { 'content-type': 'text/html' })
      response.end(file ? 'File permission fixture.' : '<html><head><title>Permission fixture</title></head><body><article>A local page used to verify domain access permissions.</article></body></html>')
      return
    }
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(payload)
    const userIndex = payload.messages.findLastIndex(message => message.role === 'user')
    const input = JSON.stringify(payload.messages[userIndex]?.content)
    const targetTool = input.includes('browser') ? 'lexora_browser_open' : 'lexora_web_fetch'
    const fetched = payload.messages.slice(userIndex + 1).some(message => message.tool_calls?.some(tool => tool.function?.name === targetTool))
    const available = payload.tools.some(tool => tool.function?.name === targetTool)
    const tool = fetched ? null : available ? targetTool : 'lexora_tool_search'
    const args = tool === 'lexora_tool_search'
      ? { query: targetTool }
      : { ...(targetTool === 'lexora_browser_open' ? { kind: 'url' } : {}), url: `http://permission.example.test/${input.includes('browser') ? 'redirect' : input.includes('file') ? 'file' : 'page'}?request=${requests.length}` }
    const common = { id: `permission-${requests.length}`, model: 'permission-fixture', object: 'chat.completion.chunk', created: 1 }
    const delta = tool
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `permission-call-${requests.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: 'Permission fixture completed.' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('network-approval')
  try {
    const desktop = await instance.launch()
    await useSyntheticCredentialStorage(desktop)
    await desktop.page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'permission-fixture', displayName: 'Permission fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'permission-fixture', name: 'Permission fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'permission-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('permission-fixture', 'api_key')
      }
      finally {
        stop()
      }
      await providers.setDefaultModel({ providerId: 'permission-fixture', modelId: 'permission-fixture', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await desktop.page.evaluate(server => window.lexoraDesktop.settings.update({ proxy: { mode: 'custom', server } }), `http://127.0.0.1:${server.address().port}`)
    await desktop.page.reload()
    const send = async (text) => {
      await desktop.page.locator('.desktop-chat-composer__prosemirror:visible').fill(text)
      await desktop.page.getByRole('button', { name: '发送消息', exact: true }).click()
    }
    const completed = () => {
      const db = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
      try {
        return db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status=\'completed\'').get().count
      }
      finally {
        db.close()
      }
    }
    const card = desktop.page.locator('.desktop-approval-card')
    const settings = () => desktop.page.evaluate(async () => (await window.lexoraDesktop.settings.get()).browser.networkPermissions)

    await send('Fetch the first page.')
    await expect(card).toContainText('permission.example.test')
    await expect(card).toContainText('所有空间和任务')
    expect(hits).toEqual([])
    await card.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect.poll(completed).toBe(1)
    expect(hits).toEqual(['/page'])
    expect((await settings()).rules).toEqual([])

    await send('Fetch another page and save access.')
    await expect(card).toBeVisible()
    await desktop.page.screenshot({ path: testInfo.outputPath('network-approval.png'), animations: 'disabled' })
    await card.locator('.desktop-approval-card__scope-button').click()
    await desktop.page.locator('.n-dropdown-menu:visible').getByText('允许并保存网站权限', { exact: true }).click()
    await expect.poll(completed).toBe(2)
    expect((await settings()).rules[0]).toMatchObject({ pattern: 'permission.example.test', access: 'allow', download: 'ask', upload: 'ask' })

    await send('Fetch a file.')
    await expect(card).toContainText('下载文件')
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(completed).toBe(3)
    expect((await settings()).rules[0].download).toBe('ask')
    await desktop.page.evaluate(async () => {
      const config = await window.lexoraDesktop.settings.get()
      const networkPermissions = config.browser.networkPermissions
      networkPermissions.rules[0].access = 'deny'
      await window.lexoraDesktop.settings.update({ browser: { networkPermissions } })
    })
    const prior = hits.length
    await send('Fetch a denied page.')
    await expect.poll(completed).toBe(4)
    expect(hits).toHaveLength(prior)
    await expect(card).toBeHidden()
    expect(JSON.stringify(requests.at(-1).messages)).toContain('NETWORK_PERMISSION_DENIED')

    await desktop.page.evaluate(async () => {
      const { browser } = await window.lexoraDesktop.settings.get()
      browser.networkPermissions.rules[0].access = 'allow'
      browser.networkPermissions.rules.push({ id: crypto.randomUUID(), match: 'exact', pattern: 'blocked.example.test', access: 'deny', download: 'ask', upload: 'ask' })
      await window.lexoraDesktop.settings.update({ browser: { networkPermissions: browser.networkPermissions } })
    })
    await send('Open the browser to a redirect.')
    await expect(card).toContainText('redirect.example.test')
    expect(hits).toContain('/redirect')
    expect(hits).not.toContain('/landing')
    await card.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect.poll(completed).toBe(5)
    expect(hits).toContain('/landing')
    expect(hits).not.toContain('/pixel')

    await desktop.page.evaluate(async () => {
      const { browser } = await window.lexoraDesktop.settings.get()
      browser.networkPermissions.rules[0].access = 'deny'
      await window.lexoraDesktop.settings.update({ browser: { networkPermissions: browser.networkPermissions } })
    })
    const address = desktop.page.getByTestId('browser-address')
    await address.fill('http://permission.example.test/manual')
    await address.press('Enter')
    await expect.poll(() => hits.includes('/manual')).toBe(true)
    await expect(card).toBeHidden()
    expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

test('referenced task resources are discovered, read through the runtime and opened beside the current draft', async ({ buddy }, testInfo) => {
  const title = '创建一个 HTML，内容是 SVG 绘制一只鹅骑自行车的二维动画，保留完整标题以验证单行省略'
  const html = `<!doctype html><title>Goose animation</title>${'<circle cx="20" cy="20" r="10"/>'.repeat(600)}END_OF_ANIMATION`
  const requests = []
  const readParts = []
  let step = 0
  let phase = 'resource'
  let earlierSource
  const chainTexts = []
  let source
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const common = { id: `materials-${requests.length}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
    function send(delta, reason = 'stop') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    function call(name, args) {
      send({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
    }
    if (!body.tools?.length) {
      send({ content: '继续制作动画' })
      return
    }
    if (phase === 'chain') {
      const current = step++
      if (current === 0) {
        call('lexora_tool_search', { toolNames: ['lexora_session_search', 'lexora_session_read'] })
      }
      else if (current === 1) {
        call('lexora_session_search', { sessionId: 'source', query: 'Referenced tasks', kind: 'messages' })
      }
      else if (current === 2) {
        const last = JSON.parse(body.messages.findLast(message => message.role === 'tool').content)
        call('lexora_session_read', { sessionId: 'source', branchId: last.branchId, source: last.matches[0].source })
      }
      else if (current === 3) {
        const last = JSON.parse(body.messages.findLast(message => message.role === 'tool').content)
        chainTexts.push(last.text)
        call('lexora_session_search', { sessionId: 'earlier', query: 'EARLIER_DECISION', kind: 'messages' })
      }
      else if (current === 4) {
        const last = JSON.parse(body.messages.findLast(message => message.role === 'tool').content)
        earlierSource = last.matches[0].source
        call('lexora_session_read', { sessionId: 'earlier', branchId: last.branchId, source: earlierSource })
      }
      else {
        const last = JSON.parse(body.messages.findLast(message => message.role === 'tool').content)
        chainTexts.push(last.text)
        send({ content: '第二轮已沿引用链读取更早的决定。' })
      }
      return
    }
    if (step++ === 0) {
      call('lexora_tool_search', { toolNames: ['lexora_session_search', 'lexora_session_read'] })
      return
    }
    if (step === 2) {
      call('lexora_session_search', { sessionId: 'source', query: 'goose', kind: 'resources' })
      return
    }
    try {
      const last = JSON.parse(body.messages.findLast(message => message.role === 'tool').content)
      if (step === 3) {
        source = last.resources[0].source
        call('lexora_session_read', { sessionId: 'source', source, limit: 8000 })
        return
      }
      readParts.push(last.text)
      if (last.nextOffset !== null) {
        call('lexora_session_read', { sessionId: 'source', source, offset: last.nextOffset, limit: 8000 })
        return
      }
      send({ content: '已完整读取动画源码，可以继续修改夜景。' })
    }
    catch {
      send({ content: 'Fixture could not read the task resource.' })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('session-materials')
  try {
    const { app, page, diagnostics } = await instance.launch()
    const resourcePath = path.join(instance.home, 'goose-animation.html')
    await fs.writeFile(resourcePath, html)
    await app.evaluate(({ app, safeStorage }, fixture) => {
      if (app.getName() !== 'Lexora Buddy Test')
        throw new Error('Synthetic credentials require an isolated test instance')
      Object.defineProperties(safeStorage, {
        isEncryptionAvailable: { configurable: true, value: () => true },
        getSelectedStorageBackend: { configurable: true, value: () => 'offline-fixture' },
        encryptString: { configurable: true, value: value => Buffer.from(`offline-fixture:${value}`) },
        decryptString: { configurable: true, value: value => value.toString('utf8').slice('offline-fixture:'.length) },
      })
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
      const database = new DatabaseSync(fixture.databasePath)
      const now = new Date().toISOString()
      try {
        database.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('source', fixture.title, 'source-branch', now, now)
        database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('source-branch', 'source', now)
        database.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('earlier', '更早的方案决定', 'earlier-branch', now, now)
        database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('earlier-branch', 'earlier', now)
        database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('earlier-message', 'earlier', 'earlier-branch', 'assistant', JSON.stringify({ text: 'EARLIER_DECISION: use the night sky palette.' }), now)
        const content = {
          userContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: '继续完善这个文件。' }, { type: 'session_ref', sessionId: 'earlier' }] }], panelResourceIds: ['animation'], sessionReferences: [{ id: 'earlier', title: '更早的方案决定' }] },
          resourceSnapshots: [{ resourceId: 'animation', localReference: { path: fixture.resourcePath, name: 'goose-animation.html', kind: 'file', mimeType: 'text/html', sizeBytes: fixture.sizeBytes } }],
        }
        database.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('source-message', 'source', 'source-branch', 'user', JSON.stringify(content), now)
      }
      finally { database.close() }
    }, { databasePath: path.join(instance.home, 'buddy/buddy.sqlite3'), resourcePath, sizeBytes: Buffer.byteLength(html), title })
    await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
    await page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'materials-fixture', displayName: 'Materials fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'materials', name: 'Materials', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'materials-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('materials-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'materials-fixture', modelId: 'materials', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    const editor = page.locator('.desktop-chat-composer__prosemirror:visible')
    await expect(editor).toBeVisible()
    await editor.fill('@')
    await page.getByRole('option', { name: '独立任务', exact: true }).click()
    await expect(page.locator('.chat-composer-source-picker__shortcuts')).toContainText('Alt')
    await page.getByRole('option', { name: title, exact: true }).click()
    await expect(page.locator('.chat-session-reference')).toHaveCount(1)
    const mention = editor.locator('[data-type="chat-session-reference"]')
    await expect(mention).toBeVisible()
    expect(await mention.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap')
    await editor.press('End')
    await page.keyboard.insertText(' 把之前生成的动画改成夜景。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByText('已完整读取动画源码，可以继续修改夜景。', { exact: true })).toBeVisible({ timeout: 60000 })
    expect(readParts.join('')).toBe(html)
    expect(readParts.length).toBeGreaterThan(1)
    expect(requests.filter(body => body.tools?.length).some(body => body.tools.some(tool => tool.function.name === 'lexora_session_read'))).toBe(true)
    await page.getByRole('button', { name: /读取 \d+ 次 · 搜索 \d+ 次/ }).click()
    await expect(page.getByRole('button', { name: /搜索任务资料/ })).toBeVisible()
    await page.getByRole('button', { name: /读取任务资料/ }).first().click()
    await expect(page.getByRole('button', { name: `打开来源任务 · ${title}`, exact: true })).toBeVisible()
    phase = 'chain'
    step = 0
    await editor.fill('没有重新附加任务，继续查找更早的决定。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByText('第二轮已沿引用链读取更早的决定。', { exact: true })).toBeVisible({ timeout: 60000 })
    expect(chainTexts[0]).toContain('[SESSION:earlier]')
    expect(chainTexts[0]).toContain('Referenced tasks:')
    expect(chainTexts[1]).toContain('EARLIER_DECISION')
    await page.screenshot({ path: testInfo.outputPath('session-reference-chain.png'), animations: 'disabled' })
    await editor.fill('保留在当前任务的后续修改要求')
    await page.getByRole('button', { name: `打开来源任务 · ${title}`, exact: true }).click()
    await expect(page.locator('.desktop-chat-composer__prosemirror:visible')).toHaveCount(2)
    await expect(page.locator('.desktop-chat-composer__prosemirror:visible').filter({ hasText: '保留在当前任务的后续修改要求' })).toHaveCount(1)
    await expect(page.locator('.workbench-pane-title:visible').filter({ hasText: title })).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('session-materials-source-open.png'), animations: 'disabled' })
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
    expect(await fs.readFile(resourcePath, 'utf8')).toBe(html)
  }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

test('long pasted text survives restart, reaches the model in full and remains readable in history', async ({ buddy }) => {
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const common = { id: `text-${requests.length}`, model: 'paste-fixture', object: 'chat.completion.chunk', created: 1 }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '已收到完整文本。' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('pasted-text')
  const text = `  // 原始文本：保留缩进、空行与末尾换行\n\n${Array.from({ length: 24 }, (_, index) => `\tconst line${index} = "中文 <tag> & spaces  ";`).join('\n')}\n\n`
  try {
    let application = await instance.launch()
    await useSyntheticCredentialStorage(application)
    await application.page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'paste-fixture', displayName: 'Paste fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'paste-fixture', name: 'Paste fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'paste-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('paste-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'paste-fixture', modelId: 'paste-fixture', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await application.page.reload()
    let editor = application.page.locator('.desktop-chat-composer__prosemirror:visible')
    await expect(editor).toBeVisible()
    await editor.fill('请检查这段代码：')
    await editor.press('ControlOrMeta+End')
    await paste(application, text)
    await expect(editor.locator('[data-type="chat-resource-reference"]')).toHaveCount(1)
    const stored = readDatabase(instance.home, db => db.prepare('SELECT id, stored_path FROM attachments WHERE name_source = ? LIMIT 1').get('clipboard'))
    expect(await fs.readFile(stored.stored_path, 'utf8')).toBe(text)

    await instance.stop()
    application = await instance.launch()
    await useSyntheticCredentialStorage(application)
    await application.page.reload()
    editor = application.page.locator('.desktop-chat-composer__prosemirror:visible')
    const previewButton = application.page.getByRole('button', { name: /^查看粘贴文本：/ })
    await expect(editor.locator('[data-type="chat-resource-reference"]')).toHaveCount(1)
    await application.page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => readDatabase(instance.home, db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(1)
    expect(requests).toHaveLength(1)
    const content = requests[0].messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n')
    expect(content).toContain('请检查这段代码：')
    expect(content).toContain(text)
    const sent = readDatabase(instance.home, db => db.prepare('SELECT stored_path FROM attachments WHERE id = ?').get(stored.id))
    expect(await fs.readFile(sent.stored_path, 'utf8')).toBe(text)
    await application.page.locator('.buddy-chat-message.is-user').hover()
    await application.page.getByRole('button', { name: '编辑输入', exact: true }).click()
    await previewButton.click()
    await expect(application.page.locator('.composer-text-preview')).toContainText('原始文本：保留缩进、空行与末尾换行')
    expect(application.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

async function paste(application, text) {
  await application.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
  await application.page.locator('.desktop-chat-composer__prosemirror:visible').press('ControlOrMeta+v')
}

function readDatabase(home, read) {
  const database = new DatabaseSync(path.join(home, 'buddy/buddy.sqlite3'), { readOnly: true })
  try {
    return read(database)
  }
  finally {
    database.close()
  }
}

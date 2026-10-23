import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

test('task links share file openers and context actions without creating output records', async ({ buddy }) => {
  const instance = await buddy.createInstance('task-file-links')
  const read = (sql) => {
    const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
    try {
      return database.prepare(sql).all()
    }
    finally { database.close() }
  }
  let page
  let actorId
  let conversationId
  let workspace
  let parentRequests = 0
  let childRequests = 0
  let sequence = 0
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Reference document</title><h1>Reference document</h1>')
      return
    }
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const parent = JSON.stringify(payload.messages).includes('FILE_LINK_PARENT')
    let tool
    let text
    if (parent && ++parentRequests === 1) {
      conversationId = read('SELECT id FROM conversations WHERE deleted_at IS NULL')[0].id
      workspace = path.join(instance.home, 'buddy/conversations', conversationId, 'workspace')
      await fs.mkdir(workspace, { recursive: true })
      await fs.writeFile(path.join(workspace, 'published.html'), '<!doctype html><title>Child HTML</title><h1>Child artifact</h1><script src="animation.js"></script>')
      await fs.writeFile(path.join(workspace, 'animation.js'), 'window.fixtureReady = true')
      await fs.writeFile(path.join(workspace, 'unpublished.html'), '<!doctype html><title>Unpublished HTML</title><h1>Unpublished file</h1>')
      await fs.writeFile(path.join(workspace, 'unpublished.md'), '# Task Markdown\n\nReadable without a Space or artifact record.\n')
      await fs.writeFile(path.join(workspace, 'unpublished.fixturetext'), 'Unknown extension text remains readable.\n')
      await page.evaluate(async ({ conversationId, buddyId }) => window.lexoraDesktop.localChat.conversations.addMember(conversationId, buddyId), { conversationId, buddyId: actorId })
      tool = { name: 'lexora_agents', arguments: { operation: 'delegate', targetId: actorId, text: 'Present published.html as the result.' } }
    }
    else if (!parent && ++childRequests === 1) {
      tool = { name: 'lexora_output_present', arguments: { paths: ['published.html'] } }
    }
    else if (!parent) {
      text = 'Child artifact ready.'
    }
    else if (!read('SELECT id FROM runs WHERE execution_kind=\'actor_child\' AND status=\'completed\'').length) {
      tool = { name: 'lexora_agents', arguments: { operation: 'wait', timeoutMs: 60000 } }
    }
    else {
      text = `[Published animation](published.html)\n\n[Unpublished animation](unpublished.html)\n\n[Unpublished Markdown](unpublished.md)\n\n[Unknown extension](unpublished.fixturetext)\n\n[Missing file](missing.md)\n\n[Reference document](http://127.0.0.1:${server.address().port}/reference)`
    }
    const id = `reply-${++sequence}`
    const delta = tool
      ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: text }
    const common = { id, created: 1, model: payload.model, object: 'chat.completion.chunk' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const launch = await instance.launch()
    page = launch.page
    const { app, diagnostics } = launch
    await useSyntheticCredentialStorage(launch)
    actorId = await page.evaluate(async (baseUrl) => {
      const api = window.lexoraDesktop.localChat
      await window.lexoraDesktop.settings.update({ desktop: { contextPanelMode: 'task', featureAnnouncementsEnabled: false }, browser: { linkOpening: 'in-app' } })
      await api.providers.upsertCustom({ id: 'file-link-fixture', displayName: 'File link fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'file-link-model', name: 'File link model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = api.providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'file-link-fixture' && challenge.type === 'secret')
          void api.providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await api.providers.login('file-link-fixture', 'api_key')
      }
      finally { stop() }
      await api.providers.setDefaultModel({ providerId: 'file-link-fixture', modelId: 'file-link-model', reasoning: null })
      const child = await api.buddies.create({ kind: 'actor', name: 'File author' })
      await api.buddies.update({ buddyId: child.id, expectedRevision: child.revision, settings: { ...child.settings, instructions: 'FILE_LINK_CHILD', skills: { mode: 'none' } } })
      const parent = await api.buddies.get('default')
      await api.buddies.update({ buddyId: parent.id, expectedRevision: parent.revision, settings: { ...parent.settings, instructions: 'FILE_LINK_PARENT', skills: { mode: 'none' } } })
      return child.id
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('Delegate file presentation to the author.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.locator('.buddy-chat-markdown a').filter({ hasText: /^Published animation$/ })).toBeVisible()
    expect(read('SELECT space_id FROM conversations WHERE deleted_at IS NULL')).toEqual([{ space_id: null }])
    expect(read('SELECT e.run_id FROM run_events e JOIN runs r ON r.id=e.run_id WHERE e.event_type=\'output.produced\' AND r.execution_kind=\'root\'')).toEqual([])
    expect(read('SELECT name FROM artifacts')).toEqual([{ name: 'published.html' }])
    const address = page.getByTestId('browser-address')
    const publishedUrl = pathToFileURL(path.join(workspace, 'published.html')).href
    await page.locator('.buddy-chat-markdown a').filter({ hasText: /^Published animation$/ }).click()
    await expect(address).toHaveValue(publishedUrl)
    await expect.poll(() => app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
      return guest && guest.executeJavaScript('window.fixtureReady === true && document.title === "Child HTML"')
    }, publishedUrl)).toBe(true)
    await page.locator('.buddy-chat-markdown a').filter({ hasText: /^Unpublished animation$/ }).click()
    await expect(address).toHaveValue(pathToFileURL(path.join(workspace, 'unpublished.html')).href)
    await page.locator('.buddy-chat-markdown a').filter({ hasText: /^Reference document$/ }).click()
    await expect(address).toHaveValue(`http://127.0.0.1:${server.address().port}/reference`)
    const process = page.getByTestId('actor-process').filter({ hasText: '执行过程' }).first()
    await process.getByRole('button', { name: '执行过程', exact: true }).click()
    const card = process.locator('.buddy-artifact-collection__item').filter({ hasText: 'published.html' })
    await expect(card).toBeVisible()
    await card.locator('.buddy-artifact-collection__trigger').click()
    await expect(address).toHaveValue(publishedUrl)
    await page.locator('.buddy-chat-markdown a').filter({ hasText: /^Unpublished animation$/ }).click()
    await expect(address).not.toHaveValue(publishedUrl)
    await card.hover()
    await card.locator('.buddy-artifact-collection__open').click()
    await expect(address).toHaveValue(publishedUrl)

    const link = name => page.locator('.buddy-chat-markdown a').filter({ hasText: new RegExp(`^${name}$`) })
    const preview = page.locator('.file-preview:visible')
    const source = preview.locator('.desktop-monaco-file .view-lines')
    const markdown = preview.getByRole('heading', { name: 'Task Markdown', exact: true })
    async function menu(name) {
      await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)
      await link(name).click({ button: 'right' })
      const popup = page.locator('.n-dropdown-menu:visible')
      await expect(popup.getByText('打开方式', { exact: true })).toBeVisible()
      return popup
    }

    await link('Unpublished Markdown').click()
    await expect(markdown).toBeVisible()
    await expect(preview).toContainText('Readable without a Space or artifact record.')
    await expect(preview.locator('.desktop-monaco-file')).toHaveCount(0)
    await link('Unknown extension').click()
    await expect(source).toContainText('Unknown extension text remains readable.')
    await (await menu('Unpublished Markdown')).getByText('打开', { exact: true }).click()
    await expect(markdown).toBeVisible()

    await page.evaluate(() => window.lexoraDesktop.extensions.setFileOpener({ extension: '.html', location: 'standalone', providerId: 'lexora.text' }))
    await link('Unpublished animation').click()
    await expect(source).toContainText('<h1>Unpublished file</h1>')
    await expect(page.getByTestId('browser-address').filter({ visible: true })).toHaveCount(0)
    await (await menu('Unpublished animation')).getByText('打开方式', { exact: true }).hover()
    await page.locator('.n-dropdown-menu:visible').getByText('浏览器', { exact: true }).click()
    await expect(address).toHaveValue(pathToFileURL(path.join(workspace, 'unpublished.html')).href)
    await expect(address).toBeVisible()
    await (await menu('Unpublished animation')).getByText('打开方式', { exact: true }).hover()
    await page.locator('.n-dropdown-menu:visible').getByText('文本查看器', { exact: true }).click()
    await expect(source).toContainText('<h1>Unpublished file</h1>')
    await expect(page.getByTestId('browser-address').filter({ visible: true })).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.lexoraDesktop.extensions.fileOpeners()).defaults['.html']?.standalone)).toBe('lexora.text')

    await app.evaluate(({ clipboard }) => clipboard.writeText('task-file-links clipboard sentinel'))
    await (await menu('Unpublished Markdown')).getByText('复制路径', { exact: true }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(path.join(workspace, 'unpublished.md'))
    await (await menu('Unpublished Markdown')).getByText('引用', { exact: true }).click()
    const references = page.locator('.desktop-chat-composer-wrap:visible .chat-input-material-card')
    await expect(references).toHaveCount(1)
    await expect(references).toContainText('unpublished.md')

    await link('Missing file').click()
    await expect(page.getByText('文件已被移动或删除', { exact: true })).toBeVisible()
    expect(read('SELECT name FROM artifacts')).toEqual([{ name: 'published.html' }])
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

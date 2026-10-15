import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

test('skill creation preserves Space scope and installs only after user review', async ({ buddy }) => {
  let requestCount = 0
  const content = '---\nname: meeting-summary\ndescription: Summarize meeting notes and extract action items.\n---\n\n# Meeting summary\n\nRead the notes and list decisions and assigned actions.\n'
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requestCount += 1
    const current = body.messages.slice(body.messages.findLastIndex(message => message.role === 'user') + 1)
    const calls = current.flatMap(message => message.tool_calls ?? []).map(call => call.function.name)
    let call
    if (!calls.includes('write'))
      call = { name: 'write', arguments: { path: 'skills/meeting-summary/SKILL.md', content } }
    else if (!body.tools?.some(tool => tool.function.name === 'lexora_skill_prepare'))
      call = calls.includes('lexora_tool_search') ? null : { name: 'lexora_tool_search', arguments: { query: 'lexora_skill_prepare', limit: 1 } }
    else if (!calls.includes('lexora_skill_prepare'))
      call = { name: 'lexora_skill_prepare', arguments: { source: 'skills/meeting-summary', review: true } }
    const common = { id: `skill-${requestCount}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
    const delta = call
      ? { tool_calls: [{ index: 0, id: `call-${requestCount}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { content: '技能源码已准备，请查看安装预览。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('skill-space')
  try {
    const desktop = await instance.launch()
    await useSyntheticCredentialStorage(desktop)
    const page = desktop.page
    await page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'skill-fixture', displayName: 'Skill fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'skill-fixture', name: 'Skill fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'skill-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('skill-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'skill-fixture', modelId: 'skill-fixture', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    const spaceId = await page.evaluate(async () => (await window.lexoraDesktop.localChat.spaces.create({ name: 'Skill workshop', memoryScope: 'space_only', primaryDirectory: null })).id)
    await page.reload()
    await page.evaluate((id) => {
      location.hash = `/settings/skills?space=${id}`
    }, spaceId)
    const create = page.getByRole('button', { name: '创建 Skill', exact: true })
    await create.click()
    await expect(page.locator('.desktop-chat-composer__prosemirror:visible')).toContainText('skill-creator')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const modal = page.locator('.skill-import:visible')
    await expect(modal).toBeVisible({ timeout: 30000 })
    await expect(modal).toContainText('安装到：Skill workshop')
    await expect(modal.getByRole('checkbox')).toBeChecked()
    await expect.poll(() => completedRuns(instance.home)).toBe(1)
    expect((await page.evaluate(id => window.lexoraDesktop.localChat.skills.list(id), spaceId)).skills.some(skill => skill.name === 'meeting-summary')).toBe(false)
    const source = (await modal.locator('.skill-import__location').textContent()).trim()
    expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe(content)
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'skill-install-review.png'), animations: 'disabled' })

    const queued = await page.evaluate(async ({ spaceId, source }) => window.lexoraDesktop.localChat.skills.preview({ spaceId, source: { kind: 'directory', location: source } }), { spaceId, source })
    await desktop.app.evaluate(({ BrowserWindow }, preview) => {
      const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().startsWith('lexora-app:'))
      window.webContents.send('lexora:buddy:skills:review-requested', preview)
      window.webContents.send('lexora:buddy:skills:review-requested', preview)
    }, queued)
    await modal.getByRole('button', { name: '取消', exact: true }).click()
    await expect(modal).toBeVisible()
    await expect(modal.getByRole('checkbox')).toBeChecked()
    await fs.writeFile(path.join(source, 'SKILL.md'), content.replace('Read the notes', 'Changed after preview: read the notes'))
    await modal.getByRole('button', { name: '安装所选（1）', exact: true }).click()
    await expect(modal).toHaveCount(0)
    const installed = (await page.evaluate(id => window.lexoraDesktop.localChat.skills.list(id), spaceId)).skills.find(skill => skill.name === 'meeting-summary')
    expect(installed).toMatchObject({ spaceId, source: 'space', status: 'available' })
    expect(await fs.readFile(installed.filePath, 'utf8')).toBe(content)
    expect((await page.evaluate(() => window.lexoraDesktop.localChat.skills.list(null))).skills.some(skill => skill.name === 'meeting-summary')).toBe(false)
    expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

function rows(home, sql) {
  const database = new DatabaseSync(path.join(home, 'buddy/buddy.sqlite3'), { readOnly: true })
  try {
    return database.prepare(sql).all()
  }
  finally { database.close() }
}

function completedRuns(home) {
  return rows(home, 'SELECT id FROM runs WHERE status = \'completed\'').length
}

import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures/electron.mjs'

test('agent plugin uses the originating model, persists settings and protects manual titles and cancelled writes', async ({ buddy }) => {
  test.setTimeout(180000)
  const requests = []
  const pending = []
  let hold = false
  let generated = 0
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const common = { id: `title-${requests.length}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
    function send(delta, reason = 'stop') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    if (!body.tools?.length) {
      const finish = () => send({ content: `生成标题 ${++generated}` })
      if (hold)
        pending.push(finish)
      else finish()
      return
    }
    const tool = body.tools.find(tool => tool.function.description.includes('Generate and save a concise title'))
    if (tool && body.messages.at(-1).role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ summary: '整理本周项目计划' }) } }] }, 'tool_calls')
    }
    else {
      send({ content: '任务已处理。' })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('agent-title')
  try {
    let { app, page, diagnostics } = await instance.launch()
    await syntheticCredentials(app, page)
    await page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'title-fixture', displayName: 'Title fixture', api: 'openai-completions', baseUrl, enabled: true, models: ['primary', 'secondary'].map(id => ({ id, name: id, input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 })) })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'title-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('title-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'title-fixture', modelId: 'primary', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    const source = process.env.LEXORA_TEST_TITLE_PLUGIN ?? path.join(instance.home, 'fixture-plugin')
    if (!process.env.LEXORA_TEST_TITLE_PLUGIN)
      await writeFixture(source)
    await page.reload()
    async function install(target, updating = false) {
      const development = (await fs.stat(target)).isDirectory()
      await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
      await app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
      }, target)
      await page.getByTestId('extension-install-options').click()
      await page.getByTestId(development ? 'extension-development' : 'extension-install').click()
      await expect(page.getByText('调用已配置的模型', { exact: true })).toBeVisible()
      await page.getByTestId('extension-confirm-install').click()
      await expect.poll(() => page.evaluate(async (updating) => {
        const plugin = (await window.lexoraDesktop.extensions.list())[0]
        return !!plugin && (!updating || !!plugin.pending)
      }, updating)).toBe(true)
    }
    const previous = process.env.LEXORA_TEST_TITLE_PLUGIN_PREVIOUS
    if (previous) {
      await install(previous)
      await page.evaluate(async () => {
        const plugin = (await window.lexoraDesktop.extensions.list())[0]
        await window.lexoraDesktop.extensions.configure(plugin.manifest.id, { enabled: false, model: { providerId: 'title-fixture', modelId: 'secondary' } })
      })
    }
    await install(source, !!previous)
    const pluginId = await page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].manifest.id)
    if (previous) {
      await page.locator(`[data-extension-id="${pluginId}"]`).getByTestId('extension-card-more').click()
      await page.getByTestId('extension-restart').click()
      await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].pending)).toBeNull()
      expect(await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)).toMatchObject({ enabled: false, model: { providerId: 'title-fixture', modelId: 'secondary' } })
      await page.evaluate(id => window.lexoraDesktop.extensions.configure(id, { enabled: true, model: null }), pluginId)
    }
    if (process.env.LEXORA_TEST_TITLE_PLUGIN) {
      const icon = page.locator(`[data-extension-id="${pluginId}"] img`)
      await expect(icon).toBeVisible()
      await expect.poll(() => icon.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
      await page.screenshot({ path: path.join(instance.artifactDirectory, 'title-plugin-card.png'), animations: 'disabled' })
    }
    const settings = async () => {
      await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
      await page.locator(`[data-extension-id="${pluginId}"]`).getByRole('button', { name: '打开', exact: true }).click()
    }
    const taskPage = () => page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
    await settings()
    if (process.env.LEXORA_TEST_TITLE_PLUGIN) {
      await expect(page).toHaveURL(/#\/settings\/runtime\?group=lexora.auto-title.naming$/)
      await expect(page.getByRole('link', { name: '标题自动生成', exact: true })).toHaveCount(0)
      await expect(page.locator('[data-settings-group="lexora.auto-title.naming"]')).toBeFocused()
      expect(await page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].iconUrl)).toMatch(/^data:image\/svg\+xml;base64,/)
    }
    const toggle = () => page.locator(`[data-setting-id="${pluginId}.enabled"]`).getByRole('switch')
    await expect(toggle()).toBeChecked()
    await toggle().click()
    await expect(toggle()).not.toBeChecked()
    await expect.poll(() => page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)).toMatchObject({ enabled: false })
    await toggle().click()
    await expect(toggle()).toBeChecked()
    await expect.poll(() => page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)).toMatchObject({ enabled: true })
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'title-settings.png'), animations: 'disabled' })
    if (!process.env.LEXORA_TEST_TITLE_PLUGIN) {
      await page.getByRole('link', { name: '常规', exact: true }).click()
      await expect(page.getByText('附加分组', { exact: true })).toBeVisible()
      await expect(page.locator(`[data-setting-id="${pluginId}.inline"]`)).toBeVisible()
    }
    await taskPage()
    async function send(text, newTask = false) {
      if (newTask) {
        await page.getByRole('button', { name: '新任务', exact: true }).click()
        await expect(page.locator('.desktop-chat-workspace-header__copy:visible')).toHaveText('新任务')
        await expect(page.locator('.desktop-chat-page.is-empty:not(.is-loading):visible')).toBeVisible()
      }
      const count = rows(instance.home, 'SELECT id FROM runs').length
      await page.locator('.desktop-chat-composer__prosemirror:visible').fill(text)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect.poll(() => rows(instance.home, 'SELECT id FROM runs').length).toBe(count + 1)
    }
    const settled = async () => {
      await expect.poll(() => rows(instance.home, 'SELECT id FROM runs WHERE status IN (\'queued\', \'running\')').length).toBe(0)
      expect(rows(instance.home, 'SELECT id, error_code FROM runs WHERE status = \'failed\'')).toEqual([])
    }
    const latestTask = () => rows(instance.home, 'SELECT * FROM conversations ORDER BY created_at DESC LIMIT 1')[0]
    await send('整理本周项目计划')
    await settled()
    expect(latestTask()).toMatchObject({ title: '生成标题 1', title_source: 'generated' })
    expect(requests.filter(body => !body.tools?.length).map(body => body.model)).toEqual(['primary'])
    expect(JSON.stringify(requests[0].messages)).toContain('proactively')
    const pluginToolName = requests[0].tools.find(tool => tool.function.description.includes('Generate and save a concise title')).function.name
    await expect(page.getByText('生成标题 1', { exact: true }).first()).toBeVisible()

    await settings()
    const modelField = () => page.locator(`[data-setting-id="${pluginId}.model"]`)
    async function chooseSecondary() {
      await modelField().locator('.plugin-model-setting__select').click()
      await expect(page.locator('.desktop-model-picker__providers')).toContainText('Title fixture')
      await page.locator('.desktop-model-picker__search input').fill('secondary')
      await page.screenshot({ path: path.join(instance.artifactDirectory, 'title-model-picker.png'), animations: 'disabled' })
      await page.getByRole('menuitemradio', { name: 'secondary secondary', exact: true }).click()
      await expect(modelField()).toContainText('secondary · Title fixture')
    }
    await chooseSecondary()
    await modelField().getByRole('button', { name: '使用本轮模型', exact: true }).click()
    await expect.poll(() => page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)).toMatchObject({ model: null })
    await expect(modelField()).toContainText('使用本轮模型')
    await chooseSecondary()
    await expect.poll(() => page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)).toMatchObject({ model: { providerId: 'title-fixture', modelId: 'secondary' } })
    await taskPage()
    await send('重新整理发布计划', true)
    await settled()
    expect(latestTask()).toMatchObject({ title: '生成标题 2', title_source: 'generated' })
    expect(requests.filter(body => !body.tools?.length).map(body => body.model)).toEqual(['primary', 'secondary'])
    expect(requests.filter(body => body.tools?.length).every(body => body.model === 'primary')).toBe(true)
    expect(rows(instance.home, 'SELECT provider, model, purpose FROM usage_records WHERE source_entry_id LIKE \'plugin:%\'').map(row => row.model)).toEqual(['primary', 'secondary'])

    await page.evaluate(id => window.lexoraDesktop.extensions.configure(id, { model: { providerId: 'title-fixture', modelId: 'unavailable' } }), pluginId)
    await send('指定模型不可用时保留原名', true)
    await settled()
    expect(latestTask()).toMatchObject({ title: '指定模型不可用时保留原名', title_source: 'fallback' })
    expect(requests.filter(body => !body.tools?.length)).toHaveLength(2)
    await settings()
    await expect(modelField()).toContainText('unavailable · Title fixture（不可用）')
    await chooseSecondary()
    await taskPage()

    hold = true
    await send('等待命名时手动改名', true)
    await expect.poll(() => pending.length).toBe(1)
    const original = latestTask()
    await page.evaluate(id => window.lexoraDesktop.localChat.conversations.rename(id, '手动保留'), original.id)
    expect(latestTask()).toMatchObject({ title: '手动保留', updated_at: original.updated_at })
    pending.shift()()
    await settled()
    expect(latestTask()).toMatchObject({ title: '手动保留', title_source: 'manual' })
    const beforeProtected = requests.filter(body => !body.tools?.length).length
    await send('继续同一任务')
    await settled()
    expect(requests.filter(body => !body.tools?.length)).toHaveLength(beforeProtected)

    await send('取消任务时不写入迟到标题', true)
    await expect.poll(() => pending.length).toBe(1)
    const beforeCancel = latestTask()
    const activeRun = rows(instance.home, 'SELECT id FROM runs WHERE status = \'running\'')[0]
    await page.evaluate(id => window.lexoraDesktop.localChat.chat.cancel(id), activeRun.id)
    pending.shift()()
    await settled()
    expect(latestTask()).toMatchObject({ title: beforeCancel.title, title_source: 'fallback' })

    hold = false
    const resumedTitle = `生成标题 ${generated + 1}`
    await send('取消后继续同一任务')
    await settled()
    expect(latestTask()).toMatchObject({ id: beforeCancel.id, title: resumedTitle, title_source: 'generated' })

    hold = true
    await send('禁用时不写入迟到标题', true)
    await expect.poll(() => pending.length).toBe(1)
    const beforeDisable = latestTask()
    await page.evaluate(id => window.lexoraDesktop.extensions.configure(id, { enabled: false }), pluginId)
    pending.shift()()
    await settled()
    expect(latestTask()).toMatchObject({ title: beforeDisable.title, title_source: 'fallback' })
    const count = requests.length
    await send('关闭功能后继续任务', true)
    await settled()
    expect(requests.slice(count).every(body => !body.tools?.some(tool => tool.function.name === pluginToolName))).toBe(true)
    await instance.stop()
    ;({ app, page, diagnostics } = await instance.launch())
    await settings()
    await expect(toggle()).not.toBeChecked()
    await expect(modelField()).toContainText('secondary · Title fixture')
    expect(await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)).toMatchObject({ enabled: false, model: { providerId: 'title-fixture', modelId: 'secondary' } })
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
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

async function syntheticCredentials(app, page) {
  await app.evaluate(({ app, safeStorage }) => {
    if (app.getName() !== 'Lexora Buddy Test')
      throw new Error('Synthetic credentials require an isolated test instance')
    Object.defineProperties(safeStorage, {
      isEncryptionAvailable: { configurable: true, value: () => true },
      getSelectedStorageBackend: { configurable: true, value: () => 'offline-fixture' },
      encryptString: { configurable: true, value: value => Buffer.from(`offline-fixture:${value}`) },
      decryptString: { configurable: true, value: value => value.toString('utf8').slice('offline-fixture:'.length) },
    })
  })
  await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
  await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
}

async function writeFixture(directory) {
  const id = 'tests.title'
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'extension.json'), JSON.stringify({
    schemaVersion: 1,
    id,
    name: '标题自动生成',
    version: '1.0.0',
    apiVersion: 3,
    engines: { lexora: '*' },
    entry: 'extension.js',
    permissions: { agent: true, models: true, tasks: 'title' },
    contributes: {
      settings: {
        modules: [{ id: `${id}.settings`, title: '标题自动生成' }],
        groups: [{ id: `${id}.group`, module: `${id}.settings`, title: '命名' }, { id: `${id}.extra`, module: 'settings.general', title: '附加分组' }],
        items: [
          { id: `${id}.enabled`, key: 'enabled', group: `${id}.group`, type: 'boolean', title: '启用', default: true },
          { id: `${id}.model`, key: 'model', group: `${id}.group`, type: 'model', title: '模型', default: null },
          { id: `${id}.inline`, key: 'inline', group: 'settings.general.general', type: 'boolean', title: '分组内单项', default: false },
          { id: `${id}.extra-item`, key: 'extra', group: `${id}.extra`, type: 'string', title: '附加字段', default: '' },
        ],
      },
      agent: { enabledWhen: 'enabled', instructions: `Please proactively call {{${id}.generate}} to name the task.`, tools: [{ id: `${id}.generate`, title: '生成标题', description: 'Generate and save a concise title', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } }] },
    },
  }))
  await fs.writeFile(path.join(directory, 'extension.js'), `export const activate = ${activate.toString()}`)
}

function activate(context) {
  context.agent.registerTool(`${context.extension.id}.generate`, async (input, invocation) => {
    const task = await invocation.task.get()
    if (task.titleSource === 'manual')
      return { applied: false }
    const configuration = await context.configuration.get()
    const result = await invocation.models.generateText({ prompt: input.summary, model: configuration.model })
    return invocation.task.rename({ title: result.text, expectedRevision: task.titleRevision })
  })
}

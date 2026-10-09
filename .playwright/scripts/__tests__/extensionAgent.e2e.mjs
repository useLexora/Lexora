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
    const tool = body.tools.find(tool => tool.function.name.startsWith('lexora_plugin_') && tool.function.description.includes('Generate and save a concise title'))
    const search = body.tools.find(tool => tool.function.name === 'lexora_tool_search')
    const last = body.messages.at(-1)
    const discovered = last.role === 'tool' && String(last.content).includes('alreadyDisclosed')
    if (!tool && search?.function.description.includes('Generate and save a concise title') && last.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: `search-${requests.length}`, type: 'function', function: { name: search.function.name, arguments: JSON.stringify({ query: '生成标题', limit: 1 }) } }] }, 'tool_calls')
    }
    else if (tool && (last.role !== 'tool' || discovered)) {
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
    expect(JSON.stringify(requests[0].messages)).not.toContain('proactively')
    expect(requests[0].tools.some(tool => tool.function.name.startsWith('lexora_plugin_'))).toBe(false)
    expect(requests[0].tools.some(tool => tool.function.name === 'lexora_host_shell')).toBe(false)
    expect(requests[0].tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'grep', 'find', 'ls', 'lexora_web_search', 'lexora_web_fetch', 'lexora_output_present', 'lexora_authorize_directory', 'lexora_tool_search']))
    expect(requests[0].tools.find(tool => tool.function.name === 'lexora_tool_search').function.description).toContain('生成标题')
    const disclosed = requests.find(body => body.tools?.some(tool => tool.function.name.startsWith('lexora_plugin_')))
    expect(JSON.stringify(disclosed.messages)).toContain('proactively')
    const pluginToolName = disclosed.tools.find(tool => tool.function.description.includes('Generate and save a concise title')).function.name
    await expect(page.getByText('生成标题 1', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: '搜索 1 次 · 工具调用 1 次', exact: true }).click()
    const pluginRow = page.locator('.buddy-chat-tool').filter({ has: page.locator('.buddy-chat-tool__summary', { hasText: '标题自动生成 · 生成标题' }) })
    await expect(pluginRow.locator('.buddy-chat-tool__title')).toHaveText('工具调用')
    await expect(pluginRow.locator('.buddy-chat-tool__summary')).toHaveText('标题自动生成 · 生成标题')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'plugin-tool-row.png'), animations: 'disabled' })

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

    await instance.stop()
    ;({ app, page, diagnostics } = await instance.launch())
    await syntheticCredentials(app, page)
    await taskPage()
    const resumedRequests = requests.length
    await send('重启后继续同一任务')
    await settled()
    expect(requests[resumedRequests].tools.some(tool => tool.function.name === pluginToolName)).toBe(true)
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
    return invocation.task.rename({ title: result.text })
  })
}

test('background plugin actions join their reply flow while preserving protected titles and independent usage', async ({ buddy }) => {
  test.setTimeout(180000)
  const requests = []
  const pending = []
  let hold = true
  let fail = false
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
    const background = !body.tools?.length
    if (background && fail) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Fixture title generation failed', type: 'invalid_request_error' } }))
      return
    }
    const content = background ? `后台标题 ${++generated}` : '任务回答已完成。'
    const finish = () => {
      const common = { id: `action-${requests.length}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!background)
        response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '检查任务目标和执行步骤。' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    if (background && hold)
      pending.push(finish)
    else finish()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('background-title')
  try {
    const { app, page, diagnostics } = await instance.launch()
    await syntheticCredentials(app, page)
    await page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'title-fixture', displayName: 'Title fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'primary', name: 'primary', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
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
    const source = process.env.LEXORA_TEST_ACTION_PLUGIN ?? path.join(instance.home, 'action-fixture')
    if (!process.env.LEXORA_TEST_ACTION_PLUGIN)
      await writeActionFixture(source)
    const previous = process.env.LEXORA_TEST_ACTION_PLUGIN_PREVIOUS
    if (previous) {
      await app.evaluate(({ dialog }, previous) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [previous] })
      }, previous)
      await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
      await page.getByTestId('extension-install-options').click()
      await page.getByTestId((await fs.stat(previous)).isDirectory() ? 'extension-development' : 'extension-install').click()
      await page.getByTestId('extension-confirm-install').click()
      await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.extensions.list()).length)).toBe(1)
      await page.evaluate(async () => {
        const plugin = (await window.lexoraDesktop.extensions.list())[0]
        await window.lexoraDesktop.extensions.configure(plugin.manifest.id, { enabled: false, model: { providerId: 'title-fixture', modelId: 'primary' }, updateOnGoalChange: true })
      })
    }
    const development = (await fs.stat(source)).isDirectory()
    await page.reload()
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
    }, source)
    await page.getByTestId('extension-install-options').click()
    await page.getByTestId(development ? 'extension-development' : 'extension-install').click()
    await expect(page.getByText('读取任务消息', { exact: true })).toBeVisible()
    await page.getByTestId('extension-confirm-install').click()
    await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.extensions.list()).length)).toBe(1)
    const pluginId = await page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].manifest.id)
    if (previous) {
      await expect.poll(() => page.evaluate(async () => !!(await window.lexoraDesktop.extensions.list())[0].pending)).toBe(true)
      await page.locator(`[data-extension-id="${pluginId}"]`).getByTestId('extension-card-more').click()
      await page.getByTestId('extension-restart').click()
      await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].pending)).toBeNull()
      expect(await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)).toMatchObject({ enabled: false, model: { providerId: 'title-fixture', modelId: 'primary' }, updateOnGoalChange: true })
      await page.evaluate(id => window.lexoraDesktop.extensions.configure(id, { enabled: true, model: null, updateOnGoalChange: false }), pluginId)
    }

    const declaredActions = await page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].manifest.contributes.agent.actions)
    const manualAction = declaredActions.find(action => action.triggers.includes('user'))
    const pluginSettings = await page.evaluate(async () => (await window.lexoraDesktop.extensions.list())[0].manifest.contributes.settings.items)
    await page.locator(`[data-extension-id="${pluginId}"]`).getByRole('button', { name: '打开', exact: true }).click()
    const master = page.locator(`[data-setting-id="${pluginId}.enabled"]`).getByRole('switch')
    const model = page.locator(`[data-setting-id="${pluginId}.model"] .plugin-model-setting__select`)
    const updates = page.locator(`[data-setting-id="${pluginSettings.find(item => item.key === 'updateOnGoalChange').id}"]`).getByRole('switch')
    await page.evaluate(id => window.lexoraDesktop.extensions.configure(id, { updateOnGoalChange: true }), pluginId)
    await expect(updates).toBeChecked()
    const preservedConfiguration = await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)
    await expect(master).toBeChecked()
    await expect(model).toBeEnabled()
    await master.click()
    await expect(model).toBeDisabled()
    await expect(updates).toBeDisabled()
    await expect(master).toBeEnabled()
    const disabledConfiguration = await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)
    expect(disabledConfiguration).toEqual({ ...preservedConfiguration, enabled: false })
    await expect(updates).toBeChecked()
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'title-settings-disabled.png'), animations: 'disabled' })
    await page.reload()
    await expect(model).toBeDisabled()
    await master.click()
    await expect(model).toBeEnabled()
    await expect(updates).toBeEnabled()
    expect(await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), pluginId)).toEqual(preservedConfiguration)
    await page.evaluate(id => window.lexoraDesktop.extensions.configure(id, { updateOnGoalChange: false }), pluginId)

    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
    const latest = () => rows(instance.home, 'SELECT * FROM conversations ORDER BY created_at DESC LIMIT 1')[0]
    async function send(text, fresh = false) {
      if (fresh) {
        await page.getByRole('button', { name: '新任务', exact: true }).click()
        await expect(page.locator('.desktop-chat-workspace-header__copy:visible')).toHaveText('新任务')
        await expect(page.locator('.desktop-chat-page.is-empty:not(.is-loading):visible')).toBeVisible()
      }
      const before = rows(instance.home, 'SELECT id FROM runs').length
      await page.locator('.desktop-chat-composer__prosemirror:visible').fill(text)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect.poll(() => rows(instance.home, 'SELECT id FROM runs').length).toBe(before + 1)
      await expect.poll(() => rows(instance.home, 'SELECT id FROM runs WHERE status IN (\'queued\', \'running\')').length).toBe(0)
    }
    const settled = () => expect.poll(() => rows(instance.home, 'SELECT id FROM extension_invocations WHERE status = \'running\'').length).toBe(0)
    const backgroundRequests = () => requests.filter(body => !body.tools?.length).length
    async function expectActionInReplyFlow(status, target = page) {
      const invocation = rows(instance.home, `SELECT id FROM extension_invocations WHERE conversation_id = '${latest().id}' AND action_title = '重新生成标题' AND status = '${status}' ORDER BY started_at DESC LIMIT 1`)[0]
      expect(invocation).toBeDefined()
      const run = rows(instance.home, `SELECT id FROM runs WHERE conversation_id = '${latest().id}' ORDER BY started_at DESC LIMIT 1`)[0]
      const flow = target.locator(`[data-chat-row-key="agent-turn:${run.id}"]`)
      await expect(flow).toBeVisible()
      const collapsed = flow.locator('.buddy-chat-activity-group__header[aria-expanded="false"]')
      for (const header of await collapsed.all())
        await header.click()
      const tool = flow.locator(`[data-action-id="${invocation.id}"]`)
      await expect(tool).toBeVisible()
      await expect(tool).toHaveAttribute('data-action-status', status)
      await expect(tool.locator('.buddy-chat-tool__title')).toHaveText('工具调用')
      await expect(tool.locator('.buddy-chat-tool__summary')).toHaveText('重新生成标题')
      await expect(target.locator(`[data-chat-row-key="extension-action:${invocation.id}"]`)).toHaveCount(0)
      await expect.poll(async () => {
        const process = await flow.boundingBox()
        const answer = await target.locator('.buddy-chat-message-list .buddy-chat-message.is-assistant').last().boundingBox()
        return !!process && !!answer && process.y + process.height <= answer.y
      }).toBe(true)
    }
    await send('整理项目发布计划')
    await expect.poll(() => pending.length).toBe(1)
    await expect(page.locator('.buddy-chat-message-list .buddy-chat-message.is-assistant')).toContainText('任务回答已完成。')
    await expectActionInReplyFlow('running')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'background-title-running.png'), animations: 'disabled' })
    expect(latest().title_source).toBe('fallback')
    expect(rows(instance.home, 'SELECT status FROM runs')).toEqual([{ status: 'completed' }])
    expect(requests.filter(body => body.tools?.length).every(body => !body.tools.some(tool => tool.function.name.startsWith('lexora_plugin_')))).toBe(true)
    pending.shift()()
    await settled()
    expect(latest()).toMatchObject({ title: '后台标题 1', title_source: 'generated' })
    await expectActionInReplyFlow('completed')
    const savedTimeline = await page.evaluate(conversationId => window.lexoraDesktop.localChat.conversations.listTimeline({ conversationId }), latest().id)
    expect(savedTimeline.items.filter(item => item.kind === 'extension-action')).toEqual(expect.arrayContaining([expect.objectContaining({ extensionId: pluginId, title: '重新生成标题', status: 'completed', branchId: latest().active_branch_id })]))
    await page.reload()
    await expect(page.locator('.buddy-chat-message-list .buddy-chat-message.is-assistant')).toContainText('任务回答已完成。')
    await expectActionInReplyFlow('completed')
    const identities = page.locator('.buddy-chat-message-list .buddy-chat-agent-identity')
    await expect(identities).toHaveCount(1)
    const identityBounds = await identities.boundingBox()
    const answerBounds = await page.locator('.buddy-chat-message-list .buddy-chat-message.is-assistant').boundingBox()
    expect(identityBounds.y + identityBounds.height).toBeLessThanOrEqual(answerBounds.y)

    expect(rows(instance.home, 'SELECT run_id, invocation_id, purpose FROM usage_records WHERE purpose = \'extension.action\'')).toEqual([{ run_id: null, invocation_id: expect.any(String), purpose: 'extension.action' }])
    const inputActions = declaredActions.filter(action => action.triggers.includes('task:input:committed')).map(action => action.id).sort()
    expect(rows(instance.home, 'SELECT action_id, status FROM extension_invocations WHERE trigger = \'task:input:committed\' ORDER BY action_id')).toEqual(inputActions.map(action_id => ({ action_id, status: 'completed' })))
    await expect(page.locator('.buddy-chat-agent-turn [data-action-id]')).toHaveCount(inputActions.length)
    const status = await page.evaluate(conversationId => window.lexoraDesktop.localChat.runs.status({ conversationId }), latest().id)
    expect(status.tokens.totals).toMatchObject({ totalTokens: 60, recordCount: 2 })
    expect(status.tokens.byPurpose.find(entry => entry.purpose === 'extension.action')).toMatchObject({ totalTokens: 30, recordCount: 1 })
    expect(status.tokens.byModel).toMatchObject([{ modelId: 'primary', totalTokens: 60, runCount: 1 }])
    expect(status.activity.runs.chat.total).toBe(1)
    await send('补充测试范围')
    await settled()
    expect(backgroundRequests()).toBe(1)

    await page.evaluate(id => window.lexoraDesktop.localChat.conversations.rename(id, '手动保留'), latest().id)
    await send('继续完成细节')
    await settled()
    expect(backgroundRequests()).toBe(1)
    const taskId = latest().id
    const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'))
    database.prepare('UPDATE conversations SET title_revision = 0 WHERE id = ?').run(taskId)
    database.close()
    await send('历史标题也应保留')
    await settled()
    expect(backgroundRequests()).toBe(1)

    hold = false
    if (manualAction) {
      await page.locator('[data-workbench-menu="task.actions"]:visible').click()
      await page.locator('.n-dropdown-menu').getByText(manualAction.title, { exact: true }).click()
    }
    else {
      await expect(page.locator('[data-workbench-menu="task.actions"]:visible')).toHaveCount(0)
      await send('整理下一项任务的发布计划', true)
    }
    await expect.poll(() => latest().title).toBe('后台标题 2')
    await settled()
    await expectActionInReplyFlow('completed')
    await page.evaluate(id => window.lexoraDesktop.extensions.configure(id, { updateOnGoalChange: true }), pluginId)
    await send('把主目标调整为插件架构评审')
    await expect.poll(() => latest().title).toBe('后台标题 3')
    await settled()
    await expectActionInReplyFlow('completed')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'generated-task-title.png'), animations: 'disabled' })

    hold = true
    if (manualAction) {
      await page.locator('[data-workbench-menu="task.actions"]:visible').click()
      await page.locator('.n-dropdown-menu').getByText(manualAction.title, { exact: true }).click()
    }
    else {
      await send('验证手动命名优先', true)
    }
    await expect.poll(() => pending.length).toBe(1)
    await expectActionInReplyFlow('running')
    await page.evaluate(id => window.lexoraDesktop.localChat.conversations.rename(id, '用户最终命名'), latest().id)
    pending.shift()()
    await settled()
    expect(latest().title).toBe('用户最终命名')

    hold = false
    fail = true
    await send('标题生成失败时保留正常回答', true)
    await settled()
    const failedAction = page.locator('[data-action-status="failed"]').filter({ hasText: '重新生成标题' })
    const issue = page.locator('.buddy-chat-message-list').getByRole('button', { name: '1 项异常', exact: true })
    await expect(failedAction.or(issue).first()).toBeVisible()
    if (await issue.isVisible())
      await issue.click()
    await expect(failedAction).toBeVisible()
    await expectActionInReplyFlow('failed')
    expect(latest().title_source).toBe('fallback')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'title-action-failure.png'), animations: 'disabled' })

    hold = true
    fail = false
    await send('停用插件时保留输入标题', true)
    await expect.poll(() => pending.length).toBe(1)
    const original = latest().title
    const runningIds = new Set(rows(instance.home, 'SELECT id FROM extension_invocations WHERE status = \'running\'').map(action => action.id))
    await page.evaluate(id => window.lexoraDesktop.extensions.enable(id, false), pluginId)
    pending.shift()()
    await settled()
    expect(latest().title).toBe(original)
    const stoppedActions = rows(instance.home, `SELECT id, action_id, status FROM extension_invocations WHERE conversation_id = '${latest().id}'`)
    const stoppedNaming = stoppedActions.filter(action => runningIds.has(action.id))
    expect(stoppedNaming.length).toBeGreaterThan(0)
    expect(stoppedNaming.every(action => action.status === 'cancelled')).toBe(true)
    expect(stoppedActions.every(action => ['cancelled', 'completed', 'skipped'].includes(action.status))).toBe(true)
    await expect(page.locator('[data-workbench-menu="task.actions"]:visible')).toHaveCount(0)
    await expectActionInReplyFlow('cancelled')
    expect(rows(instance.home, 'SELECT id FROM runs WHERE status = \'failed\'')).toEqual([])
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'background-actions.png'), animations: 'disabled' })
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
    const persistedTaskId = latest().id
    const beforeRestart = await page.evaluate(conversationId => window.lexoraDesktop.localChat.conversations.listTimeline({ conversationId }), persistedTaskId)
    await instance.stop()
    const restarted = await instance.launch()
    await expect(restarted.page.locator('.buddy-chat-message-list .buddy-chat-message.is-assistant')).toContainText('任务回答已完成。')
    await expectActionInReplyFlow('cancelled', restarted.page)
    const afterRestart = await restarted.page.evaluate(conversationId => window.lexoraDesktop.localChat.conversations.listTimeline({ conversationId }), persistedTaskId)
    expect(afterRestart.items.filter(item => item.kind === 'extension-action')).toEqual(beforeRestart.items.filter(item => item.kind === 'extension-action'))
    expect(afterRestart.runs).toEqual(beforeRestart.runs)
    expect(restarted.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

async function writeActionFixture(directory) {
  const id = 'tests.actions'
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'extension.json'), JSON.stringify({
    schemaVersion: 1,
    id,
    name: '后台动作测试',
    version: '1.0.0',
    apiVersion: 3,
    engines: { lexora: '*' },
    entry: 'extension.js',
    permissions: { agent: true, models: true, tasks: 'title', taskMessages: true },
    contributes: {
      conditions: [{ id: `${id}.available`, inputs: ['configuration', 'form'] }],
      settings: { items: [
        { id: `${id}.enabled`, key: 'enabled', group: 'settings.general.general', type: 'boolean', title: '启用', default: true },
        { id: `${id}.updates`, key: 'updateOnGoalChange', group: 'settings.general.general', type: 'boolean', title: '允许更新', default: false, enabledWhen: { condition: `${id}.available` } },
        { id: `${id}.model`, key: 'model', group: 'settings.general.general', type: 'model', title: '模型', default: null, enabledWhen: { condition: `${id}.available` } },
      ] },
      agent: { enabledWhen: 'enabled', actions: [
        { id: `${id}.generate`, title: '重新生成标题', triggers: ['task:input:committed', 'task:turn:completed', 'user'] },
        ...Array.from({ length: 15 }, (_, index) => ({ id: `${id}.read${index}`, title: `Read ${index}`, triggers: ['task:input:committed'] })),
      ] },
    },
  }))
  await fs.writeFile(path.join(directory, 'extension.js'), `export const activate = ${activateActionFixture.toString()}`)
}

function activateActionFixture(context) {
  context.conditions.register(`${context.extension.id}.available`, ctx => ctx.configuration.status === 'available' && ctx.configuration.values.enabled === true)
  for (let index = 0; index < 15; index++) {
    context.agent.registerAction(`${context.extension.id}.read${index}`, async (invocation) => {
      await invocation.task.messages()
      return { status: 'completed' }
    })
  }
  context.agent.registerAction(`${context.extension.id}.generate`, async (invocation) => {
    const config = await context.configuration.get()
    const task = await invocation.task.get()
    const cause = invocation.cause.type
    if (cause !== 'user' && ['manual', 'legacy'].includes(task.titleSource))
      return { status: 'skipped' }
    if (cause === 'task:input:committed' && task.titleSource !== 'fallback')
      return { status: 'skipped' }
    const messages = await invocation.task.messages()
    if (cause === 'task:turn:completed' && (!config.updateOnGoalChange || task.titleSource !== 'generated' || messages.filter(message => message.role === 'user').length < 2))
      return { status: 'skipped' }
    const result = await invocation.models.generateText({ prompt: JSON.stringify(messages) })
    const saved = await invocation.task.rename({ title: result.text })
    return { status: saved.applied ? 'completed' : 'skipped' }
  })
}

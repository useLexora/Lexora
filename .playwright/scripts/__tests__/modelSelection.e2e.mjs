import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

test('model controls preview dragging, commit on release and retain advanced panel selections', async ({ buddy }) => {
  const instance = await buddy.createInstance('model-selection')
  const desktop = await instance.launch()
  const { page } = desktop
  await useSyntheticCredentialStorage(desktop)
  const model = await page.evaluate(async () => {
    const providers = window.lexoraDesktop.localChat.providers
    const provider = await providers.add('openai')
    const stop = providers.onAuthChallenge((challenge) => {
      if (challenge.providerId === provider.id && challenge.type === 'secret')
        void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
    })
    try {
      await providers.login(provider.id, 'api_key')
    }
    finally {
      stop()
    }
    const model = (await providers.listModels(provider.id)).find(model => model.reasoningOptions.length > 2 && model.serviceTiers.some(tier => tier.id === 'priority'))
    if (!model)
      throw new Error('The offline catalog must include a reasoning model with fast mode')
    await providers.setModelEnabled(provider.id, model.modelId, true)
    await providers.setEnabled(provider.id, true)
    await providers.setDefaultModel({ providerId: provider.id, modelId: model.modelId, reasoning: model.reasoningOptions[0] })
    return model
  })
  await page.reload()
  const trigger = page.locator('.desktop-model-selector__trigger:visible')
  await expect(trigger).toBeEnabled()
  const initialLabel = await trigger.getAttribute('aria-label')
  await trigger.click()
  const slider = page.getByRole('slider')
  await expect(slider).toBeVisible()
  const targetIndex = Number(await slider.inputValue()) === model.reasoningOptions.length - 1 ? 0 : model.reasoningOptions.length - 1
  const bounds = await slider.boundingBox()
  await page.mouse.move(bounds.x + 4, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + (targetIndex === 0 ? 4 : bounds.width - 4), bounds.y + bounds.height / 2, { steps: 6 })
  await expect(slider).toHaveValue(String(targetIndex))
  const finalLevel = await slider.getAttribute('aria-valuetext')
  await expect(trigger).toHaveAttribute('aria-label', initialLabel)
  await expect(page.locator('.desktop-model-selector__dragging-effort')).toHaveText(finalLevel)
  await page.mouse.up()
  await expect(trigger).toHaveAttribute('aria-label', `${model.displayName} · ${finalLevel}`)
  await expect(slider).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(slider).toBeHidden()
  await trigger.click()
  await expect(slider).toHaveValue(String(targetIndex))

  const fastMode = page.getByRole('switch', { name: 'Fast', exact: true })
  await fastMode.click()
  await expect(fastMode).toBeChecked()
  await page.locator('.desktop-model-selector__advanced').click()
  const advanced = page.locator('.desktop-model-selector__panel--advanced')
  const speed = advanced.getByRole('menuitemcheckbox')
  await expect(speed).toBeChecked()
  await speed.click()
  await expect(speed).not.toBeChecked()
  await advanced.getByRole('button', { name: /^模型/ }).click()
  const models = page.locator('.desktop-model-picker')
  await expect(models).toBeVisible()
  await models.getByPlaceholder('搜索模型…').fill(model.displayName)
  await models.getByRole('menuitemradio', { name: `${model.displayName} ${model.modelId}`, exact: true }).click()
  await expect(trigger).toContainText(model.displayName)
  await advanced.locator('.desktop-model-selector__back').click()
  await expect(slider).toBeVisible()
  await expect(fastMode).not.toBeChecked()
  const advancedValue = await slider.inputValue()
  await page.keyboard.press('Escape')
  await expect(slider).toBeHidden()
  await trigger.click()
  await expect(slider).toHaveValue(advancedValue)
  await page.keyboard.press('Escape')
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('live model and permission controls resume retries, revoke approvals and regenerate with the current model', async ({ buddy }, testInfo) => {
  const requests = []
  let requestedWrite = false
  let gatedResponse = null
  let releaseResponse = () => {}
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    if (body.model === 'model-a') {
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Service temporarily unavailable', type: 'server_error' } }))
      return
    }
    const write = !requestedWrite
    requestedWrite = true
    await gatedResponse
    const common = { id: `live-${requests.length}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
    const delta = write
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'pending-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'hot-permission.txt', content: 'This write must be blocked.' }) } }] }
      : { role: 'assistant', content: 'The current model completed the task.' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: write ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('live-model-permissions')
  try {
    const desktop = await instance.launch()
    await useSyntheticCredentialStorage(desktop)
    const { page } = desktop
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ runtime: { modelRetryLimit: 'unlimited' } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'live-fixture', displayName: 'Live fixture', api: 'openai-completions', baseUrl, enabled: true, models: ['a', 'b'].map(id => ({ id: `model-${id}`, name: `Model ${id.toUpperCase()}`, input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 })) })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'live-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('live-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'live-fixture', modelId: 'model-a', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('Keep this input while changing model and permissions.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.locator('.buddy-chat-run-activity')).toContainText('秒后重试')
    await page.locator('.desktop-permission-mode-selector__trigger:visible').click()
    for (const name of ['本机只读', '人工审批', '智能审批', '完全访问'])
      await expect(page.getByRole('menuitemradio', { name: new RegExp(name) })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('running-permission-menu.png'), animations: 'disabled' })
    await page.getByRole('menuitemradio', { name: /人工审批/ }).click()
    await expect(page.locator('.desktop-permission-mode-selector__trigger:visible')).toContainText('人工审批')
    const trigger = page.locator('.desktop-model-selector__trigger:visible')
    await trigger.click()
    await page.locator('.desktop-model-selector__advanced').click()
    await page.locator('.desktop-model-selector__panel--advanced').getByRole('button', { name: /^模型/ }).click()
    await page.screenshot({ path: testInfo.outputPath('running-model-menu.png'), animations: 'disabled' })
    await page.locator('.desktop-model-picker').getByRole('menuitemradio', { name: 'Model B model-b', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(trigger).toContainText('Model B')
    const read = query => readModelDatabase(instance.home, query)
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE status = ?').get('pending').count)).toBe(1)
    const approval = read(db => db.prepare('SELECT id FROM approvals WHERE status = ?').get('pending'))
    await page.locator('.desktop-permission-mode-selector__trigger:visible').click()
    await page.screenshot({ path: testInfo.outputPath('approval-permission-menu.png'), animations: 'disabled' })
    await page.getByRole('menuitemradio', { name: /本机只读/ }).click()
    await expect.poll(() => read(db => db.prepare('SELECT status FROM approvals WHERE id = ?').get(approval.id).status)).toBe('cancelled')
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(1)
    expect(requests.filter(body => body.model === 'model-b')).toHaveLength(2)
    expect(requests.at(-1).messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('READ_ONLY_PROFILE'))).toBe(true)
    expect(JSON.stringify(requests.at(-1).messages)).toContain('Writing and deleting are blocked in this profile')
    const first = read(db => db.prepare('SELECT id, model, conversation_id FROM runs ORDER BY started_at LIMIT 1').get())
    const firstAnswer = read(db => db.prepare('SELECT id, content_json FROM messages WHERE run_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1').get(first.id, 'assistant'))
    expect(first.model).toBe('model-a')
    expect(JSON.parse(firstAnswer.content_json).modelId).toBe('model-b')
    await expect(page.locator('.desktop-permission-mode-selector__trigger:visible')).toContainText('本机只读')
    const regenerate = page.getByTestId(`regenerate-message-${firstAnswer.id}`)
    await page.locator(`[data-message-id="${firstAnswer.id}"]`).hover()
    await page.screenshot({ path: testInfo.outputPath('current-model-regenerate-hover.png'), animations: 'disabled' })
    await regenerate.click()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(2)
    expect(requests.at(-1).model).toBe('model-b')
    for (const body of requests)
      expect(body.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(read(db => JSON.parse(db.prepare('SELECT model_selection_json FROM conversations WHERE id = ?').get(first.conversation_id).model_selection_json).modelId)).toBe('model-b')
    await expect(trigger).toContainText('Model B')

    requestedWrite = false
    const responseGate = Promise.withResolvers()
    gatedResponse = responseGate.promise
    releaseResponse = () => {
      gatedResponse = null
      responseGate.resolve()
    }
    const beforeReview = requests.length
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('/review inspect the current task')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => requests.length).toBe(beforeReview + 1)
    await page.locator('.desktop-permission-mode-selector__trigger:visible').click()
    await page.getByRole('menuitemradio', { name: /完全访问/ }).click()
    await page.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }).check()
    await page.getByRole('button', { name: '允许完全访问', exact: true }).click()
    await expect(page.locator('.desktop-permission-mode-selector__trigger:visible')).toContainText('完全访问')
    releaseResponse()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(3)
    expect(requests.at(-1).messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('READ_ONLY_PROFILE'))).toBe(true)
    const taskFile = path.join(instance.home, 'buddy/conversations', first.conversation_id, 'workspace/hot-permission.txt')
    await expect(readFile(taskFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await page.locator('.desktop-permission-mode-selector__trigger:visible').click()
    await page.getByRole('menuitemradio', { name: /本机只读/ }).click()
    const ordinaryGate = Promise.withResolvers()
    gatedResponse = ordinaryGate.promise
    releaseResponse = () => {
      gatedResponse = null
      ordinaryGate.resolve()
    }
    const beforeOrdinary = requests.length
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('Inspect before the queued review.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => requests.length).toBe(beforeOrdinary + 1)
    const ordinary = read(db => db.prepare('SELECT id, execution_profile FROM runs WHERE status = ?').get('running'))
    expect(ordinary.execution_profile).toBe('read_only')
    await page.locator('.desktop-permission-mode-selector__trigger:visible').click()
    await page.getByRole('menuitemradio', { name: /完全访问/ }).click()
    await page.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }).check()
    await page.getByRole('button', { name: '允许完全访问', exact: true }).click()
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('/review inspect without changing anything')
    await page.getByRole('button', { name: '加入队列', exact: true }).click()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM chat_queue WHERE state = ?').get('waiting').count)).toBe(1)
    requestedWrite = false
    releaseResponse()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(5)
    const queuedReview = read(db => db.prepare('SELECT state, run_id FROM chat_queue ORDER BY rowid DESC LIMIT 1').get())
    expect(queuedReview.state).toBe('sent')
    expect(queuedReview.run_id).not.toBe(ordinary.id)
    expect(read(db => db.prepare('SELECT execution_profile FROM runs WHERE id = ?').get(queuedReview.run_id).execution_profile)).toBe('read_only')
    expect(requests).toHaveLength(beforeOrdinary + 3)
    expect(JSON.stringify(requests.at(-1).messages.findLast(message => message.role === 'tool')?.content)).toContain('READ_ONLY_PROFILE')
    await expect(readFile(taskFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(page.locator('.chat-message-queue__row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('queued-review-read-only.png'), animations: 'disabled' })

    requestedWrite = false
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('Create the file for an ordinary task.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(6)
    expect(await readFile(taskFile, 'utf8')).toBe('This write must be blocked.')
    expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    releaseResponse()
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

function readModelDatabase(home, query) {
  const database = new DatabaseSync(path.join(home, 'buddy/buddy.sqlite3'), { readOnly: true })
  try {
    return query(database)
  }
  finally {
    database.close()
  }
}

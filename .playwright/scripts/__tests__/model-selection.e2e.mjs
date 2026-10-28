import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'
import { selectComposerModel, selectComposerPermission } from '../fixtures/model-controls.mjs'

test('model controls commit effort on release and retain effort and speed across panels', async ({ buddy }) => {
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

  const fastMode = page.getByRole('switch', { name: 'Fast', exact: true })
  await fastMode.click()
  await expect(fastMode).toBeChecked()
  await page.locator('.desktop-model-selector__advanced').click()
  const advanced = page.locator('.desktop-model-selector__panel--advanced')
  const speed = advanced.getByRole('menuitemcheckbox')
  await expect(speed).toBeChecked()
  await speed.click()
  await expect(speed).not.toBeChecked()
  await advanced.locator('.desktop-model-selector__back').click()
  await expect(slider).toBeVisible()
  await expect(fastMode).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(slider).toBeHidden()
  await trigger.click()
  await expect(slider).toHaveValue(String(targetIndex))
  await expect(fastMode).not.toBeChecked()
  await page.keyboard.press('Escape')
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('live model selection resumes retries and regeneration while permissions revoke approvals and constrain an API queued review', async ({ buddy }) => {
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
    const models = await page.evaluate(async (baseUrl) => {
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
      return providers.listModels('live-fixture')
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('Keep this input while changing model and permissions.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.locator('.buddy-chat-run-activity')).toContainText('秒后重试')
    await selectComposerPermission(page, '人工审批')
    await expect(page.locator('.desktop-permission-mode-selector__trigger:visible')).toContainText('人工审批')
    const trigger = page.locator('.desktop-model-selector__trigger:visible')
    await selectComposerModel(page, models.find(model => model.modelId === 'model-b'), null)
    await expect(trigger).toContainText('Model B')
    const read = query => readModelDatabase(instance.home, query)
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE status = ?').get('pending').count)).toBe(1)
    const approval = read(db => db.prepare('SELECT id FROM approvals WHERE status = ?').get('pending'))
    await selectComposerPermission(page, '本机只读')
    await expect.poll(() => read(db => db.prepare('SELECT status FROM approvals WHERE id = ?').get(approval.id).status)).toBe('cancelled')
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(1)
    expect(requests.filter(body => body.model === 'model-b')).toHaveLength(2)
    expect(requests.at(-1).messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('READ_ONLY_PROFILE'))).toBe(true)
    expect(JSON.stringify(requests.at(-1).messages)).toContain('File tools block writing and deleting in this profile, and no approval can lift that.')
    const first = read(db => db.prepare('SELECT id, model, conversation_id FROM runs ORDER BY started_at LIMIT 1').get())
    const firstAnswer = read(db => db.prepare('SELECT id, content_json FROM messages WHERE run_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1').get(first.id, 'assistant'))
    expect(first.model).toBe('model-a')
    expect(JSON.parse(firstAnswer.content_json).modelId).toBe('model-b')
    await expect(page.locator('.desktop-permission-mode-selector__trigger:visible')).toContainText('本机只读')
    const regenerate = page.getByTestId(`regenerate-run-${first.id}`)
    await expect(regenerate).toBeVisible()
    await regenerate.click()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(2)
    expect(requests.at(-1).model).toBe('model-b')
    for (const body of requests)
      expect(body.messages.filter(message => message.role === 'user')).toHaveLength(1)
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
    await selectComposerPermission(page, '完全访问')
    await expect(page.locator('.desktop-permission-mode-selector__trigger:visible')).toContainText('完全访问')
    releaseResponse()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(3)
    expect(requests[beforeReview].tools.some(tool => tool.function?.name === 'write')).toBe(false)
    expect(JSON.stringify(requests.at(-1).messages.findLast(message => message.role === 'tool')?.content)).toContain('Tool write not found')
    const taskFile = path.join(instance.home, 'buddy/conversations', first.conversation_id, 'workspace/hot-permission.txt')
    await expect(readFile(taskFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await selectComposerPermission(page, '本机只读')
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
    await selectComposerPermission(page, '完全访问')
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('/review inspect without changing anything')
    await enqueueComposerThroughApi(page, read, ordinary.id, 'next')
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM chat_queue WHERE state = ?').get('waiting').count)).toBe(1)
    requestedWrite = false
    releaseResponse()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)).toBe(5)
    const queuedReview = read(db => db.prepare('SELECT state, run_id FROM chat_queue ORDER BY rowid DESC LIMIT 1').get())
    expect(queuedReview.state).toBe('sent')
    expect(queuedReview.run_id).not.toBe(ordinary.id)
    expect(read(db => db.prepare('SELECT execution_profile FROM runs WHERE id = ?').get(queuedReview.run_id).execution_profile)).toBe('read_only')
    expect(requests).toHaveLength(beforeOrdinary + 3)
    expect(requests[beforeOrdinary + 1].tools.some(tool => tool.function?.name === 'write')).toBe(false)
    expect(JSON.stringify(requests.at(-1).messages.findLast(message => message.role === 'tool')?.content)).toContain('Tool write not found')
    await expect(readFile(taskFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(page.locator('.chat-message-queue__row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()

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

test('API queued steering uses live permissions and explicit next input starts with the latest settings', async ({ buddy }) => {
  const requests = []
  const gates = new Map([0, 2].map(index => [index, Promise.withResolvers()]))
  const instance = await buddy.createInstance('queue-live-permissions')
  const file = path.join(instance.home, 'queue-fixture.txt')
  await writeFile(file, 'A safe input for the queued steering test.')
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    const index = requests.length
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    await gates.get(index)?.promise
    const common = { id: `queue-${index}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
    const delta = index === 0
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'queue-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] }
      : { role: 'assistant', content: 'The queued input was received.' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: index === 0 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const desktop = await instance.launch()
    await useSyntheticCredentialStorage(desktop)
    const { page } = desktop
    await page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'queue-fixture', displayName: 'Queue fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'queue-model', name: 'Queue model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'queue-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('queue-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'queue-fixture', modelId: 'queue-model', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    const read = query => readModelDatabase(instance.home, query)
    const composer = page.locator('.desktop-chat-composer__prosemirror:visible')
    const permission = page.locator('.desktop-permission-mode-selector__trigger:visible')
    await composer.fill('Read the fixture and wait for additional instructions.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    const first = read(db => db.prepare('SELECT id, approval_policy, execution_profile FROM runs WHERE status = ?').get('running'))
    expect(first.execution_profile).toBe('workspace_write')
    await selectComposerPermission(page, '完全访问')
    await expect(permission).toContainText('完全访问')
    await composer.fill('Include this immediate instruction after the permission change.')
    await enqueueComposerThroughApi(page, read, first.id)
    await expect(page.locator('.chat-message-queue__row')).toHaveCount(1)
    await page.getByRole('button', { name: '立即发送', exact: true }).click()
    await expect.poll(() => read(db => db.prepare('SELECT state, run_id FROM chat_queue ORDER BY rowid DESC LIMIT 1').get())).toEqual({ state: 'sent', run_id: first.id })
    await expect(page.locator('.chat-message-queue__row')).toHaveCount(0)
    gates.get(0).resolve()
    await expect.poll(() => read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(first.id).status)).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].messages)).toContain('Include this immediate instruction after the permission change.')
    expect(JSON.stringify(requests[1].messages)).toContain('Full access does not grant root privileges')
    expect(read(db => db.prepare('SELECT id, approval_policy, execution_profile FROM runs WHERE id = ?').get(first.id))).toEqual(first)

    await composer.fill('Finish the current turn before processing the queued follow-up.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => requests.length).toBe(3)
    const second = read(db => db.prepare('SELECT id, approval_policy, execution_profile FROM runs WHERE status = ?').get('running'))
    expect(second.execution_profile).toBe('full_access')
    await composer.fill('Process this queued follow-up with the latest read-only permissions.')
    await enqueueComposerThroughApi(page, read, second.id, 'next')
    await expect(page.locator('.chat-message-queue__row')).toHaveCount(1)
    await selectComposerPermission(page, '本机只读')
    await expect(permission).toContainText('本机只读')
    gates.get(2).resolve()
    await expect.poll(() => read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(second.id).status)).toBe('completed')
    await expect.poll(() => requests.length).toBe(4)
    expect(JSON.stringify(requests[3].messages)).toContain('Process this queued follow-up with the latest read-only permissions.')
    expect(JSON.stringify(requests[3].messages)).toContain('File tools block writing and deleting in this profile, and no approval can lift that.')
    const followUp = read(db => db.prepare('SELECT state, run_id FROM chat_queue ORDER BY rowid DESC LIMIT 1').get())
    expect(followUp.state).toBe('sent')
    expect(followUp.run_id).not.toBe(second.id)
    await expect.poll(() => read(db => db.prepare('SELECT status, execution_profile FROM runs WHERE id = ?').get(followUp.run_id))).toEqual({ status: 'completed', execution_profile: 'read_only' })
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM runs').get().count)).toBe(3)
    expect(read(db => db.prepare('SELECT id, approval_policy, execution_profile FROM runs WHERE id = ?').get(second.id))).toEqual(second)
    await expect(page.locator('.chat-message-queue__row')).toHaveCount(0)
    expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    for (const gate of gates.values())
      gate.resolve()
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('switching model and effort during a tool batch immediately supplements the same run without replaying tools', async ({ buddy }) => {
  test.setTimeout(180000)
  const instance = await buddy.createInstance('tool-boundary-model-selection')
  const requests = []
  const errors = []
  let workspace
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request)
        chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(payload)
      const first = requests.length === 1
      const shell = payload.tools.find(tool => tool.function?.name === 'lexora_shell')?.function.name
        ?? payload.tools.find(tool => tool.function?.name === 'bash')?.function.name
      if (first && !shell)
        throw new Error('The bounded tool fixture requires a disclosed shell tool')
      const parameters = command => ({ command, timeout: 120, ...(shell === 'lexora_shell' ? { shell: 'system' } : {}) })
      const calls = first
        ? [
            { index: 0, id: 'gate-once', type: 'function', function: { name: shell, arguments: JSON.stringify(parameters('printf \'gate-once\\n\' >> hot-switch-calls; while [ ! -f hot-switch-release ]; do sleep 0.05; done; printf \'gate complete\'')) } },
            { index: 1, id: 'tail-once', type: 'function', function: { name: shell, arguments: JSON.stringify(parameters('printf \'tail-once\\n\' >> hot-switch-calls')) } },
          ]
        : []
      const common = { id: `hot-${requests.length}`, created: 1, model: payload.model, object: 'chat.completion.chunk' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: first ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: '已在同一轮处理新模型补充。' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    catch (error) {
      errors.push(String(error))
      response.destroy()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const desktop = await instance.launch()
    const { page } = desktop
    await useSyntheticCredentialStorage(desktop)
    const models = await page.evaluate(async (baseUrl) => {
      const api = window.lexoraDesktop.localChat
      await window.lexoraDesktop.settings.update({ desktop: { language: 'zh-CN' }, runtime: { codemode: false, modelRetryLimit: 0 } })
      await api.providers.upsertCustom({ id: 'hot-model-fixture', displayName: 'Hot model fixture', api: 'openai-completions', baseUrl, enabled: true, models: ['a', 'b'].map(suffix => ({ id: `hot-model-${suffix}`, name: `Hot Model ${suffix.toUpperCase()}`, input: ['text'], reasoning: true, contextWindow: 128000, maxTokens: 2048 })) })
      const stop = api.providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'hot-model-fixture' && challenge.type === 'secret')
          void api.providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await api.providers.login('hot-model-fixture', 'api_key')
      }
      finally {
        stop()
      }
      await api.providers.setDefaultModel({ providerId: 'hot-model-fixture', modelId: 'hot-model-a', reasoning: 'low' })
      return api.providers.listModels('hot-model-fixture')
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    await selectComposerModel(page, models.find(model => model.modelId === 'hot-model-a'), 'low')
    await selectComposerPermission(page, '完全访问')
    const editor = page.locator('.desktop-chat-composer__prosemirror:visible')
    await editor.fill('Execute the two bounded fixture tools once, then wait for the supplemental instruction.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const read = query => readModelDatabase(instance.home, query)
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) n FROM runs').get().n)).toBe(1)
    const run = read(db => db.prepare('SELECT id, conversation_id, model FROM runs').get())
    workspace = path.join(instance.home, 'buddy/conversations', run.conversation_id, 'workspace')
    await expect.poll(async () => readFile(path.join(workspace, 'hot-switch-calls'), 'utf8').catch(() => '')).toContain('gate-once')
    expect(read(db => db.prepare('SELECT status FROM runs WHERE id=?').get(run.id).status)).toBe('running')
    const supplemental = 'SWITCHED_INPUT_482：保留工具结果，继续同一项工作。'
    await editor.fill(supplemental)
    await selectComposerModel(page, models.find(model => model.modelId === 'hot-model-b'), 'high')
    await editor.press('Enter')
    await expect(editor).toHaveText('')
    await expect.poll(() => read(db => db.prepare('SELECT state,run_id FROM chat_queue ORDER BY rowid DESC LIMIT 1').get())).toEqual({ state: 'sent', run_id: run.id })
    expect(requests).toHaveLength(1)
    await writeFile(path.join(workspace, 'hot-switch-release'), 'release')
    await expect.poll(() => read(db => db.prepare('SELECT status FROM runs WHERE id=?').get(run.id).status)).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(requests.map(request => [request.model, request.reasoning_effort])).toEqual([['hot-model-a', 'low'], ['hot-model-b', 'high']])
    expect(JSON.stringify(requests[1].messages)).toContain(supplemental)
    expect((await readFile(path.join(workspace, 'hot-switch-calls'), 'utf8')).trim().split('\n').sort()).toEqual(['gate-once', 'tail-once'])
    expect(read(db => db.prepare('SELECT id,model FROM runs').all())).toEqual([{ id: run.id, model: 'hot-model-a' }])
    const answer = read(db => db.prepare('SELECT content_json FROM messages WHERE run_id=? AND role=\'assistant\' ORDER BY rowid DESC LIMIT 1').get(run.id))
    expect(JSON.parse(answer.content_json).modelId).toBe('hot-model-b')
    await expect(page.locator('.chat-message-queue__row')).toHaveCount(0)
    expect(errors).toEqual([])
    expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    if (workspace)
      await writeFile(path.join(workspace, 'hot-switch-release'), 'release').catch(() => {})
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

async function enqueueComposerThroughApi(page, read, runId, mode) {
  const run = read(db => db.prepare('SELECT buddy_id,conversation_id,branch_id,root_run_id FROM runs WHERE id=?').get(runId))
  const marker = await page.locator('.desktop-chat-composer__prosemirror:visible').textContent()
  expect(marker).toBeTruthy()
  let draft
  await expect.poll(async () => {
    const row = read(db => db.prepare('SELECT id FROM composer_drafts WHERE scope_kind=\'conversation_branch\' AND conversation_id=? AND branch_id=? ORDER BY updated_at DESC LIMIT 1').get(run.conversation_id, run.branch_id))
    draft = row ? await page.evaluate(id => window.lexoraDesktop.localChat.composerDrafts.get(id), row.id) : null
    const permissions = read(db => db.prepare('SELECT approval_policy,execution_profile FROM conversations WHERE id=?').get(run.conversation_id))
    return Boolean(draft && JSON.stringify(draft.content).includes(marker)
      && draft.executionConfig.approvalPolicy === permissions.approval_policy
      && draft.executionConfig.executionProfile === permissions.execution_profile)
  }).toBe(true)
  await page.evaluate(({ draft, run, runId, mode }) => window.lexoraDesktop.localChat.chat.enqueue({
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    requestId: crypto.randomUUID(),
    ...(mode ? { delivery: { mode, actorId: run.buddy_id, target: { rootRunId: run.root_run_id, runId } } } : {}),
  }), { draft, run, runId, mode })
  await page.reload()
  await expect(page.locator('.desktop-chat-composer__prosemirror:visible')).toHaveText('')
}

function readModelDatabase(home, query) {
  const database = new DatabaseSync(path.join(home, 'buddy/buddy.sqlite3'), { readOnly: true })
  try {
    return query(database)
  }
  finally {
    database.close()
  }
}

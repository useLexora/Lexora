import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures/electron.mjs'

const { PhotonImage } = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))('@silvia-odwyer/photon-node')

for (const dimensions of [[2, 1], [2400, 1200]]) {
  test(`image ${dimensions.join('x')} keeps its original and stable model input across desktop restart`, async ({ buddy }) => {
    const requests = []
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end()
        return
      }
      const chunks = []
      for await (const chunk of request)
        chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const common = { id: `image-${requests.length}`, model: 'image-fixture', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'Image reference received.' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const instance = await buddy.createInstance('image-input')
    try {
      let application = await instance.launch()
      await useSyntheticCredentialStorage(application)
      await application.page.evaluate(async (baseUrl) => {
        const providers = window.lexoraDesktop.localChat.providers
        await providers.upsertCustom({
          id: 'image-fixture',
          displayName: 'Image fixture',
          api: 'openai-completions',
          baseUrl,
          enabled: true,
          models: [{ id: 'image-fixture', name: 'Image fixture', input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }],
        })
        const stop = providers.onAuthChallenge((challenge) => {
          if (challenge.providerId === 'image-fixture' && challenge.type === 'secret')
            void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
        })
        try {
          await providers.login('image-fixture', 'api_key')
        }
        finally {
          stop()
        }
        await providers.setDefaultModel({ providerId: 'image-fixture', modelId: 'image-fixture', reasoning: null })
      }, `http://127.0.0.1:${server.address().port}/v1`)
      await application.page.reload()
      const editor = application.page.locator('.desktop-chat-composer__prosemirror:visible')
      await expect(editor).toBeVisible()
      const pixels = new PhotonImage(new Uint8Array(dimensions[0] * dimensions[1] * 4).fill(255), ...dimensions)
      let image
      try {
        image = Buffer.from(pixels.get_bytes()).toString('base64')
      }
      finally {
        pixels.free()
      }
      await application.page.evaluate((data) => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([Uint8Array.from(atob(data), character => character.charCodeAt(0))], 'image-fixture.png', { type: 'image/png' }))
        document.querySelector('.desktop-chat-composer-wrap').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }, image)
      const card = application.page.locator('.composer-resource-strip__card')
      await expect(card).toHaveCount(1)
      await expect(card.locator('small')).toHaveCount(0)
      await editor.fill('Inspect the attached image.')
      await application.page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect.poll(() => completedRuns(instance.home)).toBe(1)
      expect(requests).toHaveLength(1)
      const sentImages = imageUrls(requests[0])
      expect(sentImages).toHaveLength(1)
      const sentData = sentImages[0].split(',')[1]
      const decoded = PhotonImage.new_from_byteslice(Buffer.from(sentData, 'base64'))
      try {
        expect(decoded.get_width()).toBe(Math.min(dimensions[0], 2000))
        expect(decoded.get_height()).toBe(dimensions[1] * Math.min(1, 2000 / dimensions[0]))
      }
      finally {
        decoded.free()
      }
      const originalPath = readDatabase(instance.home, database => database.prepare('SELECT stored_path FROM attachments WHERE message_id IS NOT NULL LIMIT 1').get().stored_path)
      expect((await fs.readFile(originalPath)).toString('base64')).toBe(image)
      const firstJournal = await sessionJournal(instance.home)
      expect(firstJournal).toContain('"buddyInput"')
      expect(firstJournal).not.toContain(image)
      expect(firstJournal).not.toContain(sentData)
      expect(firstJournal).not.toContain('[Image omitted:')

      await instance.stop()
      application = await instance.launch()
      await useSyntheticCredentialStorage(application)
      await application.page.reload()
      const resumed = application.page.locator('.desktop-chat-composer__prosemirror:visible')
      await expect(resumed).toBeVisible()
      await resumed.fill('Describe the same image again.')
      await application.page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect.poll(() => completedRuns(instance.home)).toBe(2)
      expect(requests).toHaveLength(2)
      expect(imageUrls(requests[1])).toEqual(sentImages)
      expect((await fs.readFile(originalPath)).toString('base64')).toBe(image)
      const journal = await sessionJournal(instance.home)
      expect(journal.startsWith(firstJournal)).toBe(true)
      expect(journal).not.toContain(image)
      expect(journal).not.toContain(sentData)
      expect(journal).not.toContain('[Image omitted:')
      const references = journal.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.message.buddyInput)
      expect(references).toHaveLength(2)
      expect(new Set(references.map(entry => entry.message.buddyInput.messageId)).size).toBe(2)
      expect(application.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
    }
    finally {
      await instance.stop()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

test('model retries retain their run budget, expose progress and allow cancelling unlimited backoff', async ({ buddy }) => {
  const requests = []
  const finishThinking = Promise.withResolvers()
  let recover = true
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (!recover || requests.length < 3) {
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Service temporarily unavailable', type: 'server_error' } }))
      return
    }
    const common = { id: 'recovered', model: 'retry-fixture', object: 'chat.completion.chunk', created: 1 }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Inspecting the recovered request.' }, finish_reason: null }] })}\n\n`)
    await finishThinking.promise
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered after retry.' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('model-retry-progress')
  try {
    const application = await instance.launch()
    await useSyntheticCredentialStorage(application)
    const { page } = application
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ runtime: { modelRetryLimit: 2 } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'retry-fixture', displayName: 'Retry fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'retry-fixture', name: 'Retry fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'retry-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('retry-fixture', 'api_key')
      }
      finally {
        stop()
      }
      await providers.setDefaultModel({ providerId: 'retry-fixture', modelId: 'retry-fixture', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    const editor = page.locator('.desktop-chat-composer__prosemirror:visible')
    const activity = page.locator('.buddy-chat-run-activity')
    await editor.fill('Recover from the transient error.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(activity).toContainText(/重试 1\s*\/\s*2/)
    await page.evaluate(() => window.lexoraDesktop.settings.update({ runtime: { modelRetryLimit: 0 } }))
    await expect(activity).toContainText(/重试 2\s*\/\s*2/)
    await expect(activity).toContainText('秒后重试')
    await expect(activity).toContainText('已用')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-progress-finite.png'), animations: 'disabled' })
    await expect(activity).toContainText('正在思考')
    await expect(activity).not.toContainText('重试')
    await page.locator('.buddy-chat-reasoning-entry__header').click()
    await expect(page.locator('.buddy-chat-reasoning-entry__body')).toContainText('Inspecting the recovered request.')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-recovered-reasoning.png'), animations: 'disabled' })
    finishThinking.resolve()
    await expect.poll(() => completedRuns(instance.home)).toBe(1)
    expect(requests).toHaveLength(3)
    for (const body of requests)
      expect(body.messages.filter(message => message.role === 'user')).toHaveLength(1)
    await expect(activity).toHaveCount(0)

    recover = false
    await editor.fill('This next run has automatic retry disabled.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => readDatabase(instance.home, db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = \'failed\'').get().count)).toBe(1)
    expect(requests).toHaveLength(4)
    await expect(activity).toHaveCount(0)

    await page.evaluate(() => window.lexoraDesktop.settings.update({ runtime: { modelRetryLimit: 'unlimited' } }))
    await editor.fill('Keep retrying until I stop this run.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => readDatabase(instance.home, (db) => {
      const row = db.prepare('SELECT payload_json FROM run_events JOIN runs ON runs.id = run_events.run_id WHERE runs.status = ? AND event_type = ? ORDER BY sequence DESC LIMIT 1').get('running', 'run.progress')
      return row ? JSON.parse(row.payload_json) : null
    })).toMatchObject({ retry: { attempt: 1, maxAttempts: 'unlimited' } })
    const retryRun = readDatabase(instance.home, db => db.prepare('SELECT id FROM runs WHERE status = ?').get('running'))
    const publicProgress = await page.evaluate(async runId => (await window.lexoraDesktop.localChat.runs.listEvents({ runId })).filter(event => event.type === 'run.progress'), retryRun.id)
    expect(publicProgress.at(-1).payload.retry).toMatchObject({ maxAttempts: 'unlimited' })
    await expect(activity).toContainText(/重试 1\s*\//)
    await expect(activity.locator('.buddy-chat-run-activity__unlimited svg')).toBeVisible()
    await page.reload()
    await expect(activity.locator('.buddy-chat-run-activity__unlimited svg')).toBeVisible()
    const typography = await activity.evaluate((element) => {
      return ['.buddy-chat-activity-status__label', '.buddy-chat-run-activity__retry-attempt', '.buddy-chat-run-activity__duration'].map((selector) => {
        const node = element.querySelector(selector)
        const style = getComputedStyle(node)
        const bounds = node.getBoundingClientRect()
        return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, centerY: bounds.y + bounds.height / 2 }
      })
    })
    expect(new Set(typography.map(item => `${item.fontFamily}:${item.fontSize}:${item.lineHeight}`)).size).toBe(1)
    expect(Math.max(...typography.map(item => item.centerY)) - Math.min(...typography.map(item => item.centerY))).toBeLessThan(1)
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-progress-unlimited-light.png'), animations: 'disabled' })
    await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: 'dark' } }))
    await expect(page.locator('.buddy-app')).toHaveClass(/is-dark/)
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-progress-unlimited-dark.png'), animations: 'disabled' })
    await activity.evaluate(element => element.style.maxWidth = '320px')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'retry-progress-unlimited-narrow.png'), animations: 'disabled' })
    const narrow = await activity.evaluate((element) => {
      const label = element.querySelector('.buddy-chat-activity-status__label').getBoundingClientRect()
      const metadata = element.querySelector('.buddy-chat-run-activity__retry-meta').getBoundingClientRect()
      return { labelLeft: label.x, metadataLeft: metadata.x, labelBottom: label.bottom, metadataTop: metadata.y, width: element.clientWidth, scrollWidth: element.scrollWidth }
    })
    expect(narrow.metadataLeft).toBe(narrow.labelLeft)
    expect(narrow.metadataTop).toBeGreaterThanOrEqual(narrow.labelBottom)
    expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.width)
    await page.getByRole('button', { name: '停止运行', exact: true }).click()
    await expect.poll(() => readDatabase(instance.home, db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = \'cancelled\'').get().count)).toBe(1)
    await expect(activity).toHaveCount(0)
    expect(application.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    finishThinking.resolve()
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('activity groups retain open reasoning across tools, reply phases and canvas replay', async ({ buddy }) => {
  const gates = Object.fromEntries(['tools', 'arguments', 'thinking', 'reply', 'finish'].map(name => [name, Promise.withResolvers()]))
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const common = { id: `activity-${requests.length}`, model: 'activity-fixture', object: 'chat.completion.chunk', created: 1 }
    const send = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    send({ role: 'assistant' })
    if (requests.length === 1) {
      send({ reasoning_content: '先检查工作目录，再确认文件是否可读。' })
      await gates.tools.promise
      send({ tool_calls: [{ index: 0, id: 'list-workspace', type: 'function', function: { name: 'ls', arguments: '{' } }] })
      await gates.arguments.promise
      send({ tool_calls: [
        { index: 0, function: { arguments: '"path":"."}' } },
        { index: 1, id: 'read-missing', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'activity-fixture-missing.txt' }) } },
      ] })
      send({}, 'tool_calls')
    }
    else {
      await gates.thinking.promise
      send({ reasoning_content: '目录检查已完成，文件不存在。保留异常信息，继续整理结果。' })
      await gates.reply.promise
      send({ content: '检查完成：工作目录可访问，指定文件不存在。' })
      await gates.finish.promise
      send({}, 'stop')
    }
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('activity-groups')
  try {
    const application = await instance.launch()
    await useSyntheticCredentialStorage(application)
    const { page } = application
    await page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'activity-fixture', displayName: 'Activity fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'activity-fixture', name: 'Activity fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'activity-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('activity-fixture', 'api_key')
      }
      finally {
        stop()
      }
      await providers.setDefaultModel({ providerId: 'activity-fixture', modelId: 'activity-fixture', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('检查工作目录和指定文件，并说明结果。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const activity = page.locator('.buddy-chat-run-activity')
    const group = page.locator('.buddy-chat-activity-group')
    await expect(activity).toContainText('正在思考')
    await expect(group.locator('.buddy-chat-reasoning-entry__header')).toContainText('正在思考')
    await group.locator('.buddy-chat-reasoning-entry__header').click()
    const originalBody = await group.locator('.buddy-chat-reasoning-entry__body').elementHandle()
    await expect(group.locator('.buddy-chat-reasoning-entry__body')).toContainText('先检查工作目录')
    gates.tools.resolve()
    await expect(activity).toContainText('准备中')
    await expect(group).toHaveAttribute('data-status', 'completed')
    expect(await originalBody.evaluate(element => element.isConnected)).toBe(true)
    gates.arguments.resolve()
    await expect.poll(() => requests.length).toBe(2)
    await expect(group).toHaveAttribute('data-status', 'completed')
    await expect(group.locator('.buddy-chat-activity-group__header')).toContainText('思考 · 读取 1 个文件 · 搜索 1 次')
    await expect(group.locator('.buddy-chat-activity-group__header')).toHaveAttribute('aria-expanded', 'true')
    expect(await originalBody.evaluate(element => element.isConnected)).toBe(true)
    await expect(activity).toContainText('正在处理')
    await expect(group.locator('.buddy-chat-activity-group__issues')).toContainText('1 项异常')
    const failedTool = group.locator('[data-tool-call-id="read-missing"]')
    await expectInlineToolStatus(failedTool)
    const groupIcon = await group.locator('.buddy-chat-activity-group__header > .buddy-chat-activity-row__icon').elementHandle()
    await page.mouse.move(0, 0)
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'activity-settled-light.png'), animations: 'disabled' })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    gates.thinking.resolve()
    await expect(group).toHaveAttribute('data-status', 'running')
    expect(await groupIcon.evaluate(element => element.isConnected)).toBe(true)
    expect(await groupIcon.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await expect(group.locator('.buddy-chat-activity-group__status')).toHaveText('运行中')
    await expect(group.locator('.buddy-shimmer-text--continuous')).toHaveCount(1)
    expect(await group.locator('.buddy-shimmer-text--continuous').evaluate(element => getComputedStyle(element).animationDuration)).toBe('3s')
    expect(await activity.locator('.buddy-shimmer-text--continuous').evaluate(element => getComputedStyle(element).animationDuration)).toBe('1.8s')
    await expect(group.locator('.buddy-chat-reasoning-entry__header').last()).toHaveAttribute('aria-expanded', 'false')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await group.locator('.buddy-shimmer-text--continuous').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: 'dark' } }))
    await expect(page.locator('.buddy-app')).toHaveClass(/is-dark/)
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'activity-running-dark.png'), animations: 'disabled' })
    await group.evaluate(element => element.style.maxWidth = '320px')
    expect(await group.evaluate(element => element.scrollWidth <= element.clientWidth + 4)).toBe(true)
    await expectInlineToolStatus(failedTool)
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'activity-running-narrow.png'), animations: 'disabled' })
    await group.evaluate(element => element.style.removeProperty('max-width'))
    gates.reply.resolve()
    await expect(activity).toContainText('正在回复')
    await expect(group).toHaveAttribute('data-status', 'completed')
    expect(await originalBody.evaluate(element => element.isConnected)).toBe(true)
    gates.finish.resolve()
    await expect.poll(() => completedRuns(instance.home)).toBe(1)
    await expect(activity).toHaveCount(0)
    expect(await originalBody.evaluate(element => element.isConnected)).toBe(true)
    await page.getByTestId('conversation-canvas-toggle').click()
    await page.locator('.conversation-node[data-kind="answer"]').click()
    const detail = page.getByTestId('canvas-node-detail')
    await expect(detail.locator('.buddy-chat-activity-group__header')).toContainText('思考 · 读取 1 个文件 · 搜索 1 次')
    await detail.locator('.buddy-chat-activity-group__header').click()
    await expectInlineToolStatus(detail.locator('[data-tool-call-id="read-missing"]'))
    await detail.locator('.buddy-chat-reasoning-entry__header').first().click()
    await expect(detail.locator('.buddy-chat-reasoning-entry__body')).toContainText('先检查工作目录')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'activity-canvas-dark.png'), animations: 'disabled' })
    expect(application.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    for (const gate of Object.values(gates))
      gate.resolve()
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

async function expectInlineToolStatus(row) {
  const spacing = await row.evaluate((element) => {
    const status = element.querySelector('.buddy-chat-tool__status')
    const headerBounds = element.querySelector('.buddy-chat-tool__header').getBoundingClientRect()
    const iconBounds = element.querySelector('.buddy-chat-activity-row__icon').getBoundingClientRect()
    const targetBounds = status.previousElementSibling.getBoundingClientRect()
    const statusBounds = status.getBoundingClientRect()
    const chevronBounds = element.querySelector('.buddy-chat-activity-row__chevron').getBoundingClientRect()
    const textBaselines = [...element.querySelectorAll('.buddy-chat-tool__title, .buddy-chat-tool__summary, .buddy-chat-tool__context, .buddy-chat-tool__status > span')].map((text) => {
      const marker = document.createElement('span')
      marker.style.cssText = 'display: inline-block; width: 0; height: 0; vertical-align: baseline;'
      text.append(marker)
      const baseline = marker.getBoundingClientRect().top
      marker.remove()
      return baseline
    })
    return {
      targetGap: statusBounds.left - targetBounds.right,
      chevronGap: chevronBounds.left - statusBounds.right,
      textBaselineOffset: Math.max(...textBaselines) - Math.min(...textBaselines),
      iconCenterOffset: Math.abs(iconBounds.y + iconBounds.height / 2 - headerBounds.y - headerBounds.height / 2),
      chevronCenterOffset: Math.abs(chevronBounds.y + chevronBounds.height / 2 - headerBounds.y - headerBounds.height / 2),
    }
  })
  expect(spacing.targetGap).toBeGreaterThanOrEqual(0)
  expect(spacing.targetGap).toBeLessThanOrEqual(12)
  expect(spacing.chevronGap).toBeGreaterThanOrEqual(0)
  expect(spacing.chevronGap).toBeLessThanOrEqual(12)
  expect(spacing.textBaselineOffset).toBeLessThan(1)
  expect(spacing.iconCenterOffset).toBeLessThan(1)
  expect(spacing.chevronCenterOffset).toBeLessThan(1)
}

async function useSyntheticCredentialStorage({ app, page }) {
  await app.evaluate(({ app, safeStorage }) => {
    if (app.getName() !== 'Lexora Buddy Test')
      throw new Error('Synthetic credentials require an isolated test instance')
    Object.defineProperties(safeStorage, {
      isEncryptionAvailable: { configurable: true, value: () => true },
      getSelectedStorageBackend: { configurable: true, value: () => 'offline-fixture' },
      encryptString: { configurable: true, value: value => Buffer.from(`offline-fixture:${value}`) },
      decryptString: {
        configurable: true,
        value: (value) => {
          const serialized = value.toString('utf8')
          if (!serialized.startsWith('offline-fixture:'))
            throw new Error('Unexpected credential in isolated fixture')
          return serialized.slice('offline-fixture:'.length)
        },
      },
    })
  })
  await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
  await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
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

function completedRuns(home) {
  return readDatabase(home, database => database.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)
}

async function sessionJournal(home) {
  const file = readDatabase(home, database => database.prepare('SELECT pi_session_file FROM runs ORDER BY started_at DESC LIMIT 1').get().pi_session_file)
  return fs.readFile(file, 'utf8')
}

function imageUrls(request) {
  return request.messages.filter(message => message.role === 'user')
    .flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image_url').map(block => block.image_url.url) : [])
}

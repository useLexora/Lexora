import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

const runCount = 3
const conversationId = 'recovery-conversation'
const branchId = 'recovery-branch'
const modelId = 'restart-model-0'

test('history survives restart, pending repairs and corruption without blocking sending', async ({ buddy }, testInfo) => {
  test.setTimeout(120_000)
  const instance = await buddy.createInstance('event-recovery')
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const common = { id: `restart-${requests.length}`, model: modelId, object: 'chat.completion.chunk', created: 1 }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'RESTART_SEND_OK' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const databasePath = path.join(instance.home, 'buddy/buddy.sqlite3')
  const query = (sql, ...args) => withDatabase(databasePath, db => db.prepare(sql).all(...args))
  const projection = () => ({
    messages: query('SELECT id, role, content_json FROM messages WHERE conversation_id = ? ORDER BY id', conversationId),
    events: query('SELECT run_id, sequence, event_type, payload_json FROM run_events WHERE run_id LIKE ? ORDER BY run_id, sequence', 'recovery-%'),
  })
  try {
    const initial = await instance.launch()
    await useSyntheticCredentialStorage(initial)
    await initial.page.evaluate(async (baseUrl) => {
      const api = window.lexoraDesktop.localChat
      await api.providers.upsertCustom({
        id: 'restart-fixture',
        displayName: 'Restart fixture',
        api: 'openai-completions',
        baseUrl,
        enabled: true,
        models: [{ id: 'restart-model-0', name: 'Restart model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }],
      })
      const stop = api.providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'restart-fixture' && challenge.type === 'secret')
          void api.providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await api.providers.login('restart-fixture', 'api_key')
      }
      finally { stop() }
      await api.providers.setDefaultModel({ providerId: 'restart-fixture', modelId: 'restart-model-0', reasoning: null })
      const actor = await api.buddies.get('default')
      await api.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: { ...actor.settings, tools: { mode: 'none' }, skills: { mode: 'none' }, requiredSkills: [], npcIds: [] } })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await instance.stop()
    const files = await seedHistory(instance.home)
    const originalFiles = await fileSnapshot(files)

    await instance.launch()
    await expect.poll(() => query('SELECT run_id FROM run_event_maintenance WHERE recovery_pending = 1 OR compaction_pending = 1').length, { timeout: 60000 }).toBe(0)
    const recovered = projection()
    expect(recovered.messages.filter(row => row.role === 'user')).toHaveLength(runCount)
    expect(recovered.messages.filter(row => row.role === 'assistant')).toHaveLength(runCount)
    expect(recovered.messages.filter(row => row.role === 'tool')).toHaveLength(runCount)
    expect(recovered.events).toHaveLength(runCount * 5)
    for (let index = 0; index < runCount; index++) {
      const id = `recovery-${String(index).padStart(4, '0')}`
      expect(JSON.parse(recovered.messages.find(row => row.id === `${id}-input`).content_json)).toEqual({ text: `Synthetic request ${index}` })
      expect(JSON.parse(recovered.messages.find(row => row.id === `${id}-answer`).content_json)).toEqual({ text: `Recovered answer ${index}` })
      expect(JSON.parse(recovered.messages.find(row => row.id === `${id}-tool`).content_json)).toEqual({ isError: false, toolCallId: `${id}-call`, toolName: 'fixture_tool' })
      expect(JSON.parse(recovered.events.find(row => row.run_id === id && row.event_type === 'tool.completed').payload_json).presentation.output).toBe(`Recovered tool result ${index}`)
    }
    await instance.stop()
    expect(await fileSnapshot(files)).toEqual(originalFiles)

    const restarted = await instance.launch()
    expect(projection()).toEqual(recovered)
    expect(await fileSnapshot(files)).toEqual(originalFiles)
    await restarted.page.locator(`[data-task-id="${conversationId}"] .desktop-task-sidebar__task`).click()
    await expect(restarted.page.locator('.buddy-chat-message.is-assistant').filter({ hasText: `Recovered answer ${runCount - 1}` })).toBeVisible()
    await testInfo.attach('recovered-history', { body: await restarted.page.screenshot(), contentType: 'image/png' })
    await instance.stop()

    const lateMessage = { runId: 'recovery-0000', sequence: 6, createdAt: '2026-10-08T00:00:01.000Z', type: 'message.completed', payload: { messageId: 'recovery-late-answer', role: 'assistant', content: { text: 'Durable after checkpoint' }, stopReason: 'completed' } }
    withDatabase(databasePath, db => db.prepare('UPDATE run_event_maintenance SET recovery_pending = 1, compaction_pending = 1 WHERE run_id = ?').run(lateMessage.runId), false)
    await fs.appendFile(files[0], `${JSON.stringify(lateMessage)}\n`)
    const changedFiles = await fileSnapshot(files)
    await instance.launch()
    const afterRepair = projection()
    expect(afterRepair.messages.filter(row => row.id !== lateMessage.payload.messageId)).toEqual(recovered.messages)
    expect(afterRepair.messages.find(row => row.id === lateMessage.payload.messageId)).toMatchObject({ content_json: JSON.stringify(lateMessage.payload.content) })
    expect(afterRepair.events.filter(row => row.run_id !== lateMessage.runId)).toEqual(recovered.events.filter(row => row.run_id !== lateMessage.runId))
    await instance.stop()
    expect(await fileSnapshot(files)).toEqual(changedFiles)

    const corruptRunId = `recovery-${String(runCount - 1).padStart(4, '0')}`
    const healthyRunId = `recovery-${String(runCount - 2).padStart(4, '0')}`
    const corruptFile = files.at(-1)
    expect(query('SELECT recovery_pending, compaction_pending FROM run_event_maintenance WHERE run_id = ?', corruptRunId)[0]).toEqual({ recovery_pending: 0, compaction_pending: 0 })
    const originalLines = (await fs.readFile(corruptFile, 'utf8')).split('\n')
    originalLines[1] = '{"broken":'
    const corruptBytes = Buffer.from(originalLines.join('\n'))
    await fs.writeFile(corruptFile, corruptBytes)
    const damagedFiles = await fileSnapshot(files)
    const damaged = await instance.launch()
    expect(projection()).toEqual(afterRepair)
    const nodeError = await damaged.page.evaluate(async ({ conversationId, runId }) => {
      try {
        await window.lexoraDesktop.localChat.conversations.getNodeDetail({ conversationId, kind: 'answer', runId })
        return null
      }
      catch (error) {
        return error.message
      }
    }, { conversationId, runId: corruptRunId })
    expect(nodeError).toContain('EVENT_LOG_CORRUPTED')
    const timeline = await damaged.page.evaluate(input => window.lexoraDesktop.localChat.conversations.listTimeline(input), { conversationId, branchId, limit: 100 })
    expect(timeline.runs.find(run => run.id === corruptRunId)).toMatchObject({ status: 'completed', errorCode: 'EVENT_LOG_CORRUPTED' })
    expect(timeline.items.find(item => item.id === `${corruptRunId}-answer`)).toMatchObject({ kind: 'message', role: 'assistant', content: { text: `Recovered answer ${runCount - 1}` } })
    expect(timeline.items.find(item => item.id === `${healthyRunId}-answer`)).toMatchObject({ kind: 'message', role: 'assistant', content: { text: `Recovered answer ${runCount - 2}` } })
    expect(timeline.runEvents.some(event => event.runId === corruptRunId)).toBe(false)
    expect(timeline.runEvents.some(event => event.runId === healthyRunId && event.type === 'tool.completed')).toBe(true)
    const healthyDetail = await damaged.page.evaluate(input => window.lexoraDesktop.localChat.conversations.getNodeDetail(input), { conversationId, kind: 'answer', runId: healthyRunId })
    expect(healthyDetail.runs).toEqual([expect.objectContaining({ id: healthyRunId, status: 'completed', errorCode: null })])
    expect(healthyDetail.runEvents.find(event => event.type === 'tool.completed').payload.presentation.output).toBe(`Recovered tool result ${runCount - 2}`)
    expect(projection()).toEqual(afterRepair)

    await useSyntheticCredentialStorage(damaged)
    await damaged.page.reload()
    await damaged.page.locator('#desktop-task-history').getByRole('button', { name: '新任务', exact: true }).click()
    const editor = damaged.page.locator('.desktop-chat-composer__prosemirror:visible')
    await editor.fill('Reply with RESTART_SEND_OK.')
    const send = damaged.page.getByRole('button', { name: '发送消息', exact: true })
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => query('SELECT status FROM runs WHERE provider = \'restart-fixture\'').map(row => row.status)).toEqual(['completed'])
    expect(requests).toHaveLength(1)
    expect(requests[0].model).toBe(modelId)
    await expect(damaged.page.locator('.buddy-chat-message.is-assistant').filter({ hasText: 'RESTART_SEND_OK' })).toBeVisible()
    expect(damaged.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
    await testInfo.attach('restart-send', { body: await damaged.page.screenshot(), contentType: 'image/png' })
    await instance.stop()
    expect(await fileSnapshot(files)).toEqual(damagedFiles)
  }
  finally {
    try {
      await instance.stop()
    }
    finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }
})

function withDatabase(filename, action, readOnly = true) {
  const db = new DatabaseSync(filename, { readOnly })
  try {
    return action(db)
  }
  finally { db.close() }
}

async function seedHistory(home) {
  const directory = path.join(home, 'buddy/conversations', conversationId, 'events')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const files = []
  const db = new DatabaseSync(path.join(home, 'buddy/buddy.sqlite3'))
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
    const now = '2026-10-08T00:00:00.000Z'
    db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(conversationId, 'Synthetic recovery history', branchId, now, now)
    db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(branchId, conversationId, now)
    db.prepare('INSERT INTO conversation_members (conversation_id, actor_id, joined_at) VALUES (?, ?, ?)').run(conversationId, 'default', now)
    const insert = db.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, 'fixture', 'fixture', 'chat', 'completed', ?, ?)`)
    const insertInput = db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < runCount; index++) {
      const id = `recovery-${String(index).padStart(4, '0')}`
      const createdAt = new Date(Date.parse(now) + index * 1000).toISOString()
      insertInput.run(`${id}-input`, conversationId, branchId, 'user', JSON.stringify({ text: `Synthetic request ${index}` }), createdAt)
      insert.run(id, conversationId, branchId, `${id}-input`, createdAt, createdAt)
      const tool = { toolCallId: `${id}-call`, toolName: 'fixture_tool', isError: false }
      const events = [
        { type: 'run.started', payload: {} },
        { type: 'tool.completed', payload: { ...tool, presentation: { card: 'generic', argumentNames: [], description: 'Synthetic result', output: `Recovered tool result ${index}`, truncated: false } } },
        { type: 'message.tool_result', payload: { messageId: `${id}-tool`, role: 'tool', content: tool } },
        { type: 'message.completed', payload: { messageId: `${id}-answer`, role: 'assistant', content: { text: `Recovered answer ${index}` }, stopReason: 'completed' } },
        { type: 'run.completed', payload: {} },
      ].map((event, index) => ({ ...event, runId: id, sequence: index + 1, createdAt }))
      const filename = path.join(directory, `${id}.jsonl`)
      await fs.writeFile(filename, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 })
      files.push(filename)
    }
    db.exec('COMMIT')
  }
  finally { db.close() }
  return files
}

function fileSnapshot(files) {
  return Promise.all(files.map(filename => fs.readFile(filename)))
}

import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

const oldOperation = '11111111-1111-4111-8111-111111111111'
const deletedOperation = '22222222-2222-4222-8222-222222222222'
const unrelatedOperation = '33333333-3333-4333-8333-333333333333'

function seedRecovery(databasePath, { linkHistory = true, claim } = {}) {
  const database = new DatabaseSync(databasePath)
  const now = '2026-10-15T00:00:00.000Z'
  try {
    database.exec('PRAGMA foreign_keys = ON')
    for (const [id, title] of [['source', '此前的整理任务'], ['blocked', '新的写入任务'], ['unrelated', '其他任务']]) {
      database.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, title, `branch-${id}`, now, now)
      database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
      database.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, completed_at)
        VALUES (?, ?, ?, ?, 'fixture', 'fixture', 'chat', 'failed', ?, ?)`).run(`run-${id}`, id, `branch-${id}`, `input-${id}`, now, now)
    }
    for (const [id, runId, resource] of [
      [oldOperation, 'run-source', '/example/shared/report.md'],
      [deletedOperation, 'deleted-run', '/example/shared/notes.md'],
      [unrelatedOperation, 'run-unrelated', '/example/shared/report.md'],
    ]) {
      database.prepare(`INSERT INTO run_mutation_leases (invocation_id, run_id, segment_id, claims_json, status, reason, created_at, updated_at, lifetime)
        VALUES (?, ?, ?, ?, 'hazard', 'MUTATION_INTERRUPTED', ?, ?, 'external')`).run(id, runId, `segment-${id}`, JSON.stringify([id === oldOperation && claim ? claim : { kind: 'file', canonicalPath: resource }]), now, now)
      database.prepare('INSERT INTO run_mutation_processes (invocation_id, process_id, settlement, updated_at) VALUES (?, ?, \'unknown\', ?)')
        .run(id, JSON.stringify({ kind: 'legacy-process', pid: 123456, job: 'not-user-facing', checkpoint: 'not-user-facing' }), now)
      if (linkHistory && id !== unrelatedOperation) {
        database.prepare(`INSERT INTO run_mutation_evidence (invocation_id, kind, outcome, reason, actor, related_run_id, created_at)
          VALUES (?, 'observed', 'unknown', 'WRITE_BLOCKED', 'system', 'run-blocked', ?)`).run(id, now)
      }
    }
  }
  finally { database.close() }
}

function readRecovery(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      leases: database.prepare('SELECT invocation_id, status, reason FROM run_mutation_leases ORDER BY invocation_id').all(),
      decisions: database.prepare('SELECT invocation_id, kind, outcome, actor FROM run_mutation_evidence WHERE kind = \'waived\' ORDER BY sequence').all(),
      runs: database.prepare('SELECT id, conversation_id, status FROM runs ORDER BY id').all(),
      associations: database.prepare('SELECT invocation_id, related_run_id, reason FROM run_mutation_evidence WHERE related_run_id IS NOT NULL ORDER BY sequence').all(),
      processes: database.prepare('SELECT invocation_id, settlement FROM run_mutation_processes ORDER BY invocation_id').all(),
    }
  }
  finally { database.close() }
}

test('task review preserves historical warnings and only acknowledges the explicitly confirmed set', async ({ buddy }, testInfo) => {
  test.setTimeout(120_000)
  const instance = await buddy.createInstance('mutation-recovery')
  const databasePath = path.join(instance.home, 'buddy/buddy.sqlite3')
  await instance.launch()
  await instance.stop()
  seedRecovery(databasePath)
  let { app, page, diagnostics } = await instance.launch()
  await page.evaluate(async () => {
    const api = window.lexoraDesktop.localChat
    const { defaultBuddyId } = await api.buddies.list()
    for (const id of ['source', 'blocked', 'unrelated']) {
      await api.conversations.addMember(id, defaultBuddyId)
      await api.conversations.setBuddy(id, defaultBuddyId)
    }
  })
  await page.locator('[data-task-id="blocked"] .desktop-task-sidebar__task').click()
  const card = () => page.locator('.desktop-change-recovery:visible')
  await expect(card()).toContainText('这些历史记录不会阻止新操作')
  await expect(card()).toContainText('此前的整理任务')
  await expect(card()).toContainText('已删除的任务')
  await expect(card()).toContainText('/example/shared/report.md')
  await expect(card()).not.toContainText('其他任务')
  await expect(card()).not.toContainText(/123456|not-user-facing|PID|checkpoint/i)
  await expect(card().getByRole('button', { name: /停止|结束/ })).toHaveCount(0)
  await expect(card().getByRole('button', { name: '标记已核对并接受风险', exact: true })).toHaveCount(0)

  const initial = await page.evaluate(() => window.lexoraDesktop.localChat.changes.recovery.list({ conversationId: 'blocked' }))
  expect(initial.map(item => item.invocationId).sort()).toEqual([oldOperation, deletedOperation])
  expect(initial.every(item => item.status === 'unknown' && item.revision)).toBe(true)
  expect(readRecovery(databasePath).decisions).toEqual([])
  await card().getByRole('button', { name: '重新检查', exact: true }).click()
  await expect(card().getByRole('button', { name: '重新检查', exact: true })).toBeEnabled()
  await expect(card()).toContainText('暂时无法确认此前的操作是否已停止')
  expect(readRecovery(databasePath).decisions).toEqual([])

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id: `lexora.themes.classic-${theme}` } }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', theme)
    await page.screenshot({ path: path.join(instance.artifactDirectory, `recovery-${theme}.png`), animations: 'disabled' })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 640))
  await expect(card().getByRole('button', { name: '重新检查', exact: true })).toBeInViewport()
  expect(await card().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'recovery-narrow.png'), animations: 'disabled' })

  async function review() {
    await card().getByRole('button', { name: '更多选项', exact: true }).click()
    await page.locator('.n-dropdown-menu:visible').getByText('标记已核对并接受风险', { exact: true }).click()
  }
  await review()
  const confirmation = page.locator('.n-dialog').filter({ hasText: '标记已核对并接受风险？' })
  await expect(confirmation).toContainText('仅标记以下 2 项为已核对')
  await expect(confirmation).toContainText('不会重新运行旧操作')
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'recovery-confirmation.png'), animations: 'disabled' })
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  expect(readRecovery(databasePath).decisions).toEqual([])
  await review()
  await confirmation.getByRole('button', { name: '标记已核对并接受风险', exact: true }).click()
  await expect(confirmation).toBeHidden()
  await expect(card()).toHaveCount(0)
  await expect(page.getByText('已记录你对所选事项的核对和风险确认；此前操作仍未确认结束，历史记录会保留，旧操作不会自动重跑。', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'recovery-waived.png'), animations: 'disabled' })
  const resolved = readRecovery(databasePath)
  expect(resolved.leases).toEqual([
    { invocation_id: oldOperation, status: 'released', reason: 'USER_ACCEPTED_RISK' },
    { invocation_id: deletedOperation, status: 'released', reason: 'USER_ACCEPTED_RISK' },
    { invocation_id: unrelatedOperation, status: 'hazard', reason: 'MUTATION_INTERRUPTED' },
  ])
  expect(resolved.decisions.filter(item => item.outcome === 'applied').map(item => [item.invocation_id, item.kind, item.actor]).sort())
    .toEqual([[oldOperation, 'waived', 'user'], [deletedOperation, 'waived', 'user']])
  expect(resolved.runs.map(run => run.id)).toEqual(['run-blocked', 'run-source', 'run-unrelated'])
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await instance.stop()
  ;({ app, page, diagnostics } = await instance.launch())
  expect(await page.evaluate(() => window.lexoraDesktop.localChat.changes.recovery.list({ conversationId: 'blocked' }))).toEqual([])
  expect((await page.evaluate(() => window.lexoraDesktop.localChat.changes.recovery.list({ conversationId: 'unrelated' }))).map(item => item.invocationId)).toEqual([unrelatedOperation])
  expect(readRecovery(databasePath).decisions).toEqual(resolved.decisions)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await testInfo.attach('recovery-audit', { body: JSON.stringify(resolved, null, 2), contentType: 'application/json' })
})

for (const claimKind of ['file', 'host']) {
  test(`a successful ${claimKind} overlap shows historical review without blocking another write or replaying after restart`, async ({ buddy }, testInfo) => {
    test.setTimeout(180_000)
    const requests = []
    const serverErrors = []
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          response.writeHead(404).end()
          return
        }
        const chunks = []
        for await (const chunk of request)
          chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests.push(body)
        const current = body.messages.slice(body.messages.findLastIndex(message => message.role === 'user') + 1)
        const completedWrite = current.some(message => message.tool_calls?.some(call => call.function.name === 'write'))
        const shouldWrite = body.tools?.some(tool => tool.function.name === 'write') && !completedWrite
        const content = JSON.stringify(body.messages.findLast(message => message.role === 'user')).includes('second-write')
          ? 'second-write\n'
          : 'first-write\n'
        const delta = shouldWrite
          ? { tool_calls: [{ index: 0, id: `write-${requests.length}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'report.md', content }) } }] }
          : { content: '本次写入已完成。' }
        const common = { id: `recovery-${requests.length}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: shouldWrite ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 } })}\n\n`)
        response.end('data: [DONE]\n\n')
      })().catch((error) => {
        serverErrors.push(String(error))
        response.writeHead(500).end('Local Provider scenario failed')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const instance = await buddy.createInstance(`mutation-overlap-${claimKind}`)
    const databasePath = path.join(instance.home, 'buddy/buddy.sqlite3')
    const workspace = path.join(instance.home, 'buddy/conversations/blocked/workspace')
    const target = path.join(workspace, 'report.md')
    try {
      await instance.launch()
      await instance.stop()
      await fs.mkdir(workspace, { recursive: true })
      seedRecovery(databasePath, {
        linkHistory: false,
        claim: claimKind === 'host' ? { kind: 'host' } : { kind: 'file', canonicalPath: target },
      })
      let desktop = await instance.launch()
      await useSyntheticCredentialStorage(desktop)
      let page = desktop.page
      await page.evaluate(async (baseUrl) => {
        const api = window.lexoraDesktop.localChat
        const providers = api.providers
        await providers.upsertCustom({ id: 'recovery-fixture', displayName: 'Recovery fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'recovery-fixture', name: 'Recovery fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
        const stop = providers.onAuthChallenge((challenge) => {
          if (challenge.providerId === 'recovery-fixture' && challenge.type === 'secret')
            void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
        })
        try {
          await providers.login('recovery-fixture', 'api_key')
        }
        finally { stop() }
        await providers.setDefaultModel({ providerId: 'recovery-fixture', modelId: 'recovery-fixture', reasoning: null })
        const { defaultBuddyId } = await api.buddies.list()
        await api.conversations.addMember('blocked', defaultBuddyId)
        await api.conversations.setBuddy('blocked', defaultBuddyId)
      }, `http://127.0.0.1:${server.address().port}/v1`)
      await page.locator('[data-task-id="blocked"] .desktop-task-sidebar__task').click()
      const card = () => page.locator('.desktop-change-recovery:visible')
      const list = () => page.evaluate(() => window.lexoraDesktop.localChat.changes.recovery.list({ conversationId: 'blocked' }))
      expect(await list()).toEqual([])
      expect(readRecovery(databasePath).associations).toEqual([])
      await expect(card()).toHaveCount(0)
      await page.screenshot({ path: path.join(instance.artifactDirectory, 'overlap-before.png'), animations: 'disabled' })

      async function send(content) {
        await page.locator('.desktop-chat-composer__prosemirror:visible').fill(`请将 report.md 写为 ${content}。`)
        const button = page.getByRole('button', { name: '发送消息', exact: true })
        await expect(button).toBeEnabled()
        await button.click()
      }
      async function settled(count, content) {
        await expect.poll(() => readRecovery(databasePath).runs.filter(run => run.conversation_id === 'blocked' && run.id !== 'run-blocked').map(run => run.status)).toEqual(Array.from({ length: count }).fill('completed'))
        expect(await fs.readFile(target, 'utf8')).toBe(content)
      }
      await send('first-write')
      await settled(1, 'first-write\n')
      await expect(card()).toContainText('此前操作有待核对')
      await expect(card()).toContainText('这些历史记录不会阻止新操作')
      await expect(card()).toContainText('此前的整理任务')
      await expect(card()).toContainText('暂时无法确认此前的操作是否已停止')
      await expect(card()).not.toContainText('已删除的任务')
      await expect(page.locator('.n-dialog:visible')).toHaveCount(0)
      expect((await list()).map(item => [item.invocationId, item.status])).toEqual([[oldOperation, 'unknown']])
      await page.locator('.desktop-chat-composer__prosemirror:visible').fill('请将 report.md 写为 second-write。')
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id: `lexora.themes.classic-${theme}` } }), theme)
        await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', theme)
        await page.screenshot({ path: path.join(instance.artifactDirectory, `overlap-${theme}.png`), animations: 'disabled' })
      }
      await send('second-write')
      await settled(2, 'second-write\n')
      await expect(card()).toBeVisible()
      const completed = readRecovery(databasePath)
      expect(completed.decisions).toEqual([])
      expect(completed.leases.find(lease => lease.invocation_id === oldOperation)).toMatchObject({ status: 'hazard', reason: 'MUTATION_INTERRUPTED' })
      expect(completed.processes.find(process => process.invocation_id === oldOperation).settlement).toBe('unknown')
      expect(completed.associations).toHaveLength(2)
      expect(completed.associations.every(item => item.invocation_id === oldOperation && item.reason === 'RESOURCE_OVERLAP')).toBe(true)
      expect(new Set(completed.associations.map(item => item.related_run_id)).size).toBe(2)
      expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
      const requestCount = requests.length
      await instance.stop()
      desktop = await instance.launch()
      await useSyntheticCredentialStorage(desktop)
      page = desktop.page
      await page.locator('[data-task-id="blocked"] .desktop-task-sidebar__task').click()
      await expect(card()).toContainText('此前的整理任务')
      expect(readRecovery(databasePath).associations).toEqual(completed.associations)
      expect(requests).toHaveLength(requestCount)
      expect(await fs.readFile(target, 'utf8')).toBe('second-write\n')
      expect(serverErrors).toEqual([])
      expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
      await page.screenshot({ path: path.join(instance.artifactDirectory, 'overlap-restarted.png'), animations: 'disabled' })
      const toolMessages = [...new Map(requests.flatMap(body => body.messages.filter(message => message.role === 'tool')).map(message => [message.tool_call_id, message])).values()]
      const auditPath = testInfo.outputPath('overlap-audit.json')
      await fs.writeFile(auditPath, JSON.stringify({ claimKind, completed, recovery: await list(), notice: await card().textContent(), modelToolResults: toolMessages }, null, 2))
      await testInfo.attach('overlap-audit', { path: auditPath, contentType: 'application/json' })
    }
    finally {
      await instance.stop()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

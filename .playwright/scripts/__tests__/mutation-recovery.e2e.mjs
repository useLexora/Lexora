import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures/electron.mjs'

const oldOperation = '11111111-1111-4111-8111-111111111111'
const deletedOperation = '22222222-2222-4222-8222-222222222222'
const unrelatedOperation = '33333333-3333-4333-8333-333333333333'

function seedRecovery(databasePath) {
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
        VALUES (?, ?, ?, ?, 'hazard', 'MUTATION_INTERRUPTED', ?, ?, 'external')`).run(id, runId, `segment-${id}`, JSON.stringify([{ kind: 'file', canonicalPath: resource }]), now, now)
      database.prepare('INSERT INTO run_mutation_processes (invocation_id, process_id, settlement, updated_at) VALUES (?, ?, \'unknown\', ?)')
        .run(id, JSON.stringify({ kind: 'legacy-process', pid: 123456, job: 'not-user-facing', checkpoint: 'not-user-facing' }), now)
      if (id !== unrelatedOperation) {
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
      runs: database.prepare('SELECT id FROM runs ORDER BY id').all(),
    }
  }
  finally { database.close() }
}

test('task recovery discovers older blockers and only waives the explicitly confirmed set', async ({ buddy }, testInfo) => {
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
  await expect(card()).toContainText('此前的整理任务')
  await expect(card()).toContainText('已删除的任务')
  await expect(card()).toContainText('/example/shared/report.md')
  await expect(card()).not.toContainText('其他任务')
  await expect(card()).not.toContainText(/123456|not-user-facing|PID|checkpoint/i)
  await expect(card().getByRole('button', { name: /停止|结束/ })).toHaveCount(0)
  await expect(card().getByRole('button', { name: '接受风险并恢复修改', exact: true })).toHaveCount(0)

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
    await page.locator('.n-dropdown-menu:visible').getByText('接受风险并恢复修改', { exact: true }).click()
  }
  await review()
  const confirmation = page.locator('.n-dialog').filter({ hasText: '接受风险并恢复修改？' })
  await expect(confirmation).toContainText('仅对以下 2 项恢复修改')
  await expect(confirmation).toContainText('不会重新运行旧命令')
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'recovery-confirmation.png'), animations: 'disabled' })
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  expect(readRecovery(databasePath).decisions).toEqual([])
  await review()
  await confirmation.getByRole('button', { name: '接受风险并恢复修改', exact: true }).click()
  await expect(confirmation).toBeHidden()
  await expect(card()).toHaveCount(0)
  await expect(page.getByText('已按你的选择接受风险并恢复所选位置的修改；此前操作仍未确认结束，旧命令不会自动重跑。', { exact: true })).toBeVisible()
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

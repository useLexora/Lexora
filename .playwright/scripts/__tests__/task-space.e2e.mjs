import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

test('moving a task requires confirmation, preserves its draft and previous files, and survives restart', async ({ buddy }) => {
  const instance = await buddy.createInstance('task-space')
  const target = path.join(instance.home, 'project')
  const previous = path.join(instance.home, 'buddy/conversations/movable/workspace')
  await fs.mkdir(target, { recursive: true })
  await fs.mkdir(previous, { recursive: true })
  await fs.writeFile(path.join(previous, 'unfinished.txt'), 'Original unfinished work')
  let { app, page, diagnostics } = await instance.launch()
  await app.evaluate(({ dialog }, { target, databasePath }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const now = new Date().toISOString()
      for (const id of ['movable', 'paused']) {
        db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, id === 'movable' ? '归入项目的任务' : '保留待发消息的任务', `branch-${id}`, now, now)
        db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
        db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`message-${id}`, id, `branch-${id}`, 'user', JSON.stringify({ text: 'Existing task history' }), now)
      }
      const queued = { conversationId: 'paused', branchId: 'branch-paused', buddyId: 'default', approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, queueRouting: { mode: 'current_actor' }, runInput: { attachmentIds: [] }, userMessageContent: { userContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: 'Preserved queued input' }] }], panelResourceIds: [] }, resourceSnapshots: [] } }
      db.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at) VALUES ('pending', 'paused', 'branch-paused', 'pending-request', 'pending-fingerprint', ?, 'paused', ?)`).run(JSON.stringify(queued), now)
    }
    finally { db.close() }
  }, { target, databasePath: path.join(instance.home, 'buddy/buddy.sqlite3') })
  await page.reload()
  const spaces = page.locator('[data-row-key="section:spaces"]')
  await spaces.locator('.desktop-task-sidebar__section-heading').hover()
  await spaces.locator('.desktop-task-sidebar__section-add').click()
  const spaceDialog = page.locator('.desktop-space-dialog')
  await spaceDialog.getByPlaceholder('输入空间名称').fill('目标项目')
  await spaceDialog.getByRole('button', { name: '选择目录', exact: true }).click()
  await spaceDialog.getByRole('button', { name: '确定', exact: true }).click()
  await expect(spaceDialog).toBeHidden()
  const spaceId = await page.evaluate(async () => (await window.lexoraDesktop.localChat.spaces.list()).find(space => space.name === '目标项目').id)
  const rowSelector = '[data-task-id="movable"]'
  const row = () => page.locator(rowSelector)
  await row().locator('.desktop-task-sidebar__task').click()
  const editor = () => page.locator('.desktop-chat-composer__prosemirror:visible')
  await editor().fill('移入后仍需保留的草稿')
  const openMoveDialog = async () => {
    await row().hover()
    await row().getByRole('button', { name: '更多操作', exact: true }).click()
    await page.locator('.n-dropdown-menu:visible').getByText('移入空间', { exact: true }).click()
    const dialog = page.locator('.desktop-task-move-dialog')
    await expect(dialog).toBeVisible()
    await dialog.locator('.n-base-selection').click()
    await page.locator('.n-base-select-menu:visible').getByText('目标项目', { exact: true }).click()
    await expect(dialog).toContainText('文件不搬迁')
    return dialog
  }
  let moveDialog = await openMoveDialog()
  await moveDialog.getByRole('button', { name: '取消', exact: true }).click()
  expect((await page.evaluate(() => window.lexoraDesktop.localChat.conversations.get('movable'))).spaceId).toBeNull()
  await expect(editor()).toContainText('移入后仍需保留的草稿')
  moveDialog = await openMoveDialog()
  await moveDialog.getByRole('button', { name: '移入', exact: true }).click()
  await expect(moveDialog).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.lexoraDesktop.localChat.conversations.get('movable'))).toMatchObject({ spaceId, activeBranchId: 'branch-movable' })
  await expect(row()).toBeVisible()
  await expect(editor()).toContainText('移入后仍需保留的草稿')
  expect(await fs.readFile(path.join(previous, 'unfinished.txt'), 'utf8')).toBe('Original unfinished work')
  expect(await fs.readdir(target)).toEqual([])
  const spaceRow = page.locator('.desktop-task-space-row').filter({ hasText: '目标项目' })
  await spaceRow.hover()
  await spaceRow.getByRole('button', { name: '置顶', exact: true }).click()
  await expect(spaceRow.getByRole('button', { name: '取消置顶', exact: true })).toBeVisible()
  await expect(row()).toBeVisible()
  await row().click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu:visible')).toBeVisible()
  await expect(page.locator('.n-dropdown-menu:visible').getByText('移入空间', { exact: true })).toHaveCount(0)
  await editor().click()
  await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)
  const queueError = await page.evaluate(async (spaceId) => {
    try {
      await window.lexoraDesktop.localChat.conversations.moveToSpace('paused', spaceId)
      return null
    }
    catch (error) { return error.message }
  }, spaceId)
  expect(queueError).toContain('CONVERSATION_QUEUE_NOT_EMPTY')
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await instance.stop()
  ;({ app, page, diagnostics } = await instance.launch())
  await expect(row()).toBeVisible()
  await expect(editor()).toContainText('移入后仍需保留的草稿')
  expect((await page.evaluate(() => window.lexoraDesktop.localChat.conversations.get('movable'))).spaceId).toBe(spaceId)
  expect(await fs.readFile(path.join(previous, 'unfinished.txt'), 'utf8')).toBe('Original unfinished work')
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

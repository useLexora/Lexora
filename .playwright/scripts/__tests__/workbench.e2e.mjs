import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'
import { prepareMobileDesktopProfile } from '../fixtures/mobile-desktop.mjs'

test('working copies preserve drafts, veto unsaved closure and recover across restart', async ({ buddy }) => {
  const instance = await buddy.createInstance('working-copy')
  const directory = path.join(instance.home, 'documents')
  const document = path.join(directory, 'README.md')
  await fs.mkdir(directory)
  await fs.writeFile(document, 'Original document.\n')
  let { app, page, diagnostics } = await instance.launch()
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, directory)
  const section = page.locator('[data-row-key="section:spaces"]')
  await section.locator('.desktop-task-sidebar__section-heading').hover()
  await section.locator('.desktop-task-sidebar__section-add').click()
  const spaceDialog = page.locator('.desktop-space-dialog')
  await spaceDialog.getByPlaceholder('输入空间名称').fill('工作副本验收')
  await spaceDialog.getByRole('button', { name: '选择目录', exact: true }).click()
  await expect(spaceDialog.locator('.desktop-space-primary-directory input')).toHaveValue(directory)
  await spaceDialog.getByRole('button', { name: '确定', exact: true }).click()
  await expect(spaceDialog).toBeHidden()
  const composer = page.locator('.desktop-chat-composer__prosemirror:visible')
  const draft = 'Keep this draft while changing the layout.'
  await composer.fill(draft)
  await page.locator('.desktop-workbench-area__tasks .tiptap').click()
  await page.keyboard.press('Control+Shift+P')
  await page.getByPlaceholder('输入命令名称').fill('文件')
  await page.getByPlaceholder('输入命令名称').press('Enter')
  await expect(page.locator('.n-modal')).toBeHidden()
  await page.getByTestId('context-file-tree').getByText('README.md', { exact: true }).click()
  await page.getByTestId('document-mode-edit').click()
  let editor = page.getByTestId('workbench-text-editor')
  await expect(editor.locator('.view-lines')).toContainText('Original document.')
  await editor.locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('First edit.\n')
  await expect(page.locator('.file-editor[data-dirty="true"]')).toBeVisible()
  await page.keyboard.insertText('Second edit while dirty.\n')
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.workbench.read())?.backups.some(backup => backup.text.includes('Second edit while dirty.')))).toBe(true)
  const readBackup = () => page.evaluate(async () => (await window.lexoraDesktop.workbench.read())?.backups.find(backup => backup.resource.data.path === 'README.md')?.text)
  const beforeUndo = await readBackup()
  await page.keyboard.press('Control+z')
  await expect.poll(readBackup).not.toBe(beforeUndo)
  await page.keyboard.press('Control+y')
  await expect.poll(readBackup).toBe(beforeUndo)
  await expect(editor.locator('.view-lines')).toContainText('Second edit while dirty.')
  expect(await fs.readFile(document, 'utf8')).toBe('Original document.\n')
  await page.getByTestId('task-context-panel').getByRole('tab', { name: '文件', exact: true }).click({ button: 'right' })
  await page.locator('.n-dropdown-menu:visible').getByText('关闭全部', { exact: true }).click()
  const close = page.locator('.n-dialog').filter({ hasText: '关闭前保存更改？' })
  await close.getByRole('button', { name: '取消', exact: true }).click()
  await expect(close).toBeHidden()
  await expect(editor.locator('.view-lines')).toContainText('Second edit while dirty.')
  await instance.stop()
  ;({ app, page, diagnostics } = await instance.launch())
  await expect(page.locator('.desktop-chat-composer__prosemirror:visible')).toHaveText(draft)
  const panelToggle = page.getByTestId('context-panel-toggle')
  if (await panelToggle.getAttribute('aria-expanded') === 'false')
    await panelToggle.click()
  editor = page.getByTestId('workbench-text-editor')
  await expect(editor.locator('.view-lines')).toContainText('Second edit while dirty.')
  await expect(page.locator('.file-editor[data-dirty="true"]')).toBeVisible()
  expect(await fs.readFile(document, 'utf8')).toBe('Original document.\n')
  await editor.locator('.view-lines').click()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.file-editor[data-dirty="false"]')).toBeVisible()
  await expect.poll(() => fs.readFile(document, 'utf8')).toContain('Second edit while dirty.')
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.workbench.read())?.backups.length)).toBe(0)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('task switching preserves drafts and ignores late loading results while failures remain retryable', async ({ buddy }) => {
  const instance = await buddy.createInstance('task-switch')
  const { app, page, diagnostics } = await instance.launch()
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.runtime.getStatus()).status), { timeout: 45000 }).toBe('ready')
  await app.evaluate((_electron, databasePath) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const now = new Date().toISOString()
      for (const id of ['a', 'b', 'c']) {
        db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, `Task ${id.toUpperCase()}`, `branch-${id}`, now, now)
        db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
        db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`message-${id}`, id, `branch-${id}`, 'user', JSON.stringify({ text: `Content ${id.toUpperCase()}` }), now)
      }
    }
    finally { db.close() }
  }, path.join(instance.home, 'buddy/buddy.sqlite3'))
  await page.reload()
  const row = id => page.locator(`[data-task-id="${id}"] .desktop-task-sidebar__task`)
  const editor = page.locator('.desktop-chat-composer__prosemirror:visible')
  const title = page.locator('.workbench-pane-title:visible')
  await row('a').click()
  await expect(editor).toBeVisible()
  await editor.fill('Saved while switching')
  await app.evaluate(({ ipcMain }) => {
    const probe = globalThis.taskSwitchProbe = { events: [], gates: new Map(), fail: null }
    for (const [stage, channel] of [
      ['get', 'lexora:buddy:conversations:get'],
      ['draft', 'lexora:buddy:composer-drafts:open'],
    ]) {
      const handler = ipcMain._invokeHandlers.get(channel)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input) => {
        const id = input.conversationId ?? input.scope?.conversationId
        probe.events.push({ id, stage, phase: 'start' })
        await probe.gates.get(`${stage}:${id}`)?.promise
        if (stage === 'get' && probe.fail === id)
          throw new Error('Isolated task read failure')
        const result = await handler(event, input)
        probe.events.push({ id, stage, phase: 'end' })
        return result
      })
    }
  })
  const block = key => app.evaluate((_electron, key) => {
    globalThis.taskSwitchProbe.gates.set(key, Promise.withResolvers())
  }, key)
  const release = key => app.evaluate((_electron, key) => {
    const gates = globalThis.taskSwitchProbe.gates
    gates.get(key)?.resolve()
    gates.delete(key)
  }, key)
  await block('draft:b')
  await row('b').click()
  await expect(title).toHaveText('Task B')
  await expect(row('b')).toHaveClass(/is-active/)
  await expect(page.getByTestId('task-loading')).toHaveAttribute('aria-busy', 'true')
  await row('c').click()
  await expect(title).toHaveText('Task C')
  await expect(editor).toBeVisible()
  await release('draft:b')
  await expect.poll(() => app.evaluate(() => globalThis.taskSwitchProbe.events.some(event => event.id === 'b' && event.stage === 'draft' && event.phase === 'end'))).toBe(true)
  await expect(title).toHaveText('Task C')
  await row('a').click()
  await expect(editor).toHaveText('Saved while switching')

  await app.evaluate(() => {
    globalThis.taskSwitchProbe.fail = 'b'
  })
  await row('b').click()
  const failed = page.getByTestId('task-loading').getByRole('alert')
  await expect(failed).toContainText('视图加载失败')
  await row('a').click()
  await expect(editor).toHaveText('Saved while switching')
  await row('b').click()
  await expect(failed).toBeVisible()
  await app.evaluate(() => {
    globalThis.taskSwitchProbe.fail = null
  })
  await failed.getByRole('button', { name: '重试', exact: true }).click()
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('task-loading')).toHaveCount(0)

  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

async function prepareNotificationNavigation(buddy, label, profileOutput) {
  const instance = await buddy.createInstance(label)
  if (profileOutput)
    await prepareMobileDesktopProfile(instance.home, profileOutput)
  const desktop = await instance.launch({ storageAuthority: profileOutput ? 'sqlite' : 'legacy_jsonl' })
  const window = await desktop.app.browserWindow(desktop.page)
  await expect.poll(() => desktop.page.evaluate(async () => (await window.lexoraDesktop.localChat.runtime.getStatus()).status), { timeout: 45000 }).toBe('ready')
  await window.evaluate(window => window.setSize(1600, 1000))
  await desktop.app.evaluate((_electron, databasePath) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const now = Date.now()
      const createdAt = new Date(now).toISOString()
      const insertMessage = db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      for (const id of ['a', 'b']) {
        db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, `Notification task ${id.toUpperCase()}`, `branch-${id}`, createdAt, createdAt)
        db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, createdAt)
        insertMessage.run(`message-${id}`, id, `branch-${id}`, 'user', JSON.stringify({ text: `Original content ${id.toUpperCase()}` }), createdAt)
      }
      db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('notification-branch', 'b', createdAt)
      insertMessage.run('notification-message', 'b', 'notification-branch', 'user', JSON.stringify({ text: 'The notification points to this earlier message.' }), createdAt)
      db.prepare('INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('notification-run', 'b', 'notification-branch', 'notification-message', 'fixture', 'fixture', 'chat', 'completed', createdAt, createdAt)
      for (let index = 1; index <= 24; index++) {
        insertMessage.run(`later-message-${index}`, 'b', 'notification-branch', 'user', JSON.stringify({ text: `Later branch message ${index}\n\nThis later content must not replace the notification's earlier scroll target.` }), new Date(now + index * 1000).toISOString())
      }
    }
    finally { db.close() }
  }, path.join(instance.home, 'buddy/buddy.sqlite3'))
  await desktop.page.reload()
  return { ...desktop, instance, window }
}

function notificationTask(page, id) {
  return page.locator(`[data-task-id="${id}"] .desktop-task-sidebar__task`)
}

function notificationPane(page, id) {
  return page.locator('.workbench-pane').filter({ has: page.locator('.workbench-pane-title', { hasText: `Notification task ${id.toUpperCase()}` }) })
}

async function sendNotificationTarget(window) {
  await window.evaluate(window => window.webContents.send('lexora:app:open-target', { conversationId: 'b', runId: 'notification-run' }))
}

async function expectNotificationBranch(page, pane) {
  await expect(pane.locator('[data-message-id="notification-message"]')).toBeAttached()
  const viewId = await pane.locator('.workbench__view[data-resource-id="b"]').getAttribute('data-view-id')
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.workbench.read())?.layout.views[id]?.resource, viewId)).toMatchObject({
    scheme: 'task',
    id: 'b',
    data: { branchId: 'notification-branch' },
  })
  expect(await page.evaluate(async () => (await window.lexoraDesktop.localChat.conversations.get('b')).activeBranchId)).toBe('branch-b')
}

async function expectNotificationMessage(page, pane) {
  const message = pane.locator('[data-message-id="notification-message"]')
  await expect(message).toContainText('The notification points to this earlier message.')
  await expect(message).toBeInViewport()
  const laterMessages = await page.evaluate(() => window.lexoraDesktop.localChat.conversations.listMessages({ conversationId: 'b', branchId: 'notification-branch', limit: 100 }))
  expect(laterMessages.items.map(item => item.id)).toContain('later-message-24')
  await expect(pane.locator('[data-message-id="later-message-24"]')).not.toBeInViewport()
  await expectNotificationBranch(page, pane)
  await expect(pane.locator('[data-message-id="message-b"]')).toHaveCount(0)
}

test('history dragging moves the existing branch view and preserves both inputs across restart', async ({ buddy }, testInfo) => {
  const desktop = await prepareNotificationNavigation(buddy, 'history-branch-drag', testInfo.outputPath('profile-preparation'))
  let { page } = desktop
  await notificationTask(page, 'a').click()
  let first = notificationPane(page, 'a')
  await first.locator('.desktop-chat-composer__prosemirror').fill('Draft A stays with its branch.')
  await first.getByTestId('pane-layout-menu').click()
  await page.locator('.n-dropdown-menu:visible').getByText('分屏', { exact: true }).hover()
  await page.locator('.n-dropdown-menu:visible').getByText('向右分屏', { exact: true }).click()
  const newPane = page.locator('.workbench-pane').filter({ has: page.getByRole('button', { name: '新任务', exact: true }) })
  await expect(newPane.locator('.desktop-chat-composer__prosemirror')).toBeVisible()
  await notificationTask(page, 'b').click()
  let second = notificationPane(page, 'b')
  await second.locator('.desktop-chat-composer__prosemirror').fill('Draft B stays independent.')
  const firstViewId = await first.locator('.workbench__view[data-resource-id="a"]').getAttribute('data-view-id')
  const secondViewId = await second.locator('.workbench__view[data-resource-id="b"]').getAttribute('data-view-id')
  await expect.poll(() => page.evaluate(async () => {
    const saved = await window.lexoraDesktop.localChat.draftRecovery.load()
    return saved.records.filter(record => ['conversation:a:branch-a', 'conversation:b:branch-b'].includes(record.snapshot.targetKey)
      && record.snapshot.content.body.some(paragraph => paragraph.content.some(node => node.type === 'text' && node.text.startsWith('Draft ')))).length
  })).toBe(2)

  const source = await notificationTask(page, 'a').boundingBox()
  const target = await second.boundingBox()
  expect(source).not.toBeNull()
  expect(target).not.toBeNull()
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width - 12, target.y + target.height / 2, { steps: 20 })
  await expect(second.locator('[data-drop-position="right"]')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.workbench-pane')).toHaveCount(2)
  await expect(first.locator('.workbench__view')).toHaveAttribute('data-view-id', firstViewId)
  await expect(second.locator('.workbench__view')).toHaveAttribute('data-view-id', secondViewId)
  await expect(first.locator('.desktop-chat-composer__prosemirror')).toHaveText('Draft A stays with its branch.')
  await expect(second.locator('.desktop-chat-composer__prosemirror')).toHaveText('Draft B stays independent.')
  expect((await first.boundingBox()).x).toBeGreaterThan((await second.boundingBox()).x)
  await expect.poll(() => page.evaluate(async () => {
    const layout = (await window.lexoraDesktop.workbench.read())?.layout
    const ordered = node => node.kind === 'pane' ? [layout.views[node.view]?.resource.id] : [...ordered(node.first), ...ordered(node.second)]
    return layout ? ordered(layout.root) : []
  })).toEqual(['b', 'a'])

  await desktop.instance.stop()
  const restarted = await desktop.instance.launch({ storageAuthority: 'sqlite' })
  page = restarted.page
  first = notificationPane(page, 'a')
  second = notificationPane(page, 'b')
  await expect(page.locator('.workbench-pane')).toHaveCount(2)
  await notificationTask(page, 'b').click()
  await expect(second.locator('.desktop-chat-composer__prosemirror')).toHaveText('Draft B stays independent.')
  await notificationTask(page, 'a').click()
  await expect(first.locator('.desktop-chat-composer__prosemirror')).toHaveText('Draft A stays with its branch.')
  await expect(page.locator('.desktop-draft-restoration:visible')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '对话分支', exact: true })).toHaveCount(0)
  expect((await first.boundingBox()).x).toBeGreaterThan((await second.boundingBox()).x)
  await page.screenshot({ path: testInfo.outputPath('history-branch-drag.png') })
  await page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id: 'lexora.themes.classic-dark' } }))
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', 'dark')
  await page.screenshot({ path: testInfo.outputPath('history-branch-drag-dark.png') })
  const browserWindow = await restarted.app.browserWindow(page)
  await browserWindow.evaluate(window => window.setSize(...window.getMinimumSize()))
  await expect(first.locator('.desktop-chat-composer__prosemirror')).toBeVisible()
  await expect(second.locator('.desktop-chat-composer__prosemirror')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('history-branch-drag-narrow.png') })
  expect([...desktop.diagnostics.console, ...restarted.diagnostics.console].filter(item => item.type === 'pageerror')).toEqual([])
})

test('notification targets reuse split panes and restore the task from settings without losing the other draft', async ({ buddy }) => {
  const { page, window, diagnostics } = await prepareNotificationNavigation(buddy, 'notification-split')
  await notificationTask(page, 'a').click()
  const first = notificationPane(page, 'a')
  await first.getByTestId('pane-layout-menu').click()
  await page.locator('.n-dropdown-menu:visible').getByText('分屏', { exact: true }).hover()
  await page.locator('.n-dropdown-menu:visible').getByText('向右分屏', { exact: true }).click()
  await notificationTask(page, 'b').click()
  const second = notificationPane(page, 'b')
  await expect(second.locator('[data-message-id="message-b"]')).toContainText('Original content B')
  const firstId = await first.getAttribute('data-pane-id')
  const secondId = await second.getAttribute('data-pane-id')
  const firstEditor = first.locator('.desktop-chat-composer__prosemirror')
  await firstEditor.fill('Keep the other pane and its draft.')
  await expect(first).toHaveClass(/is-focused/)
  await expect(second).not.toHaveClass(/is-focused/)

  await sendNotificationTarget(window)
  await expectNotificationMessage(page, second)
  await expect(second).toHaveClass(/is-focused/)
  await expect(first).not.toHaveClass(/is-focused/)
  await expect(page.locator('.workbench-pane')).toHaveCount(2)
  await expect(first).toHaveAttribute('data-pane-id', firstId)
  await expect(second).toHaveAttribute('data-pane-id', secondId)
  await expect(firstEditor).toHaveText('Keep the other pane and its draft.')
  await expect(first.locator('[data-message-id="message-a"]')).toContainText('Original content A')
  await expect(notificationTask(page, 'b')).toHaveClass(/is-active/)
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('.desktop-settings-sidebar')).toBeVisible()
  await sendNotificationTarget(window)
  await expect(page).toHaveURL(/#\/tasks$/)
  await expect(page.locator('.desktop-settings-sidebar')).toBeHidden()
  await expectNotificationMessage(page, second)
  await expect(page.locator('.workbench-pane')).toHaveCount(2)
  await expect(first).toHaveAttribute('data-pane-id', firstId)
  await expect(second).toHaveAttribute('data-pane-id', secondId)
  await expect(firstEditor).toHaveText('Keep the other pane and its draft.')
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('notification navigation: app:open-target opens an unopened task while hidden and reveals its earlier run message after restore', async ({ buddy }, testInfo) => {
  testInfo.annotations.push({ type: 'coverage', description: 'Delivers the real main-to-preload app:open-target event while BrowserWindow is hidden. Does not click a Windows toast or validate OS foreground activation.' })
  const { page, window, diagnostics } = await prepareNotificationNavigation(buddy, 'notification-background')
  await notificationTask(page, 'a').click()
  await expect(notificationPane(page, 'a').locator('[data-message-id="message-a"]')).toContainText('Original content A')
  await expect(notificationPane(page, 'b')).toHaveCount(0)
  await window.evaluate(window => window.hide())
  await expect.poll(() => window.evaluate(window => ({ visible: window.isVisible(), focused: window.isFocused() }))).toEqual({ visible: false, focused: false })

  await sendNotificationTarget(window)
  await expectNotificationBranch(page, notificationPane(page, 'b'))
  await expect(notificationTask(page, 'b')).toHaveClass(/is-active/)
  expect(await window.evaluate(window => window.isVisible())).toBe(false)
  await window.evaluate(window => window.showInactive())
  await expect.poll(() => window.evaluate(window => window.isVisible())).toBe(true)
  const pane = notificationPane(page, 'b')
  await expectNotificationMessage(page, pane)
  await expect(page.locator('.workbench-pane')).toHaveCount(1)
  await expect(notificationPane(page, 'a')).toHaveCount(0)
  await expect(notificationTask(page, 'b')).toHaveClass(/is-active/)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

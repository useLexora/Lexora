import fs from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from '../fixtures/electron.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requireBuddy = createRequire(path.join(root, 'apps/buddy/package.json'))

async function prepareProfile(home) {
  const output = test.info().outputPath('profile-preparation')
  const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
  await build({ configFile: false, logLevel: 'error', build: {
    ssr: path.join(root, '.playwright/scripts/__tests__/prepareProductProfile.ts'),
    outDir: output,
    target: 'node26',
    rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'prepare.mjs', format: 'es' } },
  } })
  const { prepareProductProfile } = await import(pathToFileURL(path.join(output, 'prepare.mjs')).href)
  prepareProductProfile(home)
}

test('candidate Desktop persists inputs and recovers stale saves through the product protocol', async ({ buddy }) => {
  const instance = await buddy.createInstance('product-desktop')
  await prepareProfile(instance.home)
  let { page } = await instance.launch({ storageAuthority: 'sqlite' })
  const editor = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
  await expect(editor).toBeVisible()
  await editor.fill('Persist the candidate input 中文 🚀')
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.composerDrafts.list()).map(draft => JSON.stringify(draft.content)).join('\n'))).toContain('Persist the candidate input')
  const proof = await page.evaluate(async () => {
    const api = window.lexoraDesktop.localChat
    const draft = (await api.composerDrafts.list()).find(draft => JSON.stringify(draft.content).includes('Persist the candidate input'))
    if (draft.revision < 1)
      throw new Error('Expected the edited draft to have a committed revision')
    const textContent = text => ({ version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text }] }], panelResourceIds: [] })
    for (const content of [draft.content, ...Array.from({ length: 5 }, () => textContent('Recover unconfirmed desktop input')), textContent('Second unconfirmed input')]) {
      const rejected = await api.composerDrafts.save({
        draftId: draft.draftId,
        expectedRevision: draft.revision - 1,
        content,
        modelSelection: draft.modelSelection,
        executionConfig: draft.executionConfig,
        participants: draft.participants,
      }, draft.scope).then(() => false, () => true)
      if (!rejected)
        throw new Error('Unexpectedly saved a stale draft')
    }
    return { originalDraftId: draft.draftId }
  })
  const badge = () => page.locator('.desktop-navigation-controls .n-badge-sup:visible')
  const notificationButton = () => page.locator('.desktop-app-sidebar__notification-trigger:visible')
  const recoveryEntries = () => page.locator('.desktop-notification-center').getByRole('button', { name: /草稿未保存/ })
  await expect(badge()).toBeVisible()
  await notificationButton().click()
  await page.getByRole('button', { name: /未读/ }).click()
  await expect(recoveryEntries()).toHaveCount(2)
  await expect(recoveryEntries().first()).toContainText('新任务')
  await expect(recoveryEntries().first()).toContainText('Second unconfirmed input')
  await recoveryEntries().first().click()
  await expect(page.getByText('Second unconfirmed input', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.notifications.list()).unseenCount)).toBe(1)
  await page.keyboard.press('Escape')
  await notificationButton().click()
  await page.getByRole('button', { name: /未读/ }).click()
  await expect(recoveryEntries()).toHaveCount(1)
  await page.getByRole('button', { name: '全部标为已读' }).click()
  await expect(recoveryEntries()).toHaveCount(0)
  await expect(badge()).toHaveCount(0)
  await instance.stop()
  page = (await instance.launch({ storageAuthority: 'sqlite' })).page
  await expect(page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()).toContainText('Persist the candidate input')
  await expect.poll(() => page.evaluate(async () => {
    const notices = await window.lexoraDesktop.localChat.notifications.list()
    return notices.items.filter(item => item.kind === 'operation.recovery').map(item => item.attention)
  })).toEqual(['seen', 'seen'])
  await expect(badge()).toHaveCount(0)
  const titleBar = await page.locator('.desktop-title-bar').boundingBox()
  const body = await page.locator('.desktop-shell__body').boundingBox()
  expect(body.y).toBeCloseTo(titleBar.y + titleBar.height)
  await notificationButton().click()
  await expect(recoveryEntries()).toHaveCount(2)
  await page.screenshot({ path: test.info().outputPath('recovery-notification.png'), animations: 'disabled' })
  await recoveryEntries().first().click()
  await expect(page.getByText('Second unconfirmed input', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '已核对，移除此恢复项' }).click()
  await notificationButton().click()
  await expect(recoveryEntries()).toHaveCount(1)
  await recoveryEntries().click()
  await expect(page.getByText('Recover unconfirmed desktop input', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存为新草稿', exact: true }).click()
  await expect(page.locator('.tiptap:visible').filter({ hasText: 'Recover unconfirmed desktop input' })).toBeVisible()
  const result = await page.evaluate(async () => {
    const api = window.lexoraDesktop.localChat
    return { drafts: (await api.composerDrafts.list()).map(draft => ({ draftId: draft.draftId, content: draft.content })), recovery: await api.runtime.listRecovery() }
  })
  expect(result.recovery).toEqual([])
  await notificationButton().click()
  await expect(page.locator('.desktop-notification-center')).toBeVisible()
  await expect(recoveryEntries()).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(result.drafts.find(draft => draft.draftId === proof.originalDraftId)?.content.body[0].content[0].text).toContain('Persist the candidate input')
  await fs.writeFile(test.info().outputPath('product-desktop.json'), JSON.stringify({ ...proof, ...result }, null, 2))
  await page.screenshot({ path: test.info().outputPath('product-desktop.png') })
})

test('draft recovery uses the source task conflict dialog and withdraws the matching reminder from either entry point', async ({ buddy }) => {
  const instance = await buddy.createInstance('task-draft-conflict')
  await prepareProfile(instance.home)
  const db = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'))
  try {
    const at = new Date().toISOString()
    db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('draft-task', '草稿来源测试', 'draft-branch', at, at)
    db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('draft-branch', 'draft-task', at)
  }
  finally { db.close() }
  const { page } = await instance.launch({ storageAuthority: 'sqlite' })
  await page.locator('[data-task-id="draft-task"] .desktop-task-sidebar__task').click()
  const editor = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
  await editor.fill('Initial input')
  const readDraft = async () => {
    const db = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
    let id
    try {
      id = db.prepare('SELECT id FROM composer_drafts WHERE conversation_id = ? AND branch_id = ? AND scope_kind = ?').get('draft-task', 'draft-branch', 'conversation_branch')?.id
    }
    finally { db.close() }
    return id ? page.evaluate(id => window.lexoraDesktop.localChat.composerDrafts.get(id), id) : null
  }
  await expect.poll(async () => (await readDraft())?.content.body).toContainEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Initial input' }] })
  const reminders = () => page.evaluate(async () => (await window.lexoraDesktop.localChat.notifications.list()).items.filter(item => item.kind === 'operation.recovery'))
  for (const entry of ['notification', 'task']) {
    const remoteText = `Saved by another editor (${entry})`
    const localText = `Unsent local input (${entry})`
    await page.evaluate(async ({ draft, remoteText }) => {
      await window.lexoraDesktop.localChat.composerDrafts.save({ draftId: draft.draftId, expectedRevision: draft.revision, executionConfig: draft.executionConfig, modelSelection: draft.modelSelection, participants: draft.participants, content: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: remoteText }] }], panelResourceIds: [] } }, draft.scope)
    }, { draft: await readDraft(), remoteText })
    await editor.fill(localText)
    const review = page.getByRole('button', { name: '选择输入', exact: true })
    await expect(review).toBeVisible()
    await expect.poll(reminders).toHaveLength(1)
    if (entry === 'notification') {
      await page.locator('.desktop-app-sidebar__notification-trigger:visible').click()
      const source = page.locator('.desktop-notification-center').getByRole('button', { name: /草稿未保存/ })
      await expect(source).toContainText('草稿来源测试')
      await expect(source).toContainText(localText)
      await source.click()
    }
    else { await review.click() }
    const dialog = page.getByRole('dialog').filter({ hasText: '草稿恢复冲突' })
    await expect(dialog).toContainText(localText)
    await expect(dialog).toContainText(remoteText)
    if (entry === 'notification')
      await page.screenshot({ path: test.info().outputPath('draft-conflict.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: /已保存的草稿/ }).click()
    await expect(editor).toHaveText(remoteText)
    await expect.poll(reminders).toHaveLength(0)
  }
})

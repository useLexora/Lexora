import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures/electron.mjs'

test('quotes file and Markdown snapshots while preserving native editor actions and explicit draft routing', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('selection-reference')
  const directory = path.join(instance.home, 'documents')
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'README.md'), 'Frozen document excerpt.\n\nSecond paragraph.\n')
  const { app, page, diagnostics } = await instance.launch()
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, directory)
  await expect(page.locator('.desktop-workbench-area__tasks .tiptap:visible')).toBeVisible()
  const section = page.locator('.desktop-task-sidebar__spaces')
  // Space creation is fixture setup, not the selection-entry interaction under test.
  // Dispatch directly so startup autofocus/hover-only controls cannot steal the setup keystroke.
  await section.locator('.desktop-task-sidebar__section-add').dispatchEvent('click')
  const spaceDialog = page.locator('.desktop-space-dialog')
  await spaceDialog.getByPlaceholder('输入空间名称').fill('引用验收')
  await spaceDialog.getByRole('button', { name: '选择目录', exact: true }).click()
  await spaceDialog.getByRole('button', { name: '确定', exact: true }).click()
  await expect(spaceDialog).toBeHidden()
  // Creating a Space already opens its new task; avoid unrelated hover-only sidebar actions.
  await expect(page.locator('.desktop-workbench-area__tasks').getByRole('button', { name: '引用验收', exact: true })).toBeVisible()
  const input = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
  await input.fill('Keep my latest question.')
  await page.keyboard.press('Control+Shift+P')
  await page.getByPlaceholder('输入命令名称').fill('文件')
  await page.getByPlaceholder('输入命令名称').press('Enter')
  await expect(page.locator('.n-modal')).toBeHidden()
  await page.getByTestId('context-file-tree').getByText('README.md', { exact: true }).click()
  const paragraph = page.locator('.desktop-document-content__markdown p').filter({ hasText: 'Frozen document excerpt.' })
  await expect(paragraph).toBeVisible()
  await paragraph.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
  })
  await paragraph.click({ button: 'right' })
  const menu = page.locator('.resource-selection-menu:visible').first()
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: '引用到对话', exact: true }).click()
  const cards = page.locator('.desktop-chat-composer-wrap .resource-quote-card')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Frozen document excerpt.')
  await expect(input.locator('[data-type="chat-quote-reference"]')).toHaveCount(1)
  await expect(input).toContainText('Keep my latest question.')
  expect(await input.evaluate(element => element.contains(document.activeElement))).toBe(false)
  await cards.first().locator('.chat-reference-card__link').click()
  await page.getByRole('button', { name: '定位来源', exact: true }).click()
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('buddy-resource-quote')?.size ?? 0)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('document-mode-edit').click()
  const editor = page.getByTestId('workbench-text-editor')
  await expect(editor.locator('.view-lines')).toContainText('Frozen document excerpt.')
  await editor.locator('.view-lines').click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  await editor.locator('.view-line span').filter({ hasText: 'Frozen document excerpt.' }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '引用', exact: true }).click({ delay: 120 })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: '引用到对话', exact: true }).click()
  await expect(cards).toHaveCount(2)
  await expect(cards.last()).toContainText('L1–1')
  await expect(input).toContainText('Keep my latest question.')
  expect(await input.evaluate(element => element.contains(document.activeElement))).toBe(false)
  // Check source-local editing, not the composer's undo history.
  await page.keyboard.press('End')
  await page.keyboard.type(' Extra.')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  // Click a visible content point; the long selected line can extend behind the gutter.
  await editor.locator('.monaco-scrollable-element').first().click({ button: 'right', position: { x: 100, y: 12 } })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Z')
  await expect(editor.locator('.view-lines')).not.toContainText(' Extra.')
  await expect(input).toContainText('Keep my latest question.')
  await input.click()
  await input.press('End')
  await page.keyboard.insertText(' @README.md')
  await page.getByRole('option').filter({ has: page.locator('.buddy-file-icon') }).filter({ hasText: 'README.md' }).first().click()
  const strip = page.locator('.desktop-chat-composer-wrap .chat-input-material-strip')
  await expect(strip).toHaveCount(1)
  await expect(strip.locator('[data-material-key]')).toHaveCount(3)
  await expect(page.locator('.n-message')).toHaveCount(0)
  for (const appearance of ['light', 'dark']) {
    await page.evaluate(id => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id } }), `lexora.themes.classic-${appearance}`)
    await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', appearance)
    await page.screenshot({ path: testInfo.outputPath(`input-materials-${appearance}.png`), animations: 'disabled' })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720))
  const scrollport = strip.locator('.chat-input-material-strip__scrollport')
  expect(await strip.locator('[data-material-key]').evaluateAll(cards => new Set(cards.map(card => Math.round(card.getBoundingClientRect().top))).size)).toBe(1)
  expect(await scrollport.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('input-materials-narrow.png'), animations: 'disabled' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
  await input.click()
  await page.keyboard.press('Control+\\')
  const inputs = page.locator('.desktop-workbench-area__tasks .tiptap:visible')
  await expect(inputs).toHaveCount(2)
  await input.click()
  await expect(editor).toBeVisible()
  await editor.locator('.monaco-scrollable-element').first().click({ position: { x: 100, y: 12 } })
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  await editor.locator('.monaco-scrollable-element').first().click({ button: 'right', position: { x: 100, y: 12 } })
  await page.getByRole('menuitem', { name: '引用', exact: true }).click({ delay: 120 })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '引用到对话', exact: true })).toHaveCount(0)
  await menu.getByRole('menuitem', { name: '引用到其他对话', exact: true }).hover()
  const child = page.locator('.resource-selection-menu:visible').filter({ has: page.locator('.resource-selection-menu-option__label').filter({ hasText: /^分屏 2/ }) }).last()
  await expect(child).toBeVisible()
  await child.getByRole('menuitem').click()
  await expect(page.locator('.desktop-chat-composer-wrap .resource-quote-card')).toHaveCount(3)
  await expect(input).toContainText('Keep my latest question.')
  await expect(inputs.nth(1).locator('[data-type="chat-quote-reference"]')).toHaveCount(1)
  expect(await inputs.nth(1).evaluate(element => element.contains(document.activeElement))).toBe(false)
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('mixed input materials preserve exact draft snapshots, resource bytes and all placements through removal, undo and desktop restart', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('material-recovery')
  let desktop = await instance.launch()
  let page = desktop.page
  let input = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
  await expect(input).toBeVisible()
  const text = 'Keep this entire mixed-material draft.'
  const attachmentText = '  Original attachment 文本\r\nSecond line\tend\n'
  await input.fill(text)
  await page.evaluate((text) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'original.txt', { type: 'text/plain' }))
    document.querySelector('.desktop-chat-composer-wrap').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, attachmentText)
  await expect(page.locator('.desktop-chat-composer-wrap [data-resource-card]')).toHaveCount(1)
  let draftId
  await expect.poll(async () => {
    const drafts = await page.evaluate(() => window.lexoraDesktop.localChat.composerDrafts.list())
    const draft = drafts.find(draft => draft.content.body.some(paragraph => paragraph.content.some(node => node.type === 'text' && node.text === text)))
    if (!draft?.content.panelResourceIds.length)
      return false
    draftId = draft.draftId
    return page.evaluate(async (id) => {
      const resources = await window.lexoraDesktop.localChat.composerResources.list(id)
      return resources.length === 1 && resources.every(resource => resource.state === 'ready')
    }, draftId)
  }).toBe(true)
  const before = await page.evaluate(async ({ draftId, text }) => {
    const api = window.lexoraDesktop.localChat
    const draft = await api.composerDrafts.get(draftId)
    const resourceId = draft.content.panelResourceIds[0]
    const content = {
      ...draft.content,
      body: [{ type: 'paragraph', content: [
        { type: 'text', text },
        { type: 'resource_ref', resourceId },
        { type: 'quote_ref', quoteKind: 'message', quoteId: 'message-snapshot' },
        { type: 'quote_ref', quoteKind: 'resource', quoteId: 'file-snapshot' },
        { type: 'quote_ref', quoteKind: 'resource', quoteId: 'file-snapshot' },
      ] }],
      quotes: [{ id: 'message-snapshot', text: '    Frozen reply 文本\r\nKeep whitespace\n', textOffset: 7, source: { conversationId: 'source-conversation', branchId: 'source-branch', messageId: 'source-message', runId: null, role: 'assistant' } }],
      resourceQuotes: [{ id: 'file-snapshot', text: '    Frozen file snapshot\n', range: { startLineNumber: 2, startColumn: 3, endLineNumber: 3, endColumn: 7 }, source: { kind: 'file', title: 'source.md', file: { spaceId: 'source-space', directoryId: 'source-directory', revision: 3, path: 'source.md' }, format: 'source' } }],
    }
    const saved = await api.composerDrafts.save({ draftId, expectedRevision: draft.revision, content, executionConfig: draft.executionConfig, modelSelection: draft.modelSelection })
    return { content: saved.content, resources: await api.composerResources.list(draftId) }
  }, { draftId, text })
  await page.reload()
  await expect(input.locator('[data-type="chat-quote-reference"]')).toHaveCount(3)
  const sourceCard = page.locator('.desktop-chat-composer-wrap [data-material-key="resource_quote:file-snapshot"]')
  await sourceCard.getByRole('button', { name: '移除引用', exact: true }).click()
  await expect(input.locator('[data-type="chat-quote-reference"]')).toHaveCount(1)
  await expect(page.locator('.desktop-chat-composer-wrap [data-material-key]')).toHaveCount(2)
  await input.click()
  await input.press('Control+z')
  await expect(input.locator('[data-type="chat-quote-reference"]')).toHaveCount(3)
  await expect(page.locator('.desktop-chat-composer-wrap [data-material-key]')).toHaveCount(3)
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.localChat.composerDrafts.get(id)).content, draftId)).toEqual(before.content)
  await instance.stop()
  desktop = await instance.launch()
  page = desktop.page
  input = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
  await expect(input.locator('[data-type="chat-quote-reference"]')).toHaveCount(3)
  await expect(input.locator('[data-type="chat-resource-reference"]')).toHaveCount(1)
  await expect(page.locator('.desktop-chat-composer-wrap [data-material-key]')).toHaveCount(3)
  const restored = await page.evaluate(async id => ({
    content: (await window.lexoraDesktop.localChat.composerDrafts.get(id)).content,
    resources: await window.lexoraDesktop.localChat.composerResources.list(id),
  }), draftId)
  expect(restored).toEqual(before)
  const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
  let storedPath
  try {
    storedPath = database.prepare('SELECT stored_path FROM attachments WHERE id=?').get(restored.resources[0].attachmentId).stored_path
  }
  finally { database.close() }
  expect(await fs.readFile(storedPath)).toEqual(Buffer.from(attachmentText))
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('input-materials-recovered.png'), animations: 'disabled' })
})

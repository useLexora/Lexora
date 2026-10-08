import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures/electron.mjs'

test('built-in artifact previews quote Markdown and source text to one selected draft and send frozen content', async ({ buddy }) => {
  const instance = await buddy.createInstance('artifact-selection')
  const directory = path.join(instance.home, 'documents')
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'report.md'), '# Artifact report\n\nFrozen artifact paragraph.\n')
  await fs.writeFile(path.join(directory, 'data.csv'), 'item,budget,actual\nsoftware,500,800\n')
  await fs.writeFile(path.join(directory, 'code.ts'), 'export const answer = 42\n')
  await fs.writeFile(path.join(directory, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDv8AAAAASUVORK5CYII=', 'base64'))
  await fs.writeFile(path.join(directory, 'unsupported.pdf'), '%PDF-1.4\nFixture placeholder\n')
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    const common = { id: `artifact-${requests.length}`, model: 'artifact-fixture', object: 'chat.completion.chunk', created: 1 }
    const publishing = requests.length === 1
    const delta = publishing
      ? { tool_calls: [{ index: 0, id: 'present-fixtures', type: 'function', function: { name: 'lexora_output_present', arguments: JSON.stringify({ paths: ['report.md', 'data.csv', 'code.ts', 'image.png', 'unsupported.pdf'] }) } }] }
      : { content: 'Fixture reply.' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: publishing ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { app, page, diagnostics } = await instance.launch()
    // Synthetic credentials only, inside the isolated Test profile. No user keys or remote model calls.
    await app.evaluate(({ app, safeStorage }) => {
      if (app.getName() !== 'Lexora Buddy Test')
        throw new Error('Synthetic credentials require the Test profile')
      Object.defineProperties(safeStorage, {
        isEncryptionAvailable: { configurable: true, value: () => true },
        getSelectedStorageBackend: { configurable: true, value: () => 'offline-fixture' },
        encryptString: { configurable: true, value: value => Buffer.from(`offline-fixture:${value}`) },
        decryptString: { configurable: true, value: (value) => {
          const text = value.toString('utf8')
          if (!text.startsWith('offline-fixture:'))
            throw new Error('Unexpected test credential')
          return text.slice('offline-fixture:'.length)
        } },
      })
    })
    await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ desktop: { contextPanelMode: 'task' } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'artifact-fixture', displayName: 'Artifact fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'artifact-fixture', name: 'Artifact fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'artifact-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('artifact-fixture', 'api_key')
      }
      finally {
        stop()
      }
      await providers.setDefaultModel({ providerId: 'artifact-fixture', modelId: 'artifact-fixture', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await app.evaluate(({ dialog, BrowserWindow }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
      globalThis.artifactSelectionCopies = 0
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.copy = () => globalThis.artifactSelectionCopies += 1
    }, directory)
    await page.reload()
    const section = page.locator('.desktop-task-sidebar__spaces')
    await expect(page.locator('.desktop-workbench-area__tasks .tiptap:visible')).toBeVisible()
    await section.locator('.desktop-task-sidebar__section-add').dispatchEvent('click')
    const dialog = page.locator('.desktop-space-dialog')
    await dialog.getByPlaceholder('输入空间名称').fill('产出引用验收')
    await dialog.getByRole('button', { name: '选择目录', exact: true }).click()
    await dialog.getByRole('button', { name: '确定', exact: true }).click()
    await expect(dialog).toBeHidden()
    const inputs = page.locator('.desktop-workbench-area__tasks .tiptap:visible')
    const firstInput = inputs.first()
    await firstInput.fill('Publish the prepared fixture outputs.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => completedRuns(instance.home)).toBe(1)
    const outputs = page.locator('.buddy-artifact-collection__item')
    await expect(outputs).toHaveCount(5)
    await firstInput.fill('Keep my latest artifact question.')
    const surface = page.locator('.desktop-artifact-context-surface')
    const menu = page.locator('.resource-selection-menu.n-dropdown:visible').first()
    const cards = page.locator('.desktop-chat-composer-wrap .resource-quote-card')
    async function open(name) {
      await outputs.filter({ has: page.locator(`.buddy-artifact-collection__name:text-is("${name}")`) }).click()
      await expect(surface).toBeVisible()
    }
    async function selectParagraph() {
      const paragraph = surface.locator('.desktop-document-content__markdown p').filter({ hasText: 'Frozen artifact paragraph.' })
      await expect(paragraph).toBeVisible()
      await paragraph.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        window.getSelection().removeAllRanges()
        window.getSelection().addRange(range)
      })
      await paragraph.click({ button: 'right' })
      await expect(menu).toBeVisible()
    }
    async function selectSource(text) {
      const editor = surface.locator('.desktop-monaco-file')
      await expect(editor.locator('.view-lines')).toContainText(text)
      const content = editor.locator('.monaco-scrollable-element').first()
      await content.click({ position: { x: 100, y: 12 } })
      await page.keyboard.press('Control+Home')
      await page.keyboard.press('Shift+End')
      await content.click({ button: 'right', position: { x: 100, y: 12 } })
      await expect(menu).toBeVisible()
    }
    await open('report.md')
    await selectParagraph()
    await menu.getByRole('menuitem', { name: '引用到对话', exact: true }).click()
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('本轮产出 · report.md')
    await expect(firstInput).toHaveText('Keep my latest artifact question.')
    expect(completedRuns(instance.home)).toBe(1)
    await selectParagraph()
    await menu.getByRole('menuitem', { name: '引用到对话', exact: true }).click()
    await expect(cards).toHaveCount(1)
    await expect(page.locator('.n-message')).toHaveCount(0)
    await cards.first().locator('.resource-quote-card__preview').click()
    await expect(page.locator('.resource-quote-preview:visible pre')).toHaveText('Frozen artifact paragraph.')
    await page.getByRole('button', { name: '定位来源', exact: true }).click()
    await expect(surface).toBeVisible()
    await page.keyboard.press('Escape')
    await surface.getByTestId('document-mode-source').click()
    await selectSource('# Artifact report')
    await menu.getByRole('menuitem', { name: '引用到对话', exact: true }).click()
    await expect(cards).toHaveCount(2)
    await expect(cards.last()).toContainText('L1–1')
    await open('data.csv')
    await selectSource('item,budget,actual')
    await menu.getByRole('menuitem', { name: '引用到对话', exact: true }).click()
    await expect(cards).toHaveCount(3)
    await open('unsupported.pdf')
    await expect(surface).toContainText('暂不支持在此预览该文件')
    await expect(surface.locator('.desktop-document-content')).toHaveCount(0)
    await open('image.png')
    await expect(surface.locator('img')).toBeVisible()
    await expect(surface.locator('.desktop-document-content')).toHaveCount(0)
    await open('code.ts')
    await selectSource('export const answer = 42')
    await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toHaveCount(1)
    await menu.getByRole('menuitem', { name: '复制', exact: true }).click()
    await expect.poll(() => app.evaluate(() => globalThis.artifactSelectionCopies)).toBe(1)
    await expect(cards).toHaveCount(3)
    await firstInput.click()
    await page.keyboard.press('Control+\\')
    await expect(inputs).toHaveCount(2)
    await inputs.nth(1).fill('Explain the frozen artifact code.')
    await firstInput.click()
    await selectSource('export const answer = 42')
    await menu.getByRole('menuitem', { name: '引用到其他对话', exact: true }).hover()
    const child = page.locator('.resource-selection-menu.n-dropdown:visible').filter({ has: page.locator('.resource-selection-menu-option__label').filter({ hasText: /^分屏 2/ }) }).last()
    await child.getByRole('menuitem', { name: /^分屏 2/ }).click()
    await expect(cards).toHaveCount(4)
    await expect(inputs.nth(1)).toHaveText('Explain the frozen artifact code.')
    await expect(firstInput).toHaveText('Keep my latest artifact question.')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'artifact-reference-split.png'), animations: 'disabled' })
    await fs.writeFile(path.join(directory, 'code.ts'), 'export const answer = 999\n')
    await inputs.nth(1).click()
    await page.locator('.desktop-workbench-area__tasks .desktop-task-editor').last().getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => completedRuns(instance.home)).toBe(2)
    const sent = JSON.stringify(requests.at(-1).messages)
    expect(sent).toContain('export const answer = 42')
    expect(sent).not.toContain('export const answer = 999')
    const userMessage = requests.at(-1).messages.findLast(message => message.role === 'user')
    const userText = typeof userMessage.content === 'string' ? userMessage.content : userMessage.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(userText).toContain('"title":"code.ts"')
    expect(userText).toContain('"format":"source"')
    for (const field of ['kind', 'artifactId', 'conversationId', 'runId', 'updatedAt', 'spaceId', 'directoryId', 'revision', 'id', 'textOffset'])
      expect(userText).not.toContain(`"${field}":`)
    expect(sent).toContain('not access grants')
    await expect(cards).toHaveCount(3)
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'artifact-reference-after-send.png'), animations: 'disabled' })
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

function completedRuns(home) {
  const database = new DatabaseSync(path.join(home, 'buddy/buddy.sqlite3'), { readOnly: true })
  try {
    return database.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count
  }
  finally {
    database.close()
  }
}

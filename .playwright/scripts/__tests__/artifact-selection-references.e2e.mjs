import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withArtifactPreview } from '../fixtures/artifact-preview.mjs'
import { expect, test } from '../fixtures/electron.mjs'

test('built-in artifact previews quote Markdown and source text to one selected draft and send frozen content', async ({ buddy }) => {
  await withArtifactPreview(buddy, {
    label: 'artifact-selection',
    async prepare(directory) {
      await fs.writeFile(path.join(directory, 'report.md'), '# Artifact report\n\nFrozen artifact paragraph.\n')
      await fs.writeFile(path.join(directory, 'code.ts'), 'export const answer = 42\n')
      return ['report.md', 'code.ts']
    },
  }, async ({ page, directory, outputs, instance, requests }) => {
    await expect.poll(() => completedRuns(instance.home)).toBe(1)
    const inputs = page.locator('.desktop-workbench-area__tasks .tiptap:visible')
    const firstInput = inputs.first()
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
    async function selectSource(text, invoke = true) {
      const editor = surface.locator('.desktop-monaco-file')
      await expect(editor.locator('.view-lines')).toContainText(text)
      const content = editor.locator('.monaco-scrollable-element').first()
      await content.click({ position: { x: 100, y: 12 } })
      await page.keyboard.press('Control+Home')
      await page.keyboard.press('Shift+End')
      await content.click({ button: 'right', position: { x: 100, y: 12 } })
      if (invoke)
        await page.getByRole('menuitem', { name: '引用', exact: true }).click({ delay: 120 })
    }
    await open('report.md')
    await selectParagraph()
    await menu.getByRole('menuitem', { name: '引用', exact: true }).click()
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('本轮产出 · report.md')
    await expect(firstInput).toContainText('Keep my latest artifact question.')
    expect(completedRuns(instance.home)).toBe(1)
    await selectParagraph()
    await menu.getByRole('menuitem', { name: '引用', exact: true }).click()
    await expect(cards).toHaveCount(1)
    await expect(page.locator('.n-message')).toHaveCount(0)
    await cards.first().locator('.chat-reference-card__link').click()
    await expect(page.locator('.resource-quote-preview:visible pre')).toHaveText('Frozen artifact paragraph.')
    await page.getByRole('button', { name: '定位来源', exact: true }).click()
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('buddy-resource-quote')?.size ?? 0)).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await surface.getByTestId('document-mode-source').click()
    await selectSource('# Artifact report')
    await expect(menu).toBeHidden()
    await expect(cards).toHaveCount(2)
    await expect(cards.last()).toContainText('L1–1')
    await open('code.ts')
    await selectSource('export const answer = 42', false)
    await page.keyboard.press('Escape')
    await expect(cards).toHaveCount(2)
    await firstInput.click()
    await page.keyboard.press('Control+\\')
    await expect(inputs).toHaveCount(2)
    await inputs.nth(1).fill('Explain the frozen artifact code.')
    await firstInput.click()
    await selectSource('export const answer = 42')
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: '引用到其他对话', exact: true }).hover()
    const child = page.locator('.resource-selection-menu.n-dropdown:visible').filter({ has: page.locator('.resource-selection-menu-option__label').filter({ hasText: /^分屏 2/ }) }).last()
    await child.getByRole('menuitem', { name: /^分屏 2/ }).click()
    await expect(cards).toHaveCount(3)
    await expect(inputs.nth(1)).toContainText('Explain the frozen artifact code.')
    await expect(firstInput).toContainText('Keep my latest artifact question.')
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
    await expect(cards).toHaveCount(2)
  })
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

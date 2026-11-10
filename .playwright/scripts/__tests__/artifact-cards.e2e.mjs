import fs from 'node:fs/promises'
import path from 'node:path'
import { withArtifactPreview } from '../fixtures/artifact-preview.mjs'
import { expect, test } from '../fixtures/electron.mjs'

test('delivered files outside bound directories remain viewable and recover from missing files', async ({ buddy }) => {
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><path fill="#37a" d="M0 0h160v100H0z"/></svg>'
  await withArtifactPreview(buddy, {
    label: 'independent-artifact-access',
    bindDirectory: false,
    async prepare(directory) {
      await fs.writeFile(path.join(directory, 'delivered.svg'), image)
      await fs.writeFile(path.join(directory, 'report.txt'), 'Delivered without a directory binding')
      return ['delivered.svg', 'report.txt']
    },
  }, async ({ app, page, directory, output }) => {
    const card = output('delivered.svg')
    const surface = page.locator('.desktop-artifact-context-surface:visible')
    await card.click()
    const preview = surface.locator('img[alt="delivered.svg"]')
    await expect.poll(() => preview.evaluate(element => element.naturalWidth)).toBe(160)
    await app.evaluate(({ shell }) => {
      shell.showItemInFolder = (target) => {
        globalThis.artifactRevealedPath = target
      }
    })
    await card.hover()
    await card.locator('.buddy-artifact-collection__more').click()
    await page.locator('.n-dropdown-menu:visible').getByText('打开所在文件夹', { exact: true }).click()
    await expect.poll(() => app.evaluate(() => globalThis.artifactRevealedPath)).toBe(path.join(directory, 'delivered.svg'))
    await output('report.txt').click()
    await expect(surface).toContainText('Delivered without a directory binding')
    await fs.rm(path.join(directory, 'delivered.svg'))
    await card.click()
    await expect(surface).toContainText('文件已被移动或删除')
    await fs.writeFile(path.join(directory, 'delivered.svg'), image)
    await surface.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => preview.evaluate(element => element.naturalWidth)).toBe(160)
  })
})

test('turn outputs scroll horizontally and keep hover and keyboard actions accessible', async ({ buddy }) => {
  await withArtifactPreview(buddy, {
    label: 'artifact-cards',
    async prepare(directory) {
      const names = ['report.ts', 'summary.ts', 'notes.ts', 'results.ts']
      for (const name of names)
        await fs.writeFile(path.join(directory, name), 'export const enabled = true\n')
      return names
    },
  }, async ({ app, page, outputs }) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    const section = page.getByTestId('chat-turn-outputs')
    const toggle = section.getByRole('button', { name: '本轮产出 4', exact: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const first = outputs.first()
    const actionGroup = first.locator('.buddy-artifact-collection__actions')
    await toggle.focus()
    await toggle.hover()
    await expect(actionGroup).toHaveCSS('opacity', '0')
    await first.hover()
    await expect(actionGroup).toHaveCSS('opacity', '1')
    await toggle.hover()
    await page.keyboard.press('Tab')
    await expect(first.locator('.buddy-artifact-collection__trigger')).toBeFocused()
    await expect(actionGroup).toHaveCSS('opacity', '1')
    await page.keyboard.press('Tab')
    await expect(first.locator('.buddy-artifact-collection__open')).toBeFocused()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(page.locator('.n-dropdown-menu:visible')).toBeVisible()
    await page.locator('.n-dropdown-menu:visible').hover()
    await expect(actionGroup).toHaveCSS('opacity', '1')
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)

    const scrollport = section.locator('.n-scrollbar-container')
    await first.hover()
    await page.mouse.wheel(0, 180)
    await expect.poll(() => scrollport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(outputs).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(outputs).toHaveCount(4)

    await first.getByRole('button', { name: 'report.ts', exact: true }).click()
    await expect(page.locator('.desktop-artifact-context-surface:visible')).toContainText('export const enabled = true')
  })
})

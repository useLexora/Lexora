import fs from 'node:fs/promises'
import path from 'node:path'
import { withArtifactPreview } from '../fixtures/artifact-preview.mjs'
import { expect, test } from '../fixtures/electron.mjs'

test('turn outputs scroll horizontally and keep hover and keyboard actions accessible', async ({ buddy }) => {
  await withArtifactPreview(buddy, {
    label: 'artifact-cards',
    async prepare(directory) {
      const names = ['OpenAiImageGenerationService.ts', 'imageGenerationExtension.ts', 'ProviderService.ts']
      for (const name of names)
        await fs.writeFile(path.join(directory, name), 'export const enabled = true\n')
      await fs.writeFile(path.join(directory, 'thumbnail.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><path fill="#37a" d="M0 0h160v100H0z"/></svg>')
      return [...names, 'thumbnail.svg']
    },
  }, async ({ app, page, outputs }) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    const section = page.getByTestId('chat-turn-outputs')
    const toggle = section.getByRole('button', { name: '本轮产出 4', exact: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const bodyId = await toggle.getAttribute('aria-controls')
    await expect(page.locator(`[id="${bodyId}"]`)).toBeVisible()
    const first = outputs.first()
    const actionGroup = first.locator('.buddy-artifact-collection__actions')
    await toggle.focus()
    await toggle.hover()
    await expect(actionGroup).toHaveCSS('opacity', '0')
    await expect(actionGroup).toHaveCSS('pointer-events', 'none')
    await first.hover()
    await expect(actionGroup).toHaveCSS('opacity', '1')
    await toggle.hover()
    await expect(actionGroup).toHaveCSS('opacity', '0')
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
    await toggle.focus()
    await expect(actionGroup).toHaveCSS('opacity', '0')

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
    await expect(page.locator(`[id="${bodyId}"]`)).toBeVisible()

    const imageCard = outputs.filter({ hasText: 'thumbnail.svg' })
    const image = imageCard.locator('.buddy-artifact-collection__image')
    await image.scrollIntoViewIfNeeded()
    await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(160)
    await image.evaluate(element => element.dispatchEvent(new Event('error')))
    await expect(imageCard.locator('.buddy-file-icon')).toBeVisible()

    await first.getByRole('button', { name: 'OpenAiImageGenerationService.ts', exact: true }).click()
    await expect(page.locator('.desktop-artifact-context-surface:visible')).toContainText('export const enabled = true')
  })
})

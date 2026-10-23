import fs from 'node:fs/promises'
import path from 'node:path'
import { silentWave, withArtifactPreview } from '../fixtures/artifact-preview.mjs'
import { expect, test } from '../fixtures/electron.mjs'

async function verifyAudioPlayback(surface) {
  const player = surface.locator('audio')
  await expect(player).toBeVisible()
  await expect(surface.locator('video')).toHaveCount(0)
  await expect.poll(() => player.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2)
  expect(await player.evaluate(element => element.duration)).toBeCloseTo(1, 1)
  expect(await player.evaluate(element => element.paused)).toBe(true)
  await player.evaluate(element => element.play())
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1)
  await player.evaluate((element) => {
    element.pause()
    element.currentTime = 0.6
  })
  await expect.poll(() => player.evaluate(element => !element.seeking && Math.abs(element.currentTime - 0.6) < 0.05)).toBe(true)
  await player.evaluate(element => element.play())
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.7)
  await player.evaluate(element => element.pause())
  expect(await player.evaluate(element => element.error)).toBeNull()
}

test('artifact actions preserve context and share audio playback and recovery with the file explorer', async ({ buddy }) => {
  const filename = 'sample 音频.wav'
  await withArtifactPreview(buddy, {
    label: 'artifact-media',
    async prepare(directory) {
      await fs.writeFile(path.join(directory, filename), silentWave(1))
      await fs.writeFile(path.join(directory, 'unsupported.wav'), 'Not playable audio')
      await fs.mkdir(path.join(directory, 'bundle'))
      await fs.writeFile(path.join(directory, 'bundle', 'report.md'), '# Delivered directory\n')
      return [filename, 'unsupported.wav', 'bundle']
    },
  }, async ({ app, page, directory, output }) => {
    const card = output(filename)
    const surface = page.locator('.desktop-artifact-context-surface:visible')
    await card.hover()
    await card.locator('.buddy-artifact-collection__open').click()
    await verifyAudioPlayback(surface)
    async function menu(target = card) {
      await page.mouse.move(0, 0)
      await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)
      await target.hover()
      await target.locator('.buddy-artifact-collection__more').click()
      await expect(target.locator('.buddy-artifact-collection__more')).toHaveAttribute('aria-expanded', 'true')
      const popup = page.locator('.n-dropdown-menu:visible')
      await expect(popup).toBeVisible()
      return popup
    }
    await (await menu()).getByText('复制路径', { exact: true }).click()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(path.join(directory, filename))
    await (await menu()).getByText('引用', { exact: true }).click()
    await expect(page.locator('.desktop-chat-composer-wrap:visible')).toContainText(filename)

    const player = surface.locator('audio')
    const previousPlayer = await player.elementHandle()
    await player.evaluate((element) => {
      element.currentTime = 0
      element.loop = true
      return element.play()
    })
    expect(await player.evaluate(element => element.paused)).toBe(false)
    await (await menu()).getByText('在文件中定位', { exact: true }).click()
    await expect.poll(() => previousPlayer.evaluate(element => element.paused)).toBe(true)
    await previousPlayer.dispose()
    const tree = page.getByTestId('context-file-tree')
    await expect(tree.locator(`[data-path="${filename}"]`)).toBeVisible()
    const filePlayer = page.locator('.file-preview:visible audio')
    await expect(filePlayer).toBeVisible()
    await expect.poll(() => filePlayer.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2)
    expect(await filePlayer.evaluate(element => element.paused)).toBe(true)

    await output('unsupported.wav').click()
    await expect(surface.getByRole('alert')).toContainText('无法播放此文件')
    await fs.writeFile(path.join(directory, 'unsupported.wav'), silentWave(2))
    await surface.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => surface.locator('audio').evaluate(element => element.duration)).toBe(2)
    await page.getByTestId('task-context-panel').getByRole('tab', { name: '文件', exact: true }).click()
    await page.getByRole('button', { name: '收起目录树', exact: true }).click()
    await expect(tree).toBeHidden()
    await (await menu(output('bundle'))).getByText('在文件中定位', { exact: true }).click()
    await expect(tree.locator('[data-path="bundle/report.md"]')).toBeVisible()
    await expect(page.locator('.file-preview:visible')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveCount(1)
  })
})

test('artifact menus expose disabled reasons to pointer and keyboard users without executing the action', async ({ buddy }) => {
  await withArtifactPreview(buddy, {
    label: 'artifact-disabled-menu',
    async prepare(directory) {
      await fs.writeFile(path.join(directory, 'thumbnail.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><path fill="#fff" d="M0 0h160v100H0z"/><path fill="#ffe383" d="M0 0h80v100H0z"/><path fill="#202020" d="M80 0h80v50H80z"/></svg>')
      return ['thumbnail.svg']
    },
  }, async ({ page, output }) => {
    const card = output('thumbnail.svg')
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
    await page.evaluate(async () => {
      const spaces = window.lexoraDesktop.localChat.spaces
      const space = (await spaces.list()).find(space => space.name === '文件产物验收')
      await spaces.update({ spaceId: space.id, name: space.name, memoryScope: space.memoryScope, primaryDirectory: null })
    })
    await card.hover()
    await card.locator('.buddy-artifact-collection__more').click()
    const menu = page.locator('.n-dropdown-menu:visible')
    const hint = menu.getByRole('group', { name: '在文件中定位', exact: true })
    await expect(hint).toHaveAttribute('aria-disabled', 'true')
    await expect(menu.getByText('此产物不在当前对话已绑定的有效目录中', { exact: true })).toHaveCount(0)
    await hint.hover()
    const tooltip = page.locator('.n-tooltip:visible')
    await expect(tooltip).toContainText('此产物不在当前对话已绑定的有效目录中')
    await page.mouse.move(0, 0)
    await expect(tooltip).toBeHidden()
    await hint.focus()
    await expect(tooltip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(tooltip).toBeHidden()
  })
})

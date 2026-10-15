import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect } from '../fixtures/electron.mjs'

const { zipSync } = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))('fflate')

export const fileIconChoices = {
  'file': ['file'],
  'folder': ['folder'],
  'folder-open': ['folderExpanded'],
  'typescript': ['fileExtensions', 'ts'],
  'src': ['folderNames', 'src'],
  'src-open': ['folderNamesExpanded', 'src'],
}

export async function writeFileIconPlugin(directory, assets = {}) {
  const id = 'tests.file-icons'
  const files = { ...assets }
  const document = { iconDefinitions: {} }
  for (const [flavour, variant] of [['mocha', document], ['latte', document.light = {}]]) {
    for (const [name, [group, key]] of Object.entries(fileIconChoices)) {
      const icon = `${flavour}-${name}`
      const asset = `icons/${icon}.svg`
      files[asset] ??= Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="${flavour === 'mocha' ? '#cba6f7' : '#8839ef'}" d="M2 2h12v12H2z"/></svg>`)
      document.iconDefinitions[icon] = { iconPath: `../${asset}` }
      if (key)
        (variant[group] ??= {})[key] = icon
      else
        variant[group] = icon
    }
  }
  const label = 'Fixture Icons'
  files['extension.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, id, name: label, version: '1.0.0', apiVersion: 3, engines: { lexora: '*' }, contributes: { iconThemes: [{ id: `${id}.palette`, label, path: 'themes/icons.json' }] } }))
  files['themes/icons.json'] = Buffer.from(JSON.stringify(document))
  const archive = `${directory}.lexora-extension`
  await fs.mkdir(path.dirname(archive), { recursive: true })
  await fs.writeFile(archive, zipSync(files, { level: 6 }))
  return { id, label, archive }
}

export async function exerciseFileIconPlugin(buddy, testInfo, plugin) {
  const instance = await buddy.createInstance('file-icons')
  await testInfo.attach('icon-plugin', { path: plugin.archive, contentType: 'application/zip' })
  const directory = path.join(instance.home, 'documents')
  await fs.mkdir(path.join(directory, 'src'), { recursive: true })
  await fs.writeFile(path.join(directory, 'src/main.ts'), 'Icon fixture\n')
  let { app, page } = await instance.launch()
  const row = name => page.getByTestId('context-file-tree').locator(`[data-path="${name}"]`)
  async function icon(name, expected) {
    const image = row(name).locator('img')
    await expect(image).toHaveAttribute('src', new RegExp(`/${expected}$`))
    await expect.poll(() => image.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
  }
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] })
  }, plugin.archive)
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-install').click()
  await page.getByTestId('extension-confirm-install').click()
  await expect(page.getByTestId('extension-confirm-install')).toBeHidden()
  await page.evaluate(() => window.location.hash = '/settings/appearance')
  await page.getByTestId('desktop-file-icon-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: plugin.label }).click()
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { contextPanelMode: 'independent', theme: { id: 'lexora.themes.classic-light' } } }))
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, directory)
  const section = page.locator('.desktop-task-sidebar__spaces')
  await section.locator('.desktop-task-sidebar__section-heading').hover()
  await section.locator('.desktop-task-sidebar__section-add').click()
  const dialog = page.locator('.desktop-space-dialog')
  await dialog.getByPlaceholder('输入空间名称').fill('图标验收')
  await dialog.getByRole('button', { name: '选择目录', exact: true }).click()
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await expect(dialog).toBeHidden()
  const toggle = page.getByTestId('context-panel-toggle')
  if (await toggle.getAttribute('aria-expanded') === 'false')
    await toggle.click()
  await page.getByTestId('task-context-open-files').click()
  await page.getByTestId('file-space-picker').getByRole('button', { name: /图标验收/ }).click()
  await icon('src', 'latte-src')
  await row('src').click()
  await icon('src', 'latte-src-open')
  await icon('src/main.ts', 'latte-typescript')
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: { id: 'lexora.themes.classic-dark' } } }))
  await icon('src/main.ts', 'mocha-typescript')
  await instance.stop()
  ;({ app, page } = await instance.launch())
  if (await page.getByTestId('context-panel-toggle').getAttribute('aria-expanded') === 'false')
    await page.getByTestId('context-panel-toggle').click()
  await row('src').click()
  await icon('src/main.ts', 'mocha-typescript')
  await page.screenshot({ path: testInfo.outputPath('file-icon-plugin.png') })
  const oldUrl = await row('src/main.ts').locator('img').getAttribute('src')
  await page.evaluate(id => window.lexoraDesktop.extensions.uninstall(id), plugin.id)
  const fallback = row('src/main.ts').locator('img')
  await expect(fallback).not.toHaveAttribute('src', /^lexora-icon:/)
  await expect.poll(() => fallback.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
  expect(await app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, oldUrl)).toBe(404)
}

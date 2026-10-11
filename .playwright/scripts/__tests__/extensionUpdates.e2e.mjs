import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

const { strToU8, zipSync } = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))('fflate/node')
const id = 'tests.updates'
const themeId = `${id}.theme`

async function writePackage(directory, version, accent) {
  const manifest = {
    schemaVersion: 1,
    id,
    name: '更新验收插件',
    description: '验证更新生效与配置保留。',
    version,
    apiVersion: 3,
    engines: { lexora: '*' },
    contributes: {
      themes: [{ id: themeId, label: '更新验收主题', appearance: 'light', path: 'theme.json' }],
      settings: { items: [{ id: `${id}.preference`, key: 'preference', group: 'settings.general.general', type: 'string', title: 'Preference', default: '' }] },
    },
  }
  const file = path.join(directory, `plugin-${version}.lexora-extension`)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(file, zipSync({ 'extension.json': strToU8(JSON.stringify(manifest)), 'theme.json': strToU8(JSON.stringify({ schemaVersion: 1, colors: { accent } })) }))
  return file
}

test('plugin updates apply separately from restart and preserve preferences and disabled state', async ({ buddy }) => {
  const instance = await buddy.createInstance('plugin-updates')
  let { app, page, diagnostics } = await instance.launch()
  const directory = path.join(instance.home, 'fixtures')
  const status = () => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id), id)
  const card = () => page.locator(`[data-extension-id="${id}"]`)
  async function install(version, accent, apply = true) {
    const file = await writePackage(directory, version, accent)
    await page.evaluate(() => window.location.hash = '/extensions')
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await page.getByTestId('extension-install-options').click()
    await page.getByTestId('extension-install').click()
    if (version !== '1.0.0') {
      const checkbox = page.getByRole('checkbox', { name: '安装完成后立即应用更新' })
      await expect(checkbox).toBeChecked()
      await checkbox.setChecked(apply)
      await expect(page.getByTestId('extension-confirm-install')).toHaveText(apply ? '更新并应用' : '安装更新')
    }
    await page.getByTestId('extension-confirm-install').click()
    await expect.poll(status).toMatchObject(apply ? { manifest: { version }, pending: null } : { pending: { manifest: { version } } })
  }
  await install('1.0.0', '#506a8f')
  await page.evaluate(async ({ id, themeId }) => {
    await window.lexoraDesktop.extensions.configure(id, { preference: 'retain-this-value' })
    await window.lexoraDesktop.themes.request({ action: 'preference', preference: { id: themeId } })
  }, { id, themeId })
  await install('1.0.1', '#28785a')
  await expect.poll(() => page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'active' }))).toMatchObject({ preference: { id: themeId }, active: { colors: { accent: '#28785a' } } })
  expect(await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), id)).toEqual({ preference: 'retain-this-value' })
  await install('1.0.2', '#7654a4', false)
  await expect(card().getByTestId('extension-apply-update')).toBeVisible()
  await expect(card()).toContainText('新版本已就绪')
  await card().getByTestId('extension-card-more').click()
  await expect(page.getByTestId('extension-apply-update-menu')).toHaveText('应用更新')
  await expect(page.getByTestId('extension-restart')).toHaveText('重启插件')
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'update-and-restart-menu.png'), animations: 'disabled' })
  await page.getByTestId('extension-restart').click()
  await expect(card().getByTestId('extension-apply-update')).toBeEnabled()
  expect(await status()).toMatchObject({ manifest: { version: '1.0.1' }, pending: { manifest: { version: '1.0.2' } } })
  expect((await page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'active' }))).active.colors.accent).toBe('#28785a')
  await card().getByTestId('extension-apply-update').click()
  await expect.poll(status).toMatchObject({ manifest: { version: '1.0.2' }, pending: null })
  await expect.poll(() => page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'active' }))).toMatchObject({ active: { colors: { accent: '#7654a4' } } })
  await page.evaluate(id => window.lexoraDesktop.extensions.enable(id, false), id)
  await install('1.0.3', '#a84d70')
  expect(await status()).toMatchObject({ enabled: false, state: 'disabled' })
  expect(await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), id)).toEqual({ preference: 'retain-this-value' })
  await install('1.0.4', '#946126', false)
  const manifest = (await status()).pending.manifest
  await fs.writeFile(path.join(instance.home, 'buddy', 'extensions', 'catalog.json'), JSON.stringify({
    cachedAt: new Date().toISOString(),
    catalog: { schemaVersion: 1, plugins: [{ manifest, repository: 'https://example.test/plugins', artifact: { url: 'https://example.test/plugin.zip', sha256: '1'.repeat(64), size: 1 } }] },
  }))
  await page.getByRole('button', { name: '插件市场', exact: true }).click()
  await expect(page.getByTestId('catalog-apply-update')).toBeVisible()
  await page.getByTestId('catalog-apply-update').click()
  await expect.poll(status).toMatchObject({ manifest: { version: '1.0.4' }, pending: null, enabled: false })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  await instance.stop()
  ;({ app, page, diagnostics } = await instance.launch())
  expect(await status()).toMatchObject({ manifest: { version: '1.0.4' }, pending: null, enabled: false })
  expect(await page.evaluate(id => window.lexoraDesktop.extensions.configuration(id), id)).toEqual({ preference: 'retain-this-value' })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

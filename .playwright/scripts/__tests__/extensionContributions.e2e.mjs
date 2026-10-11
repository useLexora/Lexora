import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'
import { writeContributionPlugin } from './extensionContributions.mjs'

test('plugin-owned preferences activate contributions, yield native content and restore across restart', async ({ buddy }) => {
  const instance = await buddy.createInstance('plugin-contributions')
  let { app, page, diagnostics } = await instance.launch()
  const navigate = async name => page.locator('.desktop-app-sidebar').getByRole('button', { name, exact: true }).click()
  const nativeFooter = () => page.locator('.desktop-chat-composer__disclaimer')
  const pluginFrame = async (name, file) => {
    let result
    await expect.poll(async () => {
      for (const candidate of page.frames()) {
        if (await candidate.locator(`[data-contribution-fixture="tests.${name}.${file}"]`).count().catch(() => 0)) {
          result = candidate
          return true
        }
      }
      return false
    }).toBe(true)
    return result
  }
  const visible = async name => (await pluginFrame(name, 'footer')).evaluate(() => window.fixture.visible)
  async function install(name) {
    const directory = path.join(instance.home, 'fixtures', name)
    const id = await writeContributionPlugin(directory, name, { uno: name === 'alpha' })
    await navigate('插件')
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, directory)
    await page.getByTestId('extension-install-options').click()
    await page.getByTestId('extension-development').click()
    await page.getByTestId('extension-confirm-install').click()
    await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).some(item => item.manifest.id === id), id)).toBe(true)
  }
  async function preference(name, enabled) {
    await navigate(`Settings ${name}`)
    const settings = await pluginFrame(name, 'settings')
    await settings.getByRole('checkbox', { name: 'Enable footer' }).setChecked(enabled)
    await expect(settings.getByRole('status')).toHaveText(enabled ? 'Enabled' : 'Disabled')
    await navigate('任务')
  }
  await install('alpha')
  await navigate('任务')
  await expect(nativeFooter()).toBeVisible()
  await preference('alpha', true)
  const alpha = await pluginFrame('alpha', 'footer')
  await expect(alpha.getByText('tests.alpha content')).toBeVisible()
  await expect.poll(() => alpha.evaluate(() => window.fixture.theme?.view.accent)).toBe('#96304d')
  const sdkTheme = await alpha.evaluate(() => window.fixture.theme)
  expect(sdkTheme.host.accent).toBe('#207cba')
  expect(sdkTheme.view.id).toMatch(/^user\.theme\./)
  expect(sdkTheme.host.id).toMatch(/^user\.theme\./)
  expect(await page.evaluate(async () => (await window.lexoraDesktop.themes.request({ action: 'list' })).filter(theme => theme.source === 'user').map(theme => theme.label))).toEqual(['View SDK theme', 'Host SDK theme'])
  await expect(nativeFooter()).toHaveCount(0)
  const identity = await alpha.evaluate(() => window.fixture.instance)
  const hostColor = name => page.evaluate((name) => {
    const style = document.createElement('span').style
    style.color = getComputedStyle(document.documentElement).getPropertyValue(`--buddy-${name}`)
    return style.color
  }, name)
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: { id: 'lexora.themes.violet-dark' } } }))
  await expect(page.locator('html')).toHaveAttribute('data-buddy-theme-id', 'lexora.themes.violet-dark')
  await expect.poll(() => alpha.evaluate(() => getComputedStyle(document.querySelector('main')).backgroundColor)).toBe(await hostColor('accent-solid'))
  expect(await alpha.evaluate(() => window.fixture.instance)).toBe(identity)
  await page.getByTestId('context-panel-toggle').click()
  await page.getByTestId('context-panel-swap').click()
  await page.getByTestId('context-panel-maximize').click()
  await expect.poll(() => visible('alpha')).toBe(false)
  await page.getByTestId('context-panel-maximize').click()
  await expect.poll(() => visible('alpha')).toBe(true)
  expect(await alpha.evaluate(() => window.fixture.instance)).toBe(identity)
  await page.getByTestId('context-panel-swap').click()
  await page.getByTestId('context-panel-toggle').click()
  const alphaActions = await pluginFrame('alpha', 'actions')
  const actionFrame = await alphaActions.frameElement()
  await actionFrame.waitForElementState('stable')
  await actionFrame.dispose()
  await alphaActions.getByRole('checkbox', { name: 'Content tests.alpha' }).uncheck()
  await expect(nativeFooter()).toBeVisible()
  await alphaActions.getByRole('checkbox', { name: 'Content tests.alpha' }).check()
  await expect(alpha.getByText('tests.alpha content')).toBeVisible()
  expect(await alpha.evaluate(() => window.fixture.instance)).toBe(identity)
  await install('beta')
  await preference('beta', true)
  await expect.poll(() => visible('alpha')).toBe(true)
  await expect.poll(() => visible('beta')).toBe(false)
  await preference('alpha', false)
  await expect.poll(() => visible('beta')).toBe(true)
  await expect(nativeFooter()).toHaveCount(0)
  await preference('alpha', true)
  await expect.poll(() => visible('alpha')).toBe(true)
  await expect.poll(() => visible('beta')).toBe(false)

  await instance.stop()
  ;({ app, page, diagnostics } = await instance.launch())
  await navigate('任务')
  const restoredAlpha = await pluginFrame('alpha', 'footer')
  await expect.poll(() => restoredAlpha.evaluate(() => window.fixture.visible)).toBe(true)
  await page.evaluate(() => window.lexoraDesktop.extensions.enable('tests.alpha', false))
  const restoredBeta = await pluginFrame('beta', 'footer')
  await expect.poll(() => restoredBeta.evaluate(() => window.fixture.visible)).toBe(true)
  await page.evaluate(() => window.lexoraDesktop.extensions.enable('tests.beta', false))
  await expect(nativeFooter()).toBeVisible()
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

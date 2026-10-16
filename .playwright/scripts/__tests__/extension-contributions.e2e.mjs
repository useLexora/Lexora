import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'
import { writeContributionPlugin } from '../fixtures/extension-contributions.mjs'

async function installPlugin(instance, app, page, name, options) {
  const directory = path.join(instance.home, 'fixtures', name)
  const id = await writeContributionPlugin(directory, name, options)
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, directory)
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-development').click()
  await page.getByTestId('extension-confirm-install').click()
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).some(item => item.manifest.id === id), id)).toBe(true)
  return id
}

test('plugin-owned preferences activate contributions, yield native content and restore across restart', async ({ buddy }) => {
  const instance = await buddy.createInstance('plugin-contributions')
  let { app, page } = await instance.launch()
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
  async function preference(name, enabled) {
    await navigate(`Settings ${name}`)
    const settings = await pluginFrame(name, 'settings')
    await settings.getByRole('checkbox', { name: 'Enable footer' }).setChecked(enabled)
    await expect(settings.getByRole('status')).toHaveText(enabled ? 'Enabled' : 'Disabled')
    await navigate('任务')
  }
  await installPlugin(instance, app, page, 'alpha', { uno: true })
  await navigate('任务')
  await expect(nativeFooter()).toBeVisible()
  await preference('alpha', true)
  const alpha = await pluginFrame('alpha', 'footer')
  await expect(alpha.getByText('tests.alpha content')).toBeVisible()
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
  await page.getByTestId('context-panel-toggle').click()
  await page.getByTestId('context-panel-swap').click()
  await page.getByTestId('context-panel-maximize').click()
  await expect.poll(() => visible('alpha')).toBe(false)
  await page.getByTestId('context-panel-maximize').click()
  await expect.poll(() => visible('alpha')).toBe(true)
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
  await installPlugin(instance, app, page, 'beta')
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
  ;({ app, page } = await instance.launch())
  await navigate('任务')
  const restoredAlpha = await pluginFrame('alpha', 'footer')
  await expect.poll(() => restoredAlpha.evaluate(() => window.fixture.visible)).toBe(true)
  await page.evaluate(() => window.lexoraDesktop.extensions.enable('tests.alpha', false))
  const restoredBeta = await pluginFrame('beta', 'footer')
  await expect.poll(() => restoredBeta.evaluate(() => window.fixture.visible)).toBe(true)
  await page.evaluate(() => window.lexoraDesktop.extensions.enable('tests.beta', false))
  await expect(nativeFooter()).toBeVisible()
})

test('command failures distinguish execution, malformed replies and timeouts in the real plugin host', async ({ buddy }) => {
  const instance = await buddy.createInstance('plugin-failures')
  const { app, page } = await instance.launch()
  const id = await installPlugin(instance, app, page, 'failures')
  const status = () => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id), id)
  const execute = command => page.evaluate(async ({ id, command }) => {
    try {
      await window.lexoraDesktop.extensions.execute(id, `${id}.${command}`, null)
      return null
    }
    catch (error) { return error.message }
  }, { id, command })
  expect(await execute('failure')).toContain('EXTENSION_OPERATION_FAILED')
  expect(await status()).toMatchObject({ state: 'active', error: null, logs: expect.arrayContaining([
    expect.objectContaining({ code: 'EXTENSION_OPERATION_FAILED', diagnostic: { method: 'command', stage: 'execution' } }),
  ]) })
  expect(await execute('invalid')).toContain('EXTENSION_INVALID_RESULT')
  expect(await status()).toMatchObject({ state: 'active', error: null, logs: expect.arrayContaining([
    expect.objectContaining({ code: 'EXTENSION_INVALID_RESULT', diagnostic: expect.objectContaining({ method: 'command', stage: 'result' }) }),
  ]) })
  expect(await execute('timeout')).toContain('EXTENSION_REQUEST_TIMEOUT')
  await expect.poll(status).toMatchObject({ state: 'failed', generation: null, error: 'EXTENSION_REQUEST_TIMEOUT', logs: expect.arrayContaining([
    expect.objectContaining({ event: 'host.failed', code: 'EXTENSION_REQUEST_TIMEOUT', diagnostic: { method: 'command', stage: 'timeout' } }),
  ]) })
  expect(JSON.stringify(await status())).not.toContain('Private plugin error')
})

test('streams a large download through the real host and keeps its theme image after resource release and restart', async ({ buddy }) => {
  const instance = await buddy.createInstance('plugin-media')
  const image = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="#247aaa"/><!--${'x'.repeat(8 * 1024 * 1024)}--></svg>`
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'image/svg+xml' })
    response.write(image.slice(0, 1024))
    const timer = setTimeout(() => response.end(image.slice(1024)), 16000)
    response.on('close', () => clearTimeout(timer))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    let { app, page } = await instance.launch()
    const url = `http://127.0.0.1:${server.address().port}/wallpaper.svg`
    await app.evaluate(({ net, shell }, url) => {
      const original = net.request.bind(net)
      net.request = input => original(typeof input === 'object' && input.url === 'https://media.example.com/wallpaper.svg' ? { ...input, url } : input)
      globalThis.extensionOpenedUrls = []
      shell.openExternal = async (target) => {
        globalThis.extensionOpenedUrls.push(target)
      }
    }, url)
    await installPlugin(instance, app, page, 'media', { media: true })
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: 'Settings media', exact: true }).click()
    let frame
    await expect.poll(async () => {
      for (const candidate of page.frames()) {
        if (await candidate.locator('[data-contribution-fixture="tests.media.settings"]').count().catch(() => 0)) {
          frame = candidate
          return true
        }
      }
      return false
    }).toBe(true)
    await expect(frame.getByRole('status')).toHaveText('Ready')
    await frame.getByRole('button', { name: 'Download wallpaper' }).evaluate(button => button.click())
    await expect(frame.getByRole('status')).toHaveText('Saved', { timeout: 30000 })
    const result = await frame.evaluate(() => ({ size: window.fixture.resource.size, themeId: window.fixture.themeId }))
    expect(result.size).toBe(Buffer.byteLength(image))
    await frame.getByText('Source', { exact: true }).evaluate(link => link.click())
    await expect.poll(() => app.evaluate(() => globalThis.extensionOpenedUrls)).toEqual(['https://media.example.com/source#credits'])
    const checkImage = () => page.evaluate(async () => {
      const theme = await window.lexoraDesktop.themes.request({ action: 'active' })
      const image = new Image()
      image.src = theme.active.assets['wallpaper.svg']
      await image.decode()
      return { url: image.src, width: image.naturalWidth, height: image.naturalHeight }
    })
    expect(await checkImage()).toMatchObject({ url: expect.stringMatching(/^lexora-theme:/), width: 12, height: 8 })
    await page.evaluate(() => window.lexoraDesktop.extensions.enable('tests.media', false))
    await instance.stop()
    ;({ app, page } = await instance.launch())
    expect(await checkImage()).toMatchObject({ width: 12, height: 8 })
    expect(await page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'active' }))).toMatchObject({ preference: { id: result.themeId } })
  }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

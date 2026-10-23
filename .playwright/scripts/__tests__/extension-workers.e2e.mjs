import fs from 'node:fs/promises'
import { expect, test } from '../fixtures/electron.mjs'
import { workerProbeId, writeWorkerProbe } from '../fixtures/extension-workers.mjs'

async function install(app, page, plugin) {
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { featureAnnouncementsEnabled: false } }))
  await expect(page.getByTestId('feature-discovery-reminder')).toBeHidden()
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] })
  }, plugin.archive)
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-install').click()
  const review = page.getByTestId('extension-install-review')
  await expect(review).toBeVisible()
  await review.getByTestId('extension-confirm-install').click()
  await expect(review).toBeHidden()
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id)?.enabled, plugin.id)).toBe(true)
}

function invoke(page, id, command, input = '') {
  return page.evaluate(({ id, command, input }) => window.lexoraDesktop.extensions.executeSlash(id, `${id}.${command}`, input), { id, command, input })
}

async function pluginFrame(page, selector) {
  let frame
  await expect.poll(async () => {
    for (const candidate of page.frames()) {
      if (await candidate.locator(selector).count().catch(() => 0)) {
        frame = candidate
        return true
      }
    }
    return false
  }).toBe(true)
  return frame
}

async function openProbe(page) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
  await invoke(page, workerProbeId, 'open')
  return pluginFrame(page, '[data-worker-probe]')
}

async function withPlugin(buddy, testInfo, run) {
  const plugin = await writeWorkerProbe(testInfo.outputPath('packages'))
  const instance = await buddy.createInstance('extension-workers')
  const { app, page } = await instance.launch()
  const consoleMessages = []
  const errors = []
  const requestFailures = []
  app.context().on('requestfailed', request => requestFailures.push({ url: request.url(), type: request.resourceType(), error: request.failure()?.errorText }))
  const consoleListener = message => consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() })
  app.context().on('console', consoleListener)
  app.context().on('weberror', error => errors.push(String(error.error())))
  const cdp = await app.context().newCDPSession(page)
  await cdp.send('Target.setDiscoverTargets', { discover: true })
  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'worker')
  const workerAlive = async url => (await targets()).some(target => target.url === url)
  try {
    await install(app, page, plugin)
    await run({ app, page, instance, plugin, workerAlive, consoleMessages })
  }
  finally {
    const diagnosticPath = testInfo.outputPath('worker-diagnostics.json')
    await fs.writeFile(diagnosticPath, JSON.stringify({
      versions: await app.evaluate(() => process.versions).catch(error => ({ error: String(error) })),
      plugins: await page.evaluate(() => window.lexoraDesktop.extensions.list()).catch(error => ({ error: String(error) })),
      targets: await targets().catch(error => ({ error: String(error) })),
      console: consoleMessages,
      errors,
      requestFailures,
    }, null, 2))
    await testInfo.attach('worker-diagnostics', { path: diagnosticPath, contentType: 'application/json' })
    app.context().off('console', consoleListener)
    await cdp.detach().catch(() => {})
  }
}

for (const type of ['classic', 'module']) {
  test(`native Worker with a ${type} entry preserves structured clone and transfer and aborts synchronous WASM without freezing its view`, async ({ buddy }, testInfo) => {
    await withPlugin(buddy, testInfo, async ({ page, workerAlive }) => {
      const frame = await openProbe(page)
      const result = await frame.evaluate(type => globalThis.workerFixture.run(type), type)
      expect(result).toMatchObject({
        type,
        native: true,
        detached: true,
        circular: true,
        original: [7, 11, 19, 255],
        buffer: [8, 11, 19, 255],
        evalDenied: true,
        functionDenied: true,
        node: 'undefined',
        require: 'undefined',
        desktop: 'undefined',
        directDenied: true,
        directive: 'connect-src',
      })
      if (type === 'module') {
        expect(result.dependency).toBe('package-relative-module')
        expect(result.moduleUrl).toMatch(/^lexora-extension:\/\/[^/]+\/__package\/worker-module\.js$/)
        await expect(frame.evaluate(() => globalThis.workerFixture.missing())).rejects.toThrow('Worker failed:')
      }
      else {
        expect(result.dependency).toBeNull()
        expect(result.moduleUrl).toBeNull()
      }
      expect(await frame.evaluate(() => globalThis.workerFixture.wasm())).toEqual({ binary: 42, streaming: 42, mime: 'application/wasm', valid: true })
      const busy = await frame.evaluate(type => globalThis.workerFixture.startBusy(type), type)
      expect(busy.phase).toBe('busy')
      await expect.poll(() => workerAlive(busy.url)).toBe(true)
      await frame.getByLabel('响应检查').fill('同步 WASM 忙循环时仍能输入')
      await expect(frame.getByLabel('输入响应')).toHaveText('同步 WASM 忙循环时仍能输入')
      await frame.getByRole('button', { name: '取消忙循环' }).click()
      await expect(frame.getByRole('status', { name: '', exact: true })).toHaveText('Worker 已取消，视图仍运行')
      await expect.poll(() => workerAlive(busy.url)).toBe(false)
      expect(await frame.evaluate(() => globalThis.workerFixture.describe())).toMatchObject({ signal: true, aborted: false })
      expect(await frame.evaluate(type => globalThis.workerFixture.run(type), type)).toMatchObject({ type, native: true, detached: true })
    })
  })
}

test('module startup receives configuration during top-level await and replays messages as separate tasks in Host and opaque View', async ({ buddy }, testInfo) => {
  await withPlugin(buddy, testInfo, async ({ page }) => {
    const frame = await openProbe(page)
    const expected = { initialized: 'initialized', query: { initialized: true, order: ['initialized', 'module-resumed', 'query'], byte: 42 }, detached: true }
    for (const mode of ['property', 'listener']) {
      expect(await invoke(page, workerProbeId, 'startup', mode)).toEqual(expected)
      expect(await frame.evaluate(mode => globalThis.workerFixture.startup(mode), mode)).toEqual(expected)
    }
  })
})

test('WASM allowances preserve Host and opaque view CSP, Node isolation and worker package/session boundaries', async ({ buddy }, testInfo) => {
  await withPlugin(buddy, testInfo, async ({ page }) => {
    const host = await invoke(page, workerProbeId, 'describe')
    expect(host).toMatchObject({ signal: true, aborted: false })
    expect(await invoke(page, workerProbeId, 'wasm')).toEqual({ binary: 42, streaming: 42, mime: 'application/wasm', valid: true })
    const hostSecurity = await invoke(page, workerProbeId, 'security')
    expect(hostSecurity).toMatchObject({
      evalDenied: true,
      functionDenied: true,
      node: 'undefined',
      require: 'undefined',
      desktop: 'undefined',
      directDenied: true,
      directive: 'connect-src',
    })
    expect(hostSecurity.brokerError).toMatch(/EXTENSION_[A-Z_]+/)
    const frame = await openProbe(page)
    const view = await frame.evaluate(() => globalThis.workerFixture.describe())
    expect(new URL(view.entry).hostname).not.toBe(new URL(host.entry).hostname)
    const viewSecurity = await frame.evaluate(() => globalThis.workerFixture.security())
    expect(viewSecurity).toMatchObject({
      evalDenied: true,
      functionDenied: true,
      node: 'undefined',
      require: 'undefined',
      desktop: 'undefined',
      directDenied: true,
      directive: 'connect-src',
      parentDenied: true,
      origin: 'null',
    })
    expect(viewSecurity.brokerError).toMatch(/EXTENSION_[A-Z_]+/)
    const results = {
      host: await invoke(page, workerProbeId, 'entries', view.entry),
      view: await frame.evaluate(foreign => globalThis.workerFixture.entries(foreign), host.entry),
    }
    for (const cases of Object.values(results)) {
      expect(Object.keys(cases)).toEqual(['network', 'filesystem', 'runtime', 'encodedEscape', 'foreign', 'aborted'])
      for (const [name, result] of Object.entries(cases)) {
        expect(result.rejected, name).toBe(true)
        expect(result.error, name).toContain(name === 'aborted' ? 'AbortError' : 'EXTENSION_WORKER_ENTRY_INVALID')
      }
    }
    await testInfo.attach('worker-security', { body: JSON.stringify({ host: hostSecurity, view: viewSecurity, entries: results }, null, 2), contentType: 'application/json' })
  })
})

test('closing a view stops only its workers while explicit Host work survives until restart or disable', async ({ buddy }, testInfo) => {
  await withPlugin(buddy, testInfo, async ({ page, workerAlive, consoleMessages }) => {
    const host = await invoke(page, workerProbeId, 'start')
    await expect.poll(() => workerAlive(host.url)).toBe(true)
    const frame = await openProbe(page)
    const view = await frame.evaluate(() => globalThis.workerFixture.start())
    await expect.poll(() => workerAlive(view.url)).toBe(true)
    await expect.poll(async () => (await invoke(page, workerProbeId, 'status')).ticks).toBeGreaterThan(2)
    const beforeClose = await invoke(page, workerProbeId, 'status')
    await page.locator('.desktop-task-context-panel__tab.is-active .desktop-task-context-panel__tab-close').click()
    await expect.poll(() => frame.isDetached()).toBe(true)
    await expect.poll(() => workerAlive(view.url)).toBe(false)
    expect(await workerAlive(host.url)).toBe(true)
    await expect.poll(async () => (await invoke(page, workerProbeId, 'status')).ticks).toBeGreaterThan(beforeClose.ticks)
    const abortObserved = instance => consoleMessages.some(message => message.text === `extension-worker-owner-aborted:${instance}`)

    await page.evaluate(id => window.lexoraDesktop.extensions.restart(id), workerProbeId)
    await expect.poll(() => workerAlive(host.url)).toBe(false)
    await expect.poll(() => abortObserved(host.instance)).toBe(true)
    const restarted = await invoke(page, workerProbeId, 'status')
    expect(restarted).toMatchObject({ ticks: 0, ticker: null })
    expect(restarted.instance).not.toBe(host.instance)
    const next = await invoke(page, workerProbeId, 'start')
    await expect.poll(() => workerAlive(next.url)).toBe(true)
    await page.evaluate(id => window.lexoraDesktop.extensions.enable(id, false), workerProbeId)
    await expect.poll(() => workerAlive(next.url)).toBe(false)
    await expect.poll(() => abortObserved(next.instance)).toBe(true)
    await expect(invoke(page, workerProbeId, 'status')).rejects.toThrow(/EXTENSION_/)
    await page.evaluate(id => window.lexoraDesktop.extensions.enable(id, true), workerProbeId)
    const enabled = await invoke(page, workerProbeId, 'status')
    expect(enabled).toMatchObject({ ticks: 0, ticker: null })
    expect(enabled.instance).not.toBe(next.instance)
    expect(await invoke(page, workerProbeId, 'describe')).toMatchObject({ signal: true, aborted: false })
  })
})

import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { inspectWindowsPrivateDirectory as inspect } from '../../../apps/buddy/platform/filesystem/__tests__/windowsPrivateDirectoryFixture.ts'
import { expect, test } from '../fixtures/electron.mjs'

for (const firstResult of ['ready', 'cancelled']) {
  test(`sandbox setup keeps one active operation and settles its ${firstResult} result without a loading gap`, async ({ buddy }) => {
    const instance = await buddy.createInstance('sandbox-setup')
    const { app, page, diagnostics } = await instance.launch()
    await app.evaluate(({ ipcMain }) => {
      globalThis.sandboxSetupProbe = { status: 'needs_setup', setups: 0, check: null, install: null }
      ipcMain.removeHandler('lexora:app:get-sandbox-status')
      ipcMain.handle('lexora:app:get-sandbox-status', async () => {
        const probe = globalThis.sandboxSetupProbe
        await probe.check?.promise
        return probe.status
      })
      ipcMain.removeHandler('lexora:app:setup-sandbox')
      ipcMain.handle('lexora:app:setup-sandbox', () => {
        const probe = globalThis.sandboxSetupProbe
        probe.setups++
        probe.install = Promise.withResolvers()
        return probe.install.promise
      })
    })
    await page.reload()
    await page.locator('.desktop-permission-mode-selector__trigger:visible').click()
    await page.getByRole('button', { name: '启用 Windows 沙盒', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '继续', exact: true }).click()
    await expect.poll(() => app.evaluate(() => globalThis.sandboxSetupProbe.setups)).toBe(1)
    const waiting = dialog.locator('button').filter({ hasText: '等待 Windows 完成…' })
    await expect(waiting).toHaveClass(/n-button--loading/)
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
    await waiting.evaluate(button => button.click())
    expect(await app.evaluate(() => globalThis.sandboxSetupProbe.setups)).toBe(1)

    await app.evaluate((_electron, result) => {
      const probe = globalThis.sandboxSetupProbe
      probe.check = Promise.withResolvers()
      probe.status = result === 'ready' ? 'available' : 'needs_setup'
      probe.install.resolve(result)
    }, firstResult)

    if (firstResult === 'cancelled') {
      await expect(dialog.getByRole('status')).toContainText('已取消管理员确认')
      await expect(waiting).toHaveClass(/n-button--loading/)
      await waiting.evaluate(button => button.click())
      expect(await app.evaluate(() => globalThis.sandboxSetupProbe.setups)).toBe(1)
      await app.evaluate(() => {
        globalThis.sandboxSetupProbe.check.resolve()
        globalThis.sandboxSetupProbe.check = null
      })
      await dialog.getByRole('button', { name: '继续', exact: true }).click()
      await expect.poll(() => app.evaluate(() => globalThis.sandboxSetupProbe.setups)).toBe(2)
      await app.evaluate(() => {
        const probe = globalThis.sandboxSetupProbe
        probe.check = Promise.withResolvers()
        probe.status = 'available'
        probe.install.resolve('ready')
      })
    }

    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.desktop-permission-mode-selector__warning')).toHaveCount(0)
    await app.evaluate(() => {
      globalThis.sandboxSetupProbe.check.resolve()
      globalThis.sandboxSetupProbe.check = null
    })
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'sandbox-ready.png'), animations: 'disabled' })
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  })
}

test('three concurrent instances isolate their data and survive another instance crashing', async ({ buddy }) => {
  const instances = await Promise.all(['first', 'second', 'third'].map(label => buddy.createInstance(label)))
  const applications = await Promise.all(instances.map(instance => instance.launch()))
  const snapshots = await Promise.all(applications.map(({ app }) => app.evaluate(({ app }) => ({
    name: app.getName(),
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
  }))))
  expect(new Set(snapshots.map(value => value.userData)).size).toBe(3)
  expect(new Set(snapshots.map(value => value.sessionData)).size).toBe(3)
  expect(snapshots.map(value => value.name)).toEqual(Array.from({ length: 3 }).fill('Lexora Buddy Test'))
  await Promise.all(applications.map(async ({ app, page }, index) => {
    await page.evaluate(async (index) => {
      await window.lexoraDesktop.settings.update({ desktop: { profile: { userName: `Test ${index}` } } })
      localStorage.setItem('test-instance', String(index))
    }, index)
    expect(await (await app.browserWindow(page)).evaluate(window => window.getTitle())).toBe('Lexora Buddy Test')
  }))
  await instances[0].stop()
  applications[0] = await instances[0].launch()
  expect(await applications[0].page.evaluate(() => localStorage.getItem('test-instance'))).toBe('0')
  const crashed = applications[0].app.process()
  const exited = once(crashed, 'exit')
  crashed.kill('SIGKILL')
  await exited
  await instances[0].stop()
  for (let index = 1; index < 3; index++) {
    expect(await applications[index].page.evaluate(() => localStorage.getItem('test-instance'))).toBe(String(index))
    expect((await applications[index].page.evaluate(() => window.lexoraDesktop.settings.get())).desktop.profile.userName).toBe(`Test ${index}`)
    expect((await applications[index].page.evaluate(() => window.lexoraDesktop.app.startup.getState())).status).toBe('ready')
  }
  applications[0] = await instances[0].launch()
  expect(await applications[0].page.evaluate(() => localStorage.getItem('test-instance'))).toBe('0')
  expect((await applications[0].page.evaluate(() => window.lexoraDesktop.settings.get())).desktop.profile.userName).toBe('Test 0')
  for (const { diagnostics } of applications)
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('graceful restart preserves the same instance configuration and browser state', async ({ buddy }) => {
  const instance = await buddy.createInstance('restart')
  const { page } = await instance.launch()
  await page.evaluate(async () => {
    await window.lexoraDesktop.settings.update({ desktop: { profile: { userName: 'Restart Test' } } })
    localStorage.setItem('restart-marker', 'persisted')
  })
  await instance.stop()
  const restarted = await instance.launch()
  expect((await restarted.page.evaluate(() => window.lexoraDesktop.settings.get())).desktop.profile.userName).toBe('Restart Test')
  expect(await restarted.page.evaluate(() => localStorage.getItem('restart-marker'))).toBe('persisted')
})

test.describe('Windows storage permissions', () => {
  test.skip(process.platform !== 'win32', 'Windows ACL integration')
  const privateAcl = 'D:P(A;OICI;FA;;;CURRENT)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'

  test('read-only grants allow application startup without changing the ACL', async ({ buddy }) => {
    const instance = await buddy.createInstance('read-only-storage')
    const before = inspect(instance.home, `${privateAcl}(A;OICI;0x1200a9;;;BU)`)
    const { app, page, diagnostics } = await instance.launch()
    expect(await (await app.browserWindow(page)).evaluate(window => window.isVisible())).toBe(true)
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
    await instance.stop()
    expect(inspect(instance.home).sddl).toBe(before.sddl)
  })

  test('write grants stop startup before loading product data', async ({ buddy }) => {
    const instance = await buddy.createInstance('writable-storage')
    const before = inspect(instance.home, `${privateAcl}(A;OICI;0x1200ab;;;BU)`)
    const configPath = path.join(instance.home, 'config.toml')
    const config = await fs.readFile(configPath, 'utf8')
    await expect(instance.launch()).rejects.toThrow('Application failed to start')
    expect(inspect(instance.home).sddl).toBe(before.sddl)
    expect(await fs.readFile(configPath, 'utf8')).toBe(config)
    await expect(fs.access(path.join(instance.home, 'buddy/buddy.sqlite3'))).rejects.toMatchObject({ code: 'ENOENT' })
    const records = (await fs.readFile(path.join(instance.home, '.runtime/state/logs/application.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(records.some(record => record.errorCode === 'PRIVATE_DIRECTORIES_UNSAFE' && record.failure?.directoryRole === 'lexora_home')).toBe(true)
    expect(records.some(record => record.event === 'app.ready')).toBe(false)
  })
})

test('renderer crashes recover once and then stop without a reload loop', async ({ buddy }) => {
  const instance = await buddy.createInstance('renderer-recovery')
  const { app, page } = await instance.launch()
  await page.evaluate(() => localStorage.setItem('recovery-marker', 'preserved'))

  const firstRendererPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('lexora-app:')).webContents.getOSProcessId())
  process.kill(firstRendererPid, 'SIGKILL')
  await expect.poll(async () => {
    const files = await fs.readdir(instance.home, { recursive: true })
    const log = files.find(file => file.endsWith('application.jsonl'))
    if (!log)
      return 0
    return (await fs.readFile(path.join(instance.home, log), 'utf8')).split('\n').filter(line => line.includes('"event":"window.loaded"')).length
  }, { timeout: 30000 }).toBe(2)
  await expect.poll(async () => {
    try {
      return await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('lexora-app:'))
        return window?.webContents.executeJavaScript('localStorage.getItem("recovery-marker")')
      })
    }
    catch {
      return null
    }
  }, { timeout: 30000 }).toBe('preserved')

  const secondRendererPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('lexora-app:')).webContents.getOSProcessId())
  process.kill(secondRendererPid, 'SIGKILL')
  await expect.poll(async () => {
    const files = await fs.readdir(instance.home, { recursive: true })
    const log = files.find(file => file.endsWith('application.jsonl'))
    if (!log)
      return 0
    return (await fs.readFile(path.join(instance.home, log), 'utf8')).split('\n').filter(line => line.includes('renderer.recovery.exhausted')).length
  }).toBe(1)
  await expect.poll(async () => {
    const files = await fs.readdir(instance.home, { recursive: true })
    const log = files.find(file => file.endsWith('application.jsonl'))
    if (!log)
      return 0
    return (await fs.readFile(path.join(instance.home, log), 'utf8')).split('\n').filter(line => line.includes('renderer.recovery.presented')).length
  }).toBe(1)
  const files = await fs.readdir(instance.home, { recursive: true })
  const log = files.find(file => file.endsWith('application.jsonl'))
  const events = (await fs.readFile(path.join(instance.home, log), 'utf8')).split('\n')
  expect(events.filter(line => line.includes('"event":"window.created"'))).toHaveLength(1)
  expect(events.filter(line => line.includes('"event":"window.loaded"'))).toHaveLength(2)
  expect(app.process().exitCode).toBeNull()
  const exited = once(app.process(), 'exit')
  app.process().kill('SIGKILL')
  await exited
})

test('test profile preserves system autostart entries even with the packaged flag', async ({ buddy }) => {
  test.skip(process.platform !== 'linux', 'Linux autostart integration')
  const instance = await buddy.createInstance('autostart')
  const { app, page } = await instance.launch()
  const require = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))
  const { desktopName } = require('./package.json')
  const autostart = path.join(instance.home, '.runtime/system-config/autostart', `${desktopName}.desktop`)
  await fs.mkdir(path.dirname(autostart), { recursive: true })
  await fs.writeFile(autostart, 'existing-login-entry')
  const previous = await app.evaluate(({ app }, configRoot) => {
    const previous = { isPackaged: app.isPackaged, configRoot: process.env.XDG_CONFIG_HOME }
    app.isPackaged = true
    process.env.XDG_CONFIG_HOME = configRoot
    return previous
  }, path.dirname(path.dirname(autostart)))
  try {
    await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { launchAtLogin: false } }))
    expect(await fs.readFile(autostart, 'utf8')).toBe('existing-login-entry')
  }
  finally {
    await app.evaluate(({ app }, previous) => {
      app.isPackaged = previous.isPackaged
      if (previous.configRoot === undefined)
        delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous.configRoot
    }, previous)
  }
})

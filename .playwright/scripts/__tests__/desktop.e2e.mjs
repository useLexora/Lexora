import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { expect, test } from '../fixtures/electron.mjs'

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
  await applications[0].app.evaluate(({ session }) => session.defaultSession.flushStorageData())
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

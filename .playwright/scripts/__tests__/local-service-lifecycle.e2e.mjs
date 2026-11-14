import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { startDisplay } from '../buddy-test.mjs'
import { expect, test } from '../fixtures/electron.mjs'
import { processAlive as live, connectLocalService as management, readJson } from '../fixtures/local-service.mjs'
import { ROOT } from '../shared.mjs'

const buddyRoot = path.join(ROOT, 'apps/buddy')
const require = createRequire(path.join(buddyRoot, 'package.json'))

const execute = promisify(execFile)
const cases = [{ storageAuthority: 'legacy_jsonl' }, { storageAuthority: 'sqlite' }]
if (process.env.LEXORA_TEST_SESSION_SERVICE === '1')
  cases.push({ storageAuthority: 'sqlite', sessionService: true })

for (const { storageAuthority, sessionService } of cases) {
  test(`independent Core maintains ${storageAuthority} storage${sessionService ? ', registered by systemd' : ''}, survives Desktop exit, and fully stops its host`, async ({ buddy }, testInfo) => {
    test.skip(process.platform !== 'linux', 'The POSIX process-group acceptance runs on Linux')
    test.setTimeout(180000)
    const instance = await buddy.createInstance('independent-service')
    let preparationModule
    if (storageAuthority === 'sqlite') {
      const preparation = testInfo.outputPath('profile-preparation')
      const { build } = await import(pathToFileURL(require.resolve('vite')).href)
      await build({ configFile: false, logLevel: 'error', build: {
        ssr: path.join(ROOT, '.playwright/scripts/__tests__/prepareProductProfile.ts'),
        outDir: preparation,
        target: 'node26',
        rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'prepare.mjs', format: 'es' } },
      } })
      preparationModule = await import(pathToFileURL(path.join(preparation, 'prepare.mjs')).href)
    }
    const display = await startDisplay()
    const output = path.join(buddyRoot, '.output')
    const release = JSON.parse(await fs.readFile(path.join(output, 'release-set.json'), 'utf8'))
    const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    let runtimeDirectory = path.join(instance.home, '.runtime')
    await fs.mkdir(runtimeDirectory, { mode: 0o700 })
    const config = {
      version: 1,
      profile: 'test',
      profileRoot: instance.home,
      resourcesRoot: path.join(output, path.dirname(release.core.entry), 'resources'),
      nodeExecutable: path.join(output, release.node.entry),
      coreEntry: path.join(output, release.core.entry),
      hostExecutable: require('electron'),
      hostArguments: ['--ozone-platform=x11', '--disable-setuid-sandbox', '--disable-gpu', '--remote-debugging-port=0', buddyRoot],
      releaseSetPath: path.join(output, 'release-set.json'),
      buildId: release.buildId,
      sessionId: `${boot}:${process.env.XDG_SESSION_ID}`,
      userId: String(process.getuid()),
      leaseDirectory: path.join(path.dirname(instance.home), '.leases'),
      storageAuthority,
    }
    const launchFile = path.join(runtimeDirectory, 'launch.json')
    await fs.writeFile(launchFile, JSON.stringify(config), { mode: 0o600 })
    let stderr = ''
    const core = sessionService ? null : spawn(config.nodeExecutable, [config.coreEntry, '--config', launchFile], { cwd: ROOT, env: { ...process.env, DISPLAY: display.address, WAYLAND_DISPLAY: '', LEXORA_BUDDY_PROFILE: 'test', LEXORA_HOME: instance.home }, stdio: ['ignore', 'pipe', 'pipe'] })
    core?.stderr.on('data', (value) => {
      stderr += value
    })
    core?.stdout.on('data', (value) => {
      stderr += value
    })
    let browser
    let client
    let product
    let hostPid
    let corePid = core?.pid
    let unit
    try {
      if (sessionService) {
        const launcher = preparationModule.resolveBuddyProcessControl({ appPath: config.resourcesRoot, resourcesPath: config.resourcesRoot, isPackaged: true })
        expect(launcher).toBeTruthy()
        const registration = new preparationModule.SessionServiceRegistration(config, launchFile, launcher)
        unit = `${registration.name}.service`
        const previousDisplay = process.env.DISPLAY
        const previousWayland = process.env.WAYLAND_DISPLAY
        process.env.DISPLAY = display.address
        process.env.WAYLAND_DISPLAY = ''
        try {
          await registration.start()
        }
        finally {
          if (previousDisplay === undefined)
            delete process.env.DISPLAY
          else process.env.DISPLAY = previousDisplay
          if (previousWayland === undefined)
            delete process.env.WAYLAND_DISPLAY
          else process.env.WAYLAND_DISPLAY = previousWayland
        }
      }
      await expect.poll(async () => {
        const discovery = await readJson(path.join(runtimeDirectory, 'service.json'))
        return discovery?.phase
      }, { timeout: 120000 }).toBe('ready')
      let discovery = await readJson(path.join(runtimeDirectory, 'service.json'))
      if (unit) {
        corePid = Number((await execute('/usr/bin/systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'])).stdout.trim())
        stderr = (await execute('/usr/bin/journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager'], { maxBuffer: 4 * 1024 * 1024 })).stdout
      }
      expect(discovery.process.pid).toBe(corePid)
      let credentials = await readJson(path.join(runtimeDirectory, 'local-client.json'))
      client = await management(discovery, credentials.managementSecret)
      await expect.poll(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]).toBeTruthy()
      browser = await chromium.connectOverCDP(stderr.match(/DevTools listening on (ws:\/\/\S+)/)[1])
      expect(browser.contexts().flatMap(context => context.pages()).filter(page => page.url().startsWith('lexora-app:'))).toHaveLength(0)
      const children = (await fs.readFile(`/proc/${corePid}/task/${corePid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number)
      const executable = await fs.realpath(config.hostExecutable)
      const hosts = []
      for (const pid of children) {
        if (await fs.readlink(`/proc/${pid}/exe`).catch(() => null) === executable)
          hosts.push(pid)
      }
      expect(hosts).toHaveLength(1)
      hostPid = hosts[0]
      const opened = await client.request('service.openDesktop', { expectedServiceInstanceId: discovery.serviceInstanceId, intent: { kind: 'tasks' } })
      expect(opened).toMatchObject({ accepted: true, uiReady: true, targetVisible: true, visible: true })
      let page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('lexora-app:'))
      expect(page).toBeTruthy()
      await expect.poll(() => page.evaluate(() => window.lexoraDesktop.app.startup.getState())).toMatchObject({ status: 'ready' })
      const info = await page.evaluate(() => window.lexoraDesktop.app.getInfo())
      expect(path.dirname(info.configPath)).toBe(instance.home)
      const firstGeneration = await page.evaluate(async () => (await window.lexoraDesktop.app.startup.getState()).generation)
      const snapshot = await page.evaluate(() => window.lexoraDesktop.storage.snapshot({ scopes: ['tasks', 'settings'], credentials: false }))
      expect(snapshot.id).toBeTruthy()
      await expect.poll(() => page.evaluate(() => window.lexoraDesktop.app.startup.getState())).toMatchObject({ status: 'ready', maintenance: null })
      const backupGeneration = await page.evaluate(async () => (await window.lexoraDesktop.app.startup.getState()).generation)
      expect(backupGeneration).not.toBe(firstGeneration)
      expect((await client.request('service.status', {})).process.pid).toBe(corePid)
      await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
      await expect.poll(() => page.evaluate(() => window.lexoraDesktop.app.startup.getState())).toMatchObject({ status: 'ready', maintenance: null })
      expect(await page.evaluate(async () => (await window.lexoraDesktop.app.startup.getState()).generation)).not.toBe(backupGeneration)
      expect((await client.request('service.status', {})).process.pid).toBe(corePid)
      await expect(client.request('service.beginMaintenance', { expectedServiceInstanceId: discovery.serviceInstanceId, kind: 'backup' })).rejects.toThrow()
      const restart = async (expectedRoot = instance.home) => {
        const previousHost = hostPid
        const previousService = discovery.serviceInstanceId
        await page.evaluate(() => window.lexoraDesktop.storage.restart())
        runtimeDirectory = path.join(expectedRoot, '.runtime')
        await expect.poll(async () => {
          const next = await readJson(path.join(runtimeDirectory, 'service.json'))
          return next?.phase === 'ready' && next.serviceInstanceId !== previousService
        }, { timeout: 120000 }).toBe(true)
        expect(await live(previousHost)).toBe(false)
        discovery = await readJson(path.join(runtimeDirectory, 'service.json'))
        credentials = await readJson(path.join(runtimeDirectory, 'local-client.json'))
        client.close()
        client = await management(discovery, credentials.managementSecret)
        expect(discovery.process.pid).toBe(corePid)
        if (unit)
          stderr = (await execute('/usr/bin/journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager'], { maxBuffer: 4 * 1024 * 1024 })).stdout
        await browser.close().catch(() => {})
        const endpoint = [...stderr.matchAll(/DevTools listening on (ws:\/\/\S+)/g)].at(-1)?.[1]
        browser = await chromium.connectOverCDP(endpoint)
        page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('lexora-app:'))
        await expect.poll(() => page?.evaluate(() => window.lexoraDesktop.app.startup.getState())).toMatchObject({ status: 'ready' })
        expect(path.dirname((await page.evaluate(() => window.lexoraDesktop.app.getInfo())).configPath)).toBe(expectedRoot)
        const children = (await fs.readFile(`/proc/${corePid}/task/${corePid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number)
        const nextHosts = []
        for (const pid of children) {
          if (await fs.readlink(`/proc/${pid}/exe`).catch(() => null) === executable)
            nextHosts.push(pid)
        }
        expect(nextHosts).toHaveLength(1)
        hostPid = nextHosts[0]
      }
      await restart()
      if (storageAuthority === 'sqlite') {
        if (sessionService) {
          await page.evaluate(id => window.lexoraDesktop.storage.restore(id, { scopes: ['tasks', 'settings'], credentials: false }), snapshot.id)
          await restart()
        }
        else {
          const moved = `${instance.home}-moved`
          await page.evaluate(target => window.lexoraDesktop.storage.relocate(target), moved)
          await restart(moved)
        }
      }
      await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { exitBehavior: 'keep_service' } }))
      await page.screenshot({ path: testInfo.outputPath('independent-workbench.png'), animations: 'disabled', timeout: 10000 })
      const closed = page.waitForEvent('close')
      await page.evaluate(() => window.lexoraDesktop.commands.execute('app.quit'))
      await closed
      expect((await client.request('service.status', {})).process.pid).toBe(corePid)
      expect(await live(hostPid)).toBe(true)
      if (storageAuthority === 'sqlite') {
        product = await management(discovery, credentials.productSecret, 'product')
        const initialized = await product.request('initialize', { protocol: { major: 1, minMinor: 0, maxMinor: 0 }, client: { kind: 'mobile', version: 'test' }, supportedContentKinds: ['buddy-user-content-v1'], supportedReviewKinds: [] })
        const command = { dataGeneration: initialized.dataGeneration, commandId: randomUUID(), expectedServiceInstanceId: initialized.serviceInstanceId, intent: { kind: 'settings' } }
        const result = await product.request('desktop.open', command)
        expect(result.receipt).toMatchObject({ decision: 'accepted', result: { desktop: { uiReady: true, targetVisible: true, visible: true } } })
        expect(await product.request('desktop.open', command)).toEqual(result)
        expect(await product.request('commands.get', { dataGeneration: command.dataGeneration, commandId: command.commandId })).toEqual({ lookup: 'decided', receipt: result.receipt })
      }
      else {
        expect(await client.request('service.openDesktop', { expectedServiceInstanceId: discovery.serviceInstanceId, intent: { kind: 'settings' } })).toMatchObject({ targetVisible: true })
      }
      const reopened = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('lexora-app:'))
      expect(reopened).not.toBe(page)
      expect(reopened.url()).toContain('#/settings/general')
      await expect.poll(() => reopened.evaluate(() => window.lexoraDesktop.app.startup.getState())).toMatchObject({ status: 'ready' })
      expect((await reopened.evaluate(() => window.lexoraDesktop.settings.get())).desktop.exitBehavior).toBe('keep_service')
      const exited = core ? once(core, 'exit') : null
      if (storageAuthority === 'sqlite' && !sessionService) {
        await reopened.evaluate(async () => {
          await window.lexoraDesktop.settings.update({ desktop: { exitBehavior: 'stop_service' } })
          void window.lexoraDesktop.commands.execute('app.quit')
        })
      }
      else {
        expect(await client.request('service.stop', { expectedServiceInstanceId: discovery.serviceInstanceId, commandId: randomUUID(), reason: 'explicit' })).toEqual({ accepted: true })
      }
      if (exited)
        await exited
      else await expect.poll(() => live(corePid)).toBe(false)
      expect(await live(hostPid)).toBe(false)
      expect(await readJson(path.join(runtimeDirectory, 'service.json'))).toBeNull()
    }
    finally {
      product?.close()
      client?.close()
      await browser?.close().catch(() => {})
      if (core && core.exitCode === null && core.signalCode === null) {
        const exited = once(core, 'exit')
        core.kill('SIGTERM')
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))])
      }
      if (unit) {
        await execute('/usr/bin/systemctl', ['--user', 'stop', unit]).catch(() => {})
        stderr = (await execute('/usr/bin/journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager'], { maxBuffer: 4 * 1024 * 1024 })).stdout
      }
      await display.stop()
      await fs.writeFile(testInfo.outputPath('service.log'), stderr)
      await testInfo.attach('service-log', { path: testInfo.outputPath('service.log'), contentType: 'text/plain' })
    }
  })
}

for (const legacy of [false, true]) {
  test(`desktop launcher ${legacy ? 'upgrades legacy data and' : 'initializes SQLite and'} starts one session service, reuses it and honors installer shutdown`, async ({ buddy }, testInfo) => {
    test.skip(process.platform !== 'linux' || process.env.LEXORA_TEST_SESSION_SERVICE !== '1', 'Requires an explicit Linux user-session service acceptance')
    test.setTimeout(180000)
    const instance = await buddy.createInstance('service-launcher', { executablePath: legacy ? process.env.LEXORA_TEST_LEGACY_EXECUTABLE : undefined })
    let original
    let draftId
    if (legacy) {
      const { page } = await instance.launch()
      const editor = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
      await editor.fill('启动升级保留草稿 😀')
      await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.composerDrafts.list()).find(draft => JSON.stringify(draft.content).includes('启动升级保留草稿 😀'))?.draftId)).toBeTruthy()
      draftId = await page.evaluate(async () => (await window.lexoraDesktop.localChat.composerDrafts.list()).find(draft => JSON.stringify(draft.content).includes('启动升级保留草稿 😀')).draftId)
      await instance.stop()
      original = await fs.readFile(path.join(instance.home, 'buddy/buddy.sqlite3'))
    }
    const display = await startDisplay()
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:LEXORA_|ELECTRON_|PI_)/.test(key)))
    Object.assign(environment, { DISPLAY: display.address, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', LEXORA_BUDDY_PROFILE: 'test', LEXORA_HOME: instance.home, LEXORA_BUDDY_SERVICE_MODE: 'daemon' })
    const packaged = process.env.LEXORA_TEST_SERVICE_EXECUTABLE
    if (packaged)
      delete environment.LEXORA_BUDDY_SERVICE_MODE
    const launch = async (...args) => {
      const result = await execute(packaged ?? require('electron'), ['--ozone-platform=x11', '--disable-setuid-sandbox', '--disable-gpu', ...(packaged ? [] : [buddyRoot]), ...args], { cwd: ROOT, env: environment, timeout: 130000, maxBuffer: 1024 * 1024 })
      await fs.appendFile(testInfo.outputPath('launcher.log'), result.stderr)
    }
    const directory = path.join(instance.home, '.runtime')
    const launchFile = path.join(path.dirname(instance.home), '.lexora-locations', createHash('sha256').update(instance.home).digest('hex').slice(0, 24), 'service', 'launch.json')
    let unit
    let client
    let corePid
    try {
      await launch('--background')
      await expect.poll(() => readJson(launchFile), { timeout: 120000 }).not.toBeNull()
      const config = await readJson(launchFile)
      unit = `lexora-core-${createHash('sha256').update(`${config.defaultRoot ?? config.profileRoot}\0${config.sessionId}`).digest('hex').slice(0, 24)}.service`
      expect(config.hostArguments).toEqual(expect.arrayContaining(['--ozone-platform=x11', '--disable-gpu']))
      await expect.poll(() => readJson(path.join(directory, 'service.json')), { timeout: 120000 }).toMatchObject({ phase: 'ready' })
      const discovery = await readJson(path.join(directory, 'service.json'))
      expect(discovery.phase).toBe('ready')
      corePid = discovery.process.pid
      const credentials = await readJson(path.join(directory, 'local-client.json'))
      client = await management(discovery, credentials.managementSecret)
      const opened = await client.request('service.openDesktop', { expectedServiceInstanceId: discovery.serviceInstanceId, intent: { kind: 'tasks' } })
      expect(opened).toMatchObject({ accepted: true, uiReady: true, targetVisible: true, visible: true })
      await launch()
      expect((await readJson(path.join(directory, 'service.json'))).serviceInstanceId).toBe(discovery.serviceInstanceId)
      expect((await client.request('service.status', {})).process.pid).toBe(corePid)
      await launch('--quit-for-install')
      expect(await live(corePid)).toBe(false)
      await expect.poll(() => readJson(path.join(directory, 'service.json'))).toBeNull()
      await launch('--quit-for-install')
      const location = await readJson(path.join(path.dirname(path.dirname(launchFile)), 'location.json'))
      expect(discovery.profileId).toBe(location.identity.dataId)
      const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
      try {
        expect(database.prepare('SELECT authority, migration_state FROM storage_profile').get()).toMatchObject({ authority: 'sqlite', migration_state: 'ready' })
        if (legacy) {
          expect(database.prepare('SELECT content_json FROM composer_drafts WHERE id = ?').get(draftId).content_json).toContain('启动升级保留草稿 😀')
          const upgrade = location.history.find(operation => operation.kind === 'upgrade')
          expect(await fs.readFile(path.join(upgrade.retainedTarget, 'buddy/buddy.sqlite3'))).toEqual(original)
        }
      }
      finally { database.close() }
      expect(await readJson(path.join(directory, 'service.json'))).toBeNull()
    }
    finally {
      client?.close()
      const config = await readJson(launchFile)
      if (!unit && config)
        unit = `lexora-core-${createHash('sha256').update(`${config.defaultRoot ?? config.profileRoot}\0${config.sessionId}`).digest('hex').slice(0, 24)}.service`
      if (unit) {
        await execute('/usr/bin/systemctl', ['--user', 'stop', unit]).catch(() => {})
        const log = await execute('/usr/bin/journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager'], { maxBuffer: 4 * 1024 * 1024 })
        await fs.writeFile(testInfo.outputPath('launcher-service.log'), log.stdout)
      }
      await display.stop()
    }
  })
}

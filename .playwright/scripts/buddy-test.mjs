import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { attachPageDiagnostics, ROOT, serializeError } from './shared.mjs'

const repoRoot = ROOT
const buddyRoot = path.join(repoRoot, 'apps/buddy')
const require = createRequire(path.join(buddyRoot, 'package.json'))
const defaultConfig = '[desktop]\nlanguage = "zh-CN"\ntheme = "light"\nnotifications_enabled = false\nlaunch_at_login = false\n[pet]\nenabled = false\n[proxy]\nmode = "direct"\nserver = ""\n'

export async function createBuddyTestRun({ appPath = process.env.LEXORA_TEST_APP_PATH ?? buddyRoot, executablePath = process.env.LEXORA_TEST_EXECUTABLE_PATH, rendererUrl, runId = process.env.LEXORA_TEST_RUN_ID, dataRoot = path.join(homedir(), '.lexora-test'), artifactRoot = path.join(repoRoot, '.playwright/runs', randomUUID()), passwordStore } = {}) {
  if (rendererUrl) {
    const url = new URL(rendererUrl)
    assert(!executablePath && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Development renderer requires a local development application')
  }
  assert(passwordStore === undefined || (process.platform === 'linux' && ['kwallet', 'kwallet5', 'kwallet6', 'gnome-libsecret'].includes(passwordStore)), 'Unsupported secure password store')
  runId ??= `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  assert(/^[\w-]{1,100}$/.test(runId), 'Invalid test run ID')
  const root = await canonicalPath(path.resolve(dataRoot))
  for (const reserved of ['.lexora', '.lexora-dev']) {
    const protectedRoot = await canonicalPath(path.join(homedir(), reserved))
    assert(!contains(root, protectedRoot) && !contains(protectedRoot, root), 'Test data must not overlap user profiles')
  }
  const directory = path.join(root, 'runs', runId)
  const instancesRoot = path.join(directory, 'instances')
  const artifacts = path.resolve(artifactRoot)
  assert.equal(await canonicalPath(instancesRoot), instancesRoot, 'Test run directories must not redirect through links')
  await fs.mkdir(instancesRoot, { recursive: true, mode: 0o700 })
  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 })
  const instances = []
  const pending = new Set()
  const records = []
  let disposed = false
  async function createInstance(label) {
    assert(/^[\w-]{1,64}$/.test(label), 'Invalid test instance name')
    const home = await fs.mkdtemp(path.join(instancesRoot, `${label}-`))
    const identity = await fs.stat(home)
    await fs.writeFile(path.join(home, 'config.toml'), defaultConfig, { mode: 0o600 })
    const artifactDirectory = path.join(artifacts, path.basename(home))
    await fs.mkdir(artifactDirectory, { mode: 0o700 })
    const record = { home, artifactDirectory, launches: [] }
    records.push(record)
    let application
    let applicationProcess
    let page
    let display
    let launchRecord
    let launchNumber = 0
    let launching
    const instance = {
      home,
      artifactDirectory,
      async launch(options = {}) {
        assert(!disposed, 'Test run has been disposed')
        assert(!application && !launching, 'Stop the previous application before restarting this instance')
        launching = launch(options)
        try {
          return await launching
        }
        finally { launching = undefined }
      },
      async stop() {
        await launching?.catch(() => {})
        await stop()
      },
      async remove() {
        assert(!application && !display && !launching, 'Cannot remove a running test instance')
        assert.equal(await fs.realpath(home), home, 'Test instance was replaced with a link')
        const current = await fs.stat(home)
        assert.equal(current.ino, identity.ino, 'Test instance directory was replaced')
        assert.equal(current.dev, identity.dev, 'Test instance volume changed')
        await fs.rm(home, { recursive: true })
        record.removed = true
      },
    }
    instances.push(instance)
    return instance

    async function launch({ maintenance = false, expectedRoot = home } = {}) {
      assert(contains(instancesRoot, await canonicalPath(expectedRoot)), 'Expected root must stay in this isolated test run')
      const { _electron: electron } = await import('@playwright/test')
      const environment = createTestEnvironment(home)
      if (rendererUrl)
        environment.ELECTRON_RENDERER_URL = rendererUrl
      if (process.platform === 'linux') {
        display = await startDisplay()
        environment.DISPLAY = display.address
      }
      launchRecord = { startedAt: new Date().toISOString(), diagnostics: undefined, stderr: '' }
      record.launches.push(launchRecord)
      launchNumber += 1
      try {
        const args = [...(process.platform === 'linux' ? ['--ozone-platform=x11', '--disable-setuid-sandbox'] : []), ...(passwordStore ? [`--password-store=${passwordStore}`] : []), '--disable-gpu']
        application = executablePath
          ? await launchInstalled(executablePath, args, environment, { maintenance, artifactDirectory, launchNumber })
          : await electron.launch({ executablePath: require('electron'), args: [...args, path.resolve(appPath)], chromiumSandbox: true, cwd: repoRoot, env: environment, timeout: 45000 })
        applicationProcess = application.process()
        launchRecord.pid = applicationProcess.pid
        applicationProcess.stderr?.on('data', (chunk) => {
          launchRecord.stderr = `${launchRecord.stderr}${chunk}`.slice(-65536)
        })
        await application.context().tracing.start({ screenshots: true, snapshots: true })
        page = await application.firstWindow({ timeout: 45000 })
        launchRecord.diagnostics = attachPageDiagnostics(page)
        page.setDefaultTimeout(30000)
        await page.waitForFunction(rendererUrl => location.protocol === 'lexora-app:' || location.protocol === 'data:' || (rendererUrl && location.origin === new URL(rendererUrl).origin), rendererUrl, { timeout: 45000 })
        if (maintenance) {
          assert.equal(new URL(page.url()).protocol, 'data:')
          return { app: application, page, diagnostics: launchRecord.diagnostics }
        }
        assert.equal(rendererUrl ? new URL(page.url()).origin : new URL(page.url()).protocol, rendererUrl ? new URL(rendererUrl).origin : 'lexora-app:', `Application failed to start: ${await page.locator('body').textContent()}`)
        await page.waitForFunction(async () => (await window.lexoraDesktop?.app.startup.getState())?.status === 'ready', undefined, { timeout: 45000 })
        const info = await page.evaluate(() => window.lexoraDesktop.app.getInfo())
        assert.equal(info.runtimeProfile, 'test')
        if (executablePath)
          assert.equal(info.isPackaged, true)
        assert.equal(await fs.realpath(path.dirname(info.configPath)), await canonicalPath(expectedRoot))
        const { runtimeProfile, isPackaged, version, platform, configPath } = info
        launchRecord.application = { runtimeProfile, isPackaged, version, platform, configPath }
        return { app: application, page, diagnostics: launchRecord.diagnostics }
      }
      catch (error) {
        launchRecord.error = serializeError(error)
        await stop().catch(() => {})
        throw error
      }
    }
    async function stop() {
      if (application) {
        const current = application
        const child = applicationProcess
        if (executablePath || (child.exitCode === null && child.signalCode === null)) {
          await page?.screenshot({ path: path.join(artifactDirectory, `launch-${launchNumber}.png`), animations: 'disabled', timeout: 5000 }).catch(() => {})
          await withTimeout(current.context().tracing.stop({ path: path.join(artifactDirectory, `trace-${launchNumber}.zip`) }), 10000, 'Trace export timed out').catch(() => {})
          try {
            await withTimeout(current.close(), 15000, 'Electron did not stop')
          }
          catch (error) {
            await terminate(child)
            launchRecord.stopError = serializeError(error)
            throw error
          }
          finally {
            application = undefined
            applicationProcess = undefined
            page = undefined
            await display?.stop()
            display = undefined
          }
        }
        application = undefined
        applicationProcess = undefined
        page = undefined
      }
      await display?.stop()
      display = undefined
    }
  }
  return {
    directory,
    artifacts,
    runId,
    records,
    async createInstance(label = 'desktop') {
      assert(!disposed, 'Test run has been disposed')
      const operation = createInstance(label)
      pending.add(operation)
      try {
        return await operation
      }
      finally { pending.delete(operation) }
    },
    async dispose({ preserve = false } = {}) {
      disposed = true
      await Promise.allSettled(pending)
      const stopped = await Promise.allSettled(instances.map(instance => instance.stop()))
      const failures = stopped.filter(result => result.status === 'rejected').map(result => result.reason)
      if (!failures.length && !preserve) {
        for (const instance of instances) {
          try {
            await instance.remove()
          }
          catch (failure) { failures.push(failure) }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, `Could not clean up test instances in ${directory}`)
    },
  }
}

function createTestEnvironment(home) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && !/^(?:LEXORA_|ELECTRON_|PI_|XDG_|WAYLAND_DISPLAY$)/.test(key)))
  return { ...environment, LEXORA_BUDDY_PROFILE: 'test', LEXORA_HOME: home }
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function canonicalPath(value) {
  try {
    return await fs.realpath(value)
  }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(value) === value)
      throw error
    if ((await fs.lstat(value).catch((failure) => {
      if (failure.code !== 'ENOENT')
        throw failure
    }))?.isSymbolicLink()) {
      throw new Error('Test paths must not use dangling links')
    }
    return path.join(await canonicalPath(path.dirname(value)), path.basename(value))
  }
}

async function startDisplay() {
  const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1500x950x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096)
  })
  try {
    const address = await withTimeout(new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Xvfb exited (${code}): ${stderr}`)))
      let output = ''
      child.stdio[3].on('data', (chunk) => {
        output += chunk
        if (/^\d+\n$/.test(output))
          resolve(`:${output.trim()}`)
      })
    }), 10000, 'Xvfb did not start')
    return { address, stop: () => terminate(child) }
  }
  catch (error) {
    await terminate(child)
    throw error
  }
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  try {
    await withTimeout(exited, 3000, 'Process did not stop')
  }
  catch {
    child.kill('SIGKILL')
    await withTimeout(exited, 3000, 'Process did not exit after termination')
  }
}

async function withTimeout(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  }
  finally { clearTimeout(timer) }
}

async function launchInstalled(executablePath, args, environment, { maintenance, artifactDirectory, launchNumber }) {
  const { chromium } = await import('@playwright/test')
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const child = spawn(executablePath, [...args, `--remote-debugging-port=${port}`], { env: environment, cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-65536)
  })
  let browser
  let page
  const deadline = Date.now() + 90000
  try {
    while (Date.now() < deadline) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 })
      }
      catch {
        await new Promise(resolve => setTimeout(resolve, 200))
        continue
      }
      page = browser.contexts().flatMap(context => context.pages())[0]
      if (!page) {
        await browser.close()
        await new Promise(resolve => setTimeout(resolve, 200))
        continue
      }
      await page.waitForFunction(() => location.protocol === 'lexora-app:' || location.protocol === 'data:', undefined, { timeout: 45000 }).catch(() => {})
      if (page.isClosed()) {
        await browser.close()
        continue
      }
      if (!maintenance && page.url().startsWith('data:')) {
        await page.screenshot({ path: path.join(artifactDirectory, `migration-${launchNumber}.png`) }).catch(() => {})
        await withTimeout(once(browser, 'disconnected'), Math.max(1, deadline - Date.now()), 'Migration did not restart').catch(() => {})
        await browser.close()
        continue
      }
      return {
        context: () => page.context(),
        process: () => child,
        firstWindow: async () => page,
        close: async () => {
          if (browser.isConnected()) {
            const disconnected = withTimeout(once(browser, 'disconnected'), 15000, 'Installed application did not exit')
            if (page.url().startsWith('data:'))
              child.kill('SIGTERM')
            else
              await page.evaluate(() => window.lexoraDesktop.commands.execute('app.quit')).catch(() => {})
            await disconnected
          }
          await browser.close()
        },
      }
    }
    throw new Error(`Installed application did not become ready: ${stderr}`)
  }
  catch (error) {
    await browser?.close().catch(() => {})
    await terminate(child)
    throw error
  }
}

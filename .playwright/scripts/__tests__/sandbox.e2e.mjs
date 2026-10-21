import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import targets from '../../../apps/buddy/platform/targets.json' with { type: 'json' }
import { expect, test } from '../fixtures/electron.mjs'

const buddyRoot = path.resolve('apps/buddy')
const require = createRequire(path.join(buddyRoot, 'package.json'))

async function buildSandboxVerification(entry) {
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const mainDirectory = path.join(buddyRoot, '.output/build/electron/main')
  const processes = (await readdir(mainDirectory)).filter(file => /^sandboxProcess-.*\.js$/.test(file))
  expect(processes).toHaveLength(1)
  const outDir = await mkdtemp(path.join(mainDirectory, 'sandbox-verification-'))
  try {
    await build({
      configFile: false,
      root: buddyRoot,
      logLevel: 'error',
      publicDir: false,
      plugins: [{
        name: 'sandbox-verification-process',
        enforce: 'pre',
        resolveId: source => source.endsWith('?modulePath') ? source : null,
        load: id => id.endsWith('?modulePath') ? `export default ${JSON.stringify(path.join(mainDirectory, processes[0]))}` : null,
      }],
      build: {
        outDir,
        target: 'node22',
        minify: false,
        lib: { entry, formats: ['es'], fileName: () => 'verify.mjs' },
        rollupOptions: { external: ['electron', /^node:/] },
      },
    })
    return outDir
  }
  catch (error) {
    await rm(outDir, { recursive: true, force: true })
    throw error
  }
}

test('Sandbox preserves production RPC boundaries with large toolchains and empty HOME', async ({ buddy }, testInfo) => {
  test.skip(!['win32', 'linux'].includes(process.platform), 'Requires Windows or Linux sandbox resources')
  test.setTimeout(600_000)
  const outDir = await buildSandboxVerification(path.join(buddyRoot, 'electron/main/sandbox/verifySandboxInstallation.ts'))
  try {
    const instance = await buddy.createInstance('sandbox-scale')
    const { app, page } = await instance.launch()
    await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.runtime.getStatus()).status), { timeout: 120_000 }).toBe('ready')
    const measurements = await app.evaluate(async (_electron, { module, home, root, target }) => {
      const file = process.getBuiltinModule('node:url').fileURLToPath(module)
      const { join } = process.getBuiltinModule('node:path')
      const childProcess = process.getBuiltinModule('node:child_process')
      const spawn = childProcess.spawn
      const execFile = childProcess.execFile
      let nativeDiagnostics = ''
      const inspections = []
      const originalHome = process.env.HOME
      childProcess.execFile = (...args) => {
        const start = performance.now()
        const child = execFile(...args)
        if (String(args[0]).endsWith('lexora-buddy-sandbox.exe'))
          child.once('close', () => inspections.push({ action: args[1]?.[0], elapsedMs: performance.now() - start }))
        return child
      }
      const { promisify } = process.getBuiltinModule('node:util')
      Object.defineProperty(childProcess.execFile, promisify.custom, {
        value: async (...args) => {
          const start = performance.now()
          try {
            return await promisify(execFile)(...args)
          }
          finally {
            if (String(args[0]).endsWith('lexora-buddy-sandbox.exe'))
              inspections.push({ action: args[1]?.[0], elapsedMs: performance.now() - start })
          }
        },
      })
      childProcess.spawn = (...args) => {
        const child = spawn(...args)
        if (String(args[0]).endsWith('lexora-buddy-sandbox.exe'))
          child.stderr?.on('data', data => nativeDiagnostics = `${nativeDiagnostics}${data}`.slice(-8192))
        return child
      }
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
      try {
        process.env.HOME = ''
        const { verifySandboxInstallation } = process.getBuiltinModule('node:module').createRequire(file)(file)
        const measurements = await verifySandboxInstallation({
          buddyHome: home,
          protectedRoots: [home],
          ...(process.platform === 'win32'
            ? {
                windowsSandbox: join(root, `.output/build/native/${target.rustTarget}/release/lexora-buddy-sandbox.exe`),
                windowsShell: join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe'),
              }
            : {
                sandboxDirectory: join(root, `.output/build/shell-sandbox/${process.platform}-${process.arch}`),
                processControl: join(root, `.output/build/native/${target.rustTarget}/release/lexora-buddy-process-control`),
              }),
          searchDirectory: join(root, `.output/build/search-tools/${process.platform}-${process.arch}`),
        }, true)
        return { ...measurements, inspections }
      }
      catch (error) {
        throw new Error(`${error.message}; ${nativeDiagnostics}; ${JSON.stringify(inspections)}`)
      }
      finally {
        if (originalHome === undefined)
          delete process.env.HOME
        else
          process.env.HOME = originalHome
        childProcess.spawn = spawn
        childProcess.execFile = execFile
        process.getBuiltinModule('node:module').syncBuiltinESMExports()
      }
    }, { module: pathToFileURL(path.join(outDir, 'verify.mjs')).href, home: instance.home, root: buddyRoot, target: targets[`${process.platform}-${process.arch}`] })
    expect(measurements.repeatedRpcMs).toHaveLength(3)
    await testInfo.attach('sandbox-scale', { body: JSON.stringify({ toolchainFiles: 50_000, workspaceFiles: 5_000, ...measurements }), contentType: 'application/json' })
  }
  finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('Windows runs real mise toolchains through production sandbox RPC', async ({ buddy }, testInfo) => {
  test.skip(process.platform !== 'win32' || !process.env.LEXORA_TEST_MISE, 'Requires Windows and LEXORA_TEST_MISE pointing to a real mise.exe')
  test.setTimeout(600_000)
  expect(path.isAbsolute(process.env.LEXORA_TEST_MISE)).toBe(true)
  const outDir = await buildSandboxVerification(path.resolve('.playwright/scripts/fixtures/sandbox-toolchain.ts'))
  try {
    const instance = await buddy.createInstance('sandbox-mise')
    const { app, page } = await instance.launch()
    await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.runtime.getStatus()).status), { timeout: 120_000 }).toBe('ready')
    for (const scenario of ['xdg', 'explicit', 'empty-home']) {
      await test.step(scenario, async () => {
        const report = await app.evaluate(async (_electron, { module, home, root, target, mise, node, scenario }) => {
          const file = process.getBuiltinModule('node:url').fileURLToPath(module)
          const { join } = process.getBuiltinModule('node:path')
          const { verifyWindowsMise } = process.getBuiltinModule('node:module').createRequire(file)(file)
          return verifyWindowsMise({
            buddyHome: home,
            protectedRoots: [home],
            protectionScope: join(home, `mise-${scenario}`),
            windowsSandbox: join(root, `.output/build/native/${target.rustTarget}/release/lexora-buddy-sandbox.exe`),
            windowsShell: join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe'),
            searchDirectory: join(root, `.output/build/search-tools/${process.platform}-${process.arch}`),
          }, { mise, node, scenario })
        }, {
          module: pathToFileURL(path.join(outDir, 'verify.mjs')).href,
          home: instance.home,
          root: buddyRoot,
          target: targets[`${process.platform}-${process.arch}`],
          mise: process.env.LEXORA_TEST_MISE,
          node: process.execPath,
          scenario,
        })
        await testInfo.attach(`sandbox-mise-${scenario}`, { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
        expect.soft(report.passed, report.error ?? JSON.stringify(report)).toBe(true)
        if (!report.passed)
          return
        expect(report.identity.administrator).toBe(false)
        expect(report.checks).toContain(scenario === 'empty-home' ? 'fallback-home-credentials-denied' : 'both-home-credentials-denied')
        expect(report.checks).toContain('read-only-toolchain')
      })
    }
  }
  finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('Windows prepares bound workspace permissions before any task command', async ({ buddy }) => {
  test.skip(process.platform !== 'win32', 'Requires the installed Windows sandbox component')
  test.setTimeout(180_000)
  const instance = await buddy.createInstance('sandbox-binding')
  const directory = await mkdtemp(path.join(tmpdir(), 'lexora-sandbox-binding-'))
  const shell = path.join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe')
  const explicitWriters = async () => {
    const command = `$acl = Get-Acl -LiteralPath '${directory.replaceAll('\'', '\'\'')}'; $writers = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band 2) -ne 0 } | ForEach-Object { $_.IdentityReference.Value }); [Console]::Out.Write((ConvertTo-Json -InputObject $writers -Compress))`
    const { stdout } = await promisify(execFile)(shell, ['-NoLogo', '-NoProfile', '-Command', command], { windowsHide: true, timeout: 10_000 })
    return JSON.parse(stdout)
  }
  try {
    await writeFile(path.join(directory, 'before-command.txt'), 'fixture')
    const original = await explicitWriters()
    const { app, page } = await instance.launch()
    await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.runtime.getStatus()).status), { timeout: 120_000 }).toBe('ready')
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, directory)
    const space = await page.evaluate(async () => {
      const root = await window.lexoraDesktop.localChat.spaces.selectDirectory()
      return window.lexoraDesktop.localChat.spaces.create({ name: 'Sandbox binding', memoryScope: 'space_only', primaryDirectory: { id: null, root } })
    })
    await expect.poll(async () => (await explicitWriters()).filter(sid => !original.includes(sid)).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
    await page.evaluate(id => window.lexoraDesktop.localChat.spaces.delete(id), space.id)
  }
  finally {
    await instance.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

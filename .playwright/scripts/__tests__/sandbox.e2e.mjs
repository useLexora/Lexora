import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import targets from '../../../apps/buddy/platform/targets.json' with { type: 'json' }
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

const buddyRoot = path.resolve('apps/buddy')
const require = createRequire(path.join(buddyRoot, 'package.json'))

async function buildSandboxVerification(entry) {
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const mainDirectory = path.join(buddyRoot, '.output/build/electron/main')
  const chunkDirectory = path.join(mainDirectory, 'chunks')
  const processes = (await readdir(chunkDirectory)).filter(file => /^sandboxProcess-.*\.js$/.test(file))
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
        load: id => id.endsWith('?modulePath') ? `export default ${JSON.stringify(path.join(chunkDirectory, processes[0]))}` : null,
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
      const originalHome = process.env.HOME
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
        return measurements
      }
      finally {
        if (originalHome === undefined)
          delete process.env.HOME
        else
          process.env.HOME = originalHome
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

for (const workspaceKind of ['managed', 'bound']) {
  test(`Commands preserve read-only boundaries and file change history across restart (${workspaceKind})`, async ({ buddy }) => {
    test.skip(!['win32', 'linux'].includes(process.platform), 'Requires Windows or Linux sandbox resources')
    test.setTimeout(300_000)
    const shell = process.platform === 'win32' ? 'powershell' : 'bash'
    const query = process.platform === 'win32' ? 'Write-Output \'CAPTURE_QUERY\'; [Console]::Out.WriteLine(\'PROVIDER_CWD=\' + $PWD.Path); [Console]::Out.WriteLine(\'PROCESS_CWD=\' + [Environment]::CurrentDirectory)' : 'printf CAPTURE_QUERY'
    const write = (file, value) => process.platform === 'win32'
      ? `Set-Content -LiteralPath '${file}' -Value '${value}' -NoNewline -ErrorAction Stop`
      : `printf '${value}' > '${file}'`
    const cases = {
      query: [{ name: shell, arguments: { command: query, readOnly: true } }],
      denied: [{ name: shell, arguments: { command: write('forbidden.txt', 'forbidden'), readOnly: true } }],
      segments: [
        { name: 'write', arguments: { path: 'report.txt', content: 'A' } },
        { name: shell, arguments: { command: write('report.txt', 'B') } },
        { name: 'write', arguments: { path: 'report.txt', content: 'C' } },
      ],
    }
    const errors = []
    const server = createServer((request, response) => {
      void (async () => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const lastUser = body.messages.findLastIndex(message => message.role === 'user')
        const label = Object.keys(cases).find(label => JSON.stringify(body.messages[lastUser]).includes(`capture-case:${label}`))
        if (!label)
          throw new Error('Missing fixture case')
        const completed = body.messages.slice(lastUser + 1).filter(message => message.role === 'tool').length
        const next = cases[label][completed]
        if (next && !body.tools?.some(tool => tool.function.name === next.name))
          throw new Error(`Tool unavailable: ${next.name}`)
        const delta = next
          ? { tool_calls: [{ index: 0, id: `${label}-${completed}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.arguments) } }] }
          : { content: `已完成 ${label} 验证。` }
        const common = { id: `${label}-${completed}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 } })}\n\n`)
        response.end('data: [DONE]\n\n')
      })().catch((error) => {
        errors.push(String(error))
        response.writeHead(500).end('Local Provider scenario failed')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const instance = await buddy.createInstance('command-capture')
    const boundDirectory = workspaceKind === 'bound' ? await mkdtemp(path.join(tmpdir(), 'lexora-capture-workspace-')) : null
    const databasePath = path.join(instance.home, 'buddy/buddy.sqlite3')
    const queryRows = (sql, ...args) => {
      const database = new DatabaseSync(databasePath, { readOnly: true })
      try {
        return database.prepare(sql).all(...args)
      }
      finally { database.close() }
    }
    try {
      let desktop = await instance.launch()
      await useSyntheticCredentialStorage(desktop)
      let page = desktop.page
      let spaceId = null
      if (boundDirectory) {
        await desktop.app.evaluate(({ dialog }, directory) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
        }, boundDirectory)
        spaceId = await page.evaluate(async () => {
          const spaces = window.lexoraDesktop.localChat.spaces
          const root = await spaces.selectDirectory()
          return (await spaces.create({ name: 'Capture workspace', memoryScope: 'space_only', primaryDirectory: { id: null, root } })).id
        })
      }
      await page.evaluate(async (baseUrl) => {
        const api = window.lexoraDesktop.localChat
        await window.lexoraDesktop.settings.update({ runtime: { codemode: false } })
        const buddy = await api.buddies.get('default')
        await api.buddies.update({ buddyId: 'default', expectedRevision: buddy.revision, settings: { ...buddy.settings, npcTeamEnabled: false } })
        await api.providers.upsertCustom({ id: 'capture-fixture', displayName: 'Capture fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'capture-fixture', name: 'Capture fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
        const stop = api.providers.onAuthChallenge((challenge) => {
          if (challenge.providerId === 'capture-fixture' && challenge.type === 'secret')
            void api.providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
        })
        try {
          await api.providers.login('capture-fixture', 'api_key')
        }
        finally { stop() }
      }, `http://127.0.0.1:${server.address().port}/v1`)
      let previous
      async function execute(label) {
        const turn = await page.evaluate(async ({ label, previous, requestId, spaceId }) => {
          const api = window.lexoraDesktop.localChat
          const content = { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: `capture-case:${label}` }] }], panelResourceIds: [] }
          const executionConfig = { approvalPolicy: 'policy', executionProfile: 'workspace_write' }
          const modelSelection = { providerId: 'capture-fixture', modelId: 'capture-fixture', reasoning: null, serviceTier: null }
          const opened = await api.composerDrafts.open({ draftId: requestId, initialContent: content, initialExecutionConfig: executionConfig, initialModelSelection: modelSelection, scope: previous ? { kind: 'conversation_branch', conversationId: previous.conversationId, branchId: previous.branchId } : { kind: 'task', draftId: requestId, spaceId } })
          const saved = await api.composerDrafts.save({ draftId: opened.draftId, expectedRevision: opened.revision, content, executionConfig, modelSelection })
          return api.chat.startTurn({ draftId: saved.draftId, expectedRevision: saved.revision, requestId })
        }, { label, previous, requestId: randomUUID(), spaceId })
        previous = turn
        await expect.poll(() => queryRows('SELECT status FROM runs WHERE id=?', turn.runId)[0]?.status, { timeout: 90_000 }).toBe('completed')
        const events = queryRows('SELECT event_type,payload_json FROM run_events WHERE run_id=? ORDER BY rowid', turn.runId).map(row => ({ type: row.event_type, ...JSON.parse(row.payload_json) }))
        const completed = events.filter(event => event.type === 'tool.completed')
        expect(completed).toHaveLength(cases[label].length)
        if (label === 'query') {
          for (const tool of completed) {
            expect(tool.isError, JSON.stringify(tool.presentation)).toBe(false)
            expect(tool.presentation.output).toContain('CAPTURE_QUERY')
            if (process.platform === 'win32') {
              const expectedDirectory = boundDirectory ?? path.join(instance.home, 'buddy/conversations', turn.conversationId, 'workspace')
              expect(tool.presentation.output).toContain(`PROVIDER_CWD=${expectedDirectory}`)
              expect(tool.presentation.output).toContain(`PROCESS_CWD=${expectedDirectory}`)
            }
          }
        }
        if (label === 'segments') {
          for (const tool of completed)
            expect(tool.isError, JSON.stringify(tool.presentation)).toBe(false)
        }
        if (label === 'denied') {
          expect(completed[0].isError).toBe(true)
          expect(completed[0].presentation.exitCode).toBe(1)
        }
        expect(queryRows('SELECT * FROM run_mutation_leases WHERE run_id=? AND status<>\'released\'', turn.runId)).toEqual([])
        return turn
      }
      const first = await execute('query')
      const workspace = boundDirectory ?? path.join(instance.home, 'buddy/conversations', first.conversationId, 'workspace')
      expect(queryRows('SELECT * FROM run_file_change_captures')).toEqual([])
      expect(queryRows('SELECT * FROM run_change_sets WHERE run_id=?', first.runId)).toEqual([])
      await execute('denied')
      await expect(access(path.join(workspace, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      const segments = await execute('segments')
      expect(await readFile(path.join(workspace, 'report.txt'), 'utf8')).toBe('C')
      expect(queryRows('SELECT capture_mode FROM run_change_invocations WHERE run_id=? ORDER BY sequence', segments.runId)).toEqual([{ capture_mode: 'files' }, { capture_mode: 'untracked' }, { capture_mode: 'files' }])
      const captures = queryRows('SELECT before_snapshot_path,after_snapshot_path FROM run_file_change_captures ORDER BY sequence')
      expect(captures).toHaveLength(2)
      expect(await readFile(captures[0].after_snapshot_path, 'utf8')).toBe('A')
      expect(await readFile(captures[1].before_snapshot_path, 'utf8')).toBe('B')
      expect(await readFile(captures[1].after_snapshot_path, 'utf8')).toBe('C')
      expect(queryRows('SELECT coverage,coverage_reasons_json,file_count FROM run_change_sets WHERE run_id=?', segments.runId)).toEqual([{ coverage: 'partial', coverage_reasons_json: '["untracked"]', file_count: 2 }])
      await page.locator(`[data-task-id="${first.conversationId}"] .desktop-task-sidebar__task`).click()
      await expect(page.locator('.buddy-chat-turn-changes').last()).toHaveText('已记录 2 处文件修改')
      await page.locator('.buddy-chat-turn-changes').last().click()
      await expect(page.locator('.context-change-list [data-change-id]')).toHaveCount(2)
      expect(errors).toEqual([])
      expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
      await page.evaluate(() => window.lexoraDesktop.localChat.providers.clearCredential('capture-fixture'))
      await instance.stop()
      desktop = await instance.launch()
      page = desktop.page
      await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.runtime.getStatus()).status), { timeout: 45000 }).toBe('ready')
      await page.locator(`[data-task-id="${first.conversationId}"] .desktop-task-sidebar__task`).click()
      await expect(page.locator('.buddy-chat-turn-changes').last()).toHaveText('已记录 2 处文件修改')
      expect(await readFile(path.join(workspace, 'report.txt'), 'utf8')).toBe('C')
    }
    finally {
      await instance.stop()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      if (boundDirectory)
        await rm(boundDirectory, { recursive: true, force: true })
    }
  })
}

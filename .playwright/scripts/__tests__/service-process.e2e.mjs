import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile, fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, isBuiltin } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const buddyRoot = path.join(root, 'apps/buddy')
const requireBuddy = createRequire(path.join(buddyRoot, 'package.json'))

test('standalone Node artifact keeps accepted work across client disconnect and service restart', async () => {
  const testInfo = test.info()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lexora-service-process-'))
  const candidate = path.join(directory, 'candidate')
  const coreHome = path.join(directory, 'profile')
  const work = path.join(directory, 'work')
  const file = path.join(work, 'fixture.txt')
  const report = { requests: [], results: {} }
  const source = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, TEMP: directory, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC }
  const children = []
  let finishStream
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(request.headers.authorization, 'Bearer process-fixture-key')
      const user = JSON.stringify(payload.messages.findLast(message => message.role === 'user'))
      const toolResult = payload.messages.findLast(message => message.role === 'tool')
      const mode = user.includes('FIXTURE_FILE') ? 'file' : user.includes('FIXTURE_STREAM') ? 'stream' : 'text'
      report.requests.push({ mode, toolReadMatched: Boolean(toolResult && JSON.stringify(toolResult).includes('isolated-node-file')) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const common = { id: randomUUID(), model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      const send = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
      send({ role: 'assistant', content: '' })
      if (mode === 'stream') {
        send({ content: 'fixture-stream-started' })
        finishStream = () => {
          send({}, 'stop')
          response.end('data: [DONE]\n\n')
        }
        return
      }
      if (mode === 'file' && !toolResult) {
        send({ tool_calls: [{ index: 0, id: 'fixture-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] })
        send({}, 'tool_calls')
      }
      else {
        send({ content: mode === 'file' ? 'fixture-file-ok' : 'fixture-text-ok' })
        send({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    })().catch((error) => {
      report.serverError = error.message
      response.writeHead(500)
      response.end('Fixture failed')
    })
  })
  try {
    await fs.cp(path.join(buddyRoot, '.output/build/service'), candidate, { recursive: true, verbatimSymlinks: true })
    await fs.mkdir(work)
    await fs.writeFile(file, 'isolated-node-file\n')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    report.closure = await auditCandidate(candidate)
    const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'resources.json'), 'utf8'))
    for (const resource of [...manifest.bundled, ...manifest.resources])
      expect(await hashFile(path.join(candidate, resource.path)), resource.path).toBe(resource.sha256)
    const runtime = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node')
    await fs.copyFile(process.execPath, runtime)
    await fs.chmod(runtime, 0o700)
    const inventory = await execute(runtime, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      import { DatabaseSync } from 'node:sqlite';
      const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
      const photon = require('@silvia-odwyer/photon-node');
      const image = new photon.PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
      const db = new DatabaseSync(':memory:');
      console.log(JSON.stringify({ versions: process.versions, execPath: process.execPath, sqlite: db.prepare('select sqlite_version() as version').get(), wasm: { width: image.get_width(), height: image.get_height() }, modules: [require.resolve('@silvia-odwyer/photon-node'), import.meta.resolve('unpdf')] }));
      image.free(); db.close(); await import('unpdf');
    `], { cwd: candidate, env: source })
    report.inventory = JSON.parse(inventory.stdout)
    expect(report.inventory.versions.electron).toBeUndefined()
    expect(report.inventory.execPath).toBe(runtime)
    expect(report.inventory.wasm).toEqual({ width: 1, height: 1 })
    for (const module of report.inventory.modules) {
      const resolved = module.startsWith('file:') ? fileURLToPath(module) : module
      expect(path.relative(candidate, resolved).startsWith('..'), module).toBe(false)
    }
    const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
    await build({ configFile: false, logLevel: 'error', build: {
      ssr: path.join(root, '.playwright/scripts/fixtures/service-process-harness.ts'),
      outDir: path.join(directory, 'harness'),
      target: 'node26',
      rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'harness.mjs', format: 'es' } },
    } })
    const { RuntimeRpcPeer, createBuddyServiceEnvironment, BUDDY_SERVICE_PROTOCOL_VERSION, DEFAULT_RUNTIME_PREFERENCES, registerFixtureHost } = await import(pathToFileURL(path.join(directory, 'harness/harness.mjs')).href)
    function startCore(resourcesRoot = path.join(candidate, 'resources')) {
      const child = fork(path.join(candidate, 'service.mjs'), [], { execPath: runtime, execArgv: [], cwd: work, env: createBuddyServiceEnvironment(source, coreHome), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      children.push(child)
      let stderr = ''
      child.stderr.on('data', (value) => {
        stderr = `${stderr}${value}`.slice(-32768)
      })
      child.stdout.resume()
      const messages = []
      child.on('message', message => messages.push(message))
      const peers = new Map()
      function channel(id) {
        const peer = new RuntimeRpcPeer({ transport: { postMessage: message => child.send({ type: 'rpc', channel: id, message }), subscribe(listener) {
          const receive = (message) => {
            if (message.type === 'rpc' && message.channel === id)
              listener(message.message)
          }
          child.on('message', receive)
          return () => child.off('message', receive)
        } } })
        peers.set(id, peer)
        return peer
      }
      registerFixtureHost(channel('host'))
      const exited = new Promise(resolve => child.once('exit', (code, signal) => {
        for (const peer of peers.values()) peer.close(new Error('Service exited'))
        resolve({ code, signal, stderr })
      }))
      const connect = (id, role) => {
        const peer = channel(id)
        child.send({ type: 'connect', channel: id, role })
        return peer
      }
      child.send({ type: 'connect', channel: 'too-early', role: 'product' })
      child.send({ type: 'start', protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION, config: { profile: 'test', buddyHome: coreHome, resourcesRoot, proxy: { httpProxy: '', httpsProxy: '', noProxy: '' }, preferences: { ...DEFAULT_RUNTIME_PREFERENCES, codemode: 'off', modelRetryLimit: 0 }, display: false } })
      return {
        child,
        messages,
        connect,
        exited,
        async ready() {
          await expect.poll(() => messages.find(message => ['ready', 'failed'].includes(message.type)), { timeout: 30000 }).toBeTruthy()
          expect(messages.find(message => ['ready', 'failed'].includes(message.type)), stderr).toEqual({ type: 'ready', protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION })
        },
        close(id) {
          child.send({ type: 'disconnect', channel: id })
          peers.get(id)?.close(new Error('Client disconnected'))
        },
      }
    }
    let core = startCore(path.join(candidate, 'missing'))
    report.results.missingResources = await core.exited
    expect(report.results.missingResources.code).toBe(1)
    await expect(fs.stat(path.join(coreHome, 'buddy.sqlite3'))).rejects.toThrow()
    core = startCore()
    await core.ready()
    expect(core.messages).toContainEqual({ type: 'rejected', channel: 'too-early', code: 'SERVICE_NOT_READY' })
    const management = core.connect('management', 'management')
    let product = core.connect('first', 'product')
    const second = core.connect('second', 'product')
    await expect(management.request('runtime.status', {})).resolves.toMatchObject({ ready: true })
    await expect(product.request('runtime.shutdown', {})).rejects.toMatchObject({ code: -32601 })
    await expect(product.request('extensions.agent.request', {})).rejects.toMatchObject({ code: -32601 })
    await expect(product.request('providers.upsertCustom', {})).rejects.toMatchObject({ code: -32601 })
    await management.request('providers.upsertCustom', { id: 'process-fixture', displayName: 'Isolated process fixture', api: 'openai-completions', baseUrl: `${baseUrl}/v1`, enabled: true, models: [{ id: 'fixture-model', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
    const space = await management.request('spaces.create', { name: 'Isolated workspace', memoryScope: 'space_only', primaryDirectory: { id: null, root: work }, primaryDirectorySelectionVerified: true })
    report.results.search = await product.request('spaces.searchFiles', { spaceId: space.id, query: 'fixture', deepSearch: true })
    expect(report.results.search.some(entry => entry.path === 'fixture.txt' || entry.path === file)).toBe(true)
    report.results.nativeRead = await management.request('spaceFiles.readDocument', { spaceId: space.id, directoryId: space.primaryDirectory.id, revision: space.primaryDirectory.revision, path: 'fixture.txt' })
    expect(report.results.nativeRead.text).toBe('isolated-node-file\n')
    async function startTask(text) {
      const draftId = randomUUID()
      const content = { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text }] }], panelResourceIds: [] }
      const executionConfig = { approvalPolicy: 'policy', executionProfile: 'workspace_write' }
      const modelSelection = { providerId: 'process-fixture', modelId: 'fixture-model', reasoning: null, serviceTier: null }
      const opened = await product.request('composerDrafts.open', { draftId, scope: { kind: 'task', draftId, spaceId: space.id }, initialContent: content, initialExecutionConfig: executionConfig, initialModelSelection: modelSelection })
      const draft = await product.request('composerDrafts.save', { draftId: opened.draftId, expectedRevision: opened.revision, content, executionConfig, modelSelection })
      return product.request('chat.startTurn', { draftId: draft.draftId, expectedRevision: draft.revision, requestId: randomUUID() })
    }
    async function terminal(runId) {
      let result
      await expect.poll(async () => {
        result = await product.request('runs.get', { runId })
        return result.status
      }, { timeout: 30000 }).toMatch(/^(?:completed|cancelled|failed)$/)
      expect(result.status, JSON.stringify(result)).toBe('completed')
      return result
    }
    report.results.text = await terminal((await startTask('FIXTURE_TEXT')).runId)
    report.results.file = await terminal((await startTask('FIXTURE_FILE')).runId)
    expect(report.requests.some(value => value.toolReadMatched)).toBe(true)
    const continued = await startTask('FIXTURE_STREAM')
    await expect.poll(() => Boolean(finishStream)).toBe(true)
    await expect(management.request('runtime.shutdown', { onlyIfIdle: true })).resolves.toEqual({ accepted: false })
    core.close('first')
    product = second
    await expect(second.request('runs.get', { runId: continued.runId })).resolves.toMatchObject({ status: 'running' })
    finishStream()
    report.results.disconnected = await terminal(continued.runId)
    const third = core.connect('third', 'product')
    core.child.send({ type: 'rpc', channel: 'second', message: { invalid: true } })
    await expect(third.request('runs.get', { runId: continued.runId })).resolves.toMatchObject({ status: 'completed' })
    core.child.send({ type: 'connect', channel: 'first', role: 'product' })
    await expect.poll(() => core.messages.find(message => message.type === 'rejected' && message.channel === 'first')).toEqual({ type: 'rejected', channel: 'first', code: 'SERVICE_CHANNEL_EXISTS' })
    report.results.requestCount = report.requests.length
    await expect(management.request('runtime.shutdown', {})).resolves.toEqual({ accepted: true })
    report.results.stopped = await core.exited
    expect(report.results.stopped.code).toBe(0)
    core = startCore()
    await core.ready()
    const restored = core.connect('restored', 'product')
    const admin = core.connect('admin', 'management')
    await expect(restored.request('runs.list', {})).resolves.toHaveLength(3)
    await expect(restored.request('runs.get', { runId: continued.runId })).resolves.toMatchObject({ status: 'completed' })
    expect(report.requests.length).toBe(report.results.requestCount)
    await expect(admin.request('runtime.shutdown', { onlyIfIdle: true })).resolves.toEqual({ accepted: true })
    expect((await core.exited).code).toBe(0)
    core = startCore()
    await core.ready()
    core.child.disconnect()
    report.results.ownerDisconnected = await core.exited
    expect(report.results.ownerDisconnected.code).toBe(1)
    expect(report.serverError).toBeUndefined()
  }
  finally {
    finishStream?.()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null)
        continue
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), delay(5000)])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const reportPath = testInfo.outputPath('service-process.json')
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    await testInfo.attach('service-process.json', { path: reportPath, contentType: 'application/json' })
    await fs.rm(directory, { recursive: true, force: true })
  }
})

async function hashFile(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function auditCandidate(root) {
  let files = 0
  let symlinks = 0
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile())
      files++
    if (!entry.isSymbolicLink())
      continue
    symlinks++
    const resolved = await fs.realpath(path.join(entry.parentPath, entry.name))
    const relative = path.relative(root, resolved)
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Artifact symlink must stay inside the service package')
  }
  expect(files).toBeGreaterThan(0)
  expect(symlinks).toBeGreaterThan(0)
  return { files, symlinks }
}

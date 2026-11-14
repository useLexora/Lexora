import { Buffer } from 'node:buffer'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, isBuiltin } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function main() {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const buddy = path.join(root, 'apps/buddy')
  const requireBuddy = createRequire(path.join(buddy, 'package.json'))
  const keep = Boolean(process.env.LEXORA_FIXTURE_DIRECTORY)
  const directory = keep ? path.resolve(process.env.LEXORA_FIXTURE_DIRECTORY) : await fs.mkdtemp(path.join(os.tmpdir(), 'lexora-native-network-'))
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const profile = path.join(directory, 'profile')
  const qrPath = path.join(directory, 'pairing.json')
  const endpointPath = path.join(directory, 'connection.json')
  const port = Number(process.env.LEXORA_FIXTURE_PORT ?? 19443)
  const candidate = process.env.LEXORA_FIXTURE_SERVICE ? path.resolve(process.env.LEXORA_FIXTURE_SERVICE) : path.join(buddy, '.output/build/service')
  const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
  await build({ configFile: false, logLevel: 'error', build: { ssr: path.join(root, '.playwright/scripts/fixtures/service-process-harness.ts'), outDir: path.join(directory, 'harness'), target: 'node26', rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'harness.mjs', format: 'es' } } } })
  const { RuntimeRpcPeer, createBuddyServiceEnvironment, BUDDY_SERVICE_PROTOCOL_VERSION, DEFAULT_RUNTIME_PREFERENCES, registerFixtureHost, createCandidateFixtureDatabase } = await import(pathToFileURL(path.join(directory, 'harness/harness.mjs')).href)
  await fs.mkdir(profile, { recursive: true, mode: 0o700 })
  createCandidateFixtureDatabase(path.join(profile, 'buddy.sqlite3'))
  const provider = createServer((request, response) => {
    void (async () => {
      let size = 0
      const chunks = []
      for await (const chunk of request) {
        size += chunk.byteLength
        chunks.push(chunk)
        if (size > 1_048_576)
          throw new Error('Fixture request exceeds limit')
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const approval = JSON.stringify(body.messages).includes('Android approval verification') && !body.messages.some(message => message.role === 'tool')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'native-fixture', model: 'fixture-model', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: approval ? { role: 'assistant', tool_calls: [{ index: 0, id: 'mobile-approval-call', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'mobile-approval.txt', content: JSON.stringify(body.messages).includes('large approval document') ? '中😀'.repeat(30000) : 'Isolated Android approval fixture' }) } }] } : { role: 'assistant', content: '隔离服务已收到输入。你好，Android。😀' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'native-fixture', model: 'fixture-model', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: {}, finish_reason: approval ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const child = fork(path.join(candidate, 'service.mjs'), [], { execArgv: [], cwd: directory, env: createBuddyServiceEnvironment({ PATH: process.env.PATH, HOME: directory, TMPDIR: directory, TEMP: directory, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC }, profile), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
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
  const secretsPath = path.join(directory, 'synthetic-secrets.json')
  let secrets
  try {
    secrets = new Map(JSON.parse(await fs.readFile(secretsPath, 'utf8')))
  }
  catch (error) {
    if (error.code !== 'ENOENT')
      throw error
    secrets = new Map()
  }
  registerFixtureHost(channel('host'), { secrets, persistSecrets: async () => {
    const temporary = `${secretsPath}.part`
    await fs.writeFile(temporary, JSON.stringify([...secrets]), { mode: 0o600, flush: true })
    await fs.rename(temporary, secretsPath)
  } })
  let stopped = false
  async function stop() {
    if (stopped)
      return
    stopped = true
    const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve()
    child.kill('SIGTERM')
    await exited
    for (const peer of peers.values()) peer.close(new Error('Fixture stopped'))
    provider.closeAllConnections()
    provider.close()
    if (!keep)
      await fs.rm(directory, { recursive: true, force: true })
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
  child.once('exit', () => void stop())
  child.stderr.on('data', value => process.stderr.write(value))
  const ready = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message.type === 'ready')
        resolve()
      if (message.type === 'failed')
        reject(new Error(message.code))
    })
    child.once('exit', () => reject(new Error('Fixture service exited before ready')))
  })
  child.send({ type: 'start', protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION, config: { profile: 'test', buddyHome: profile, resourcesRoot: path.join(candidate, 'resources'), storageAuthority: 'sqlite', proxy: { httpProxy: '', httpsProxy: '', noProxy: '' }, preferences: { ...DEFAULT_RUNTIME_PREFERENCES, cacheWarming: 'off', codemode: 'off', modelRetryLimit: 0 }, display: false } })
  await ready
  const management = channel('management')
  child.send({ type: 'connect', channel: 'management', role: 'management' })
  await management.request('providers.upsertCustom', { id: 'process-fixture', displayName: 'Isolated Android fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, enabled: true, models: [{ id: 'fixture-model', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
  const product = channel('product')
  child.send({ type: 'connect', channel: 'product', role: 'product' })
  const spaces = await product.request('spaces.list', {})
  if (!spaces.some(space => space.name === 'Android verification'))
    await management.request('spaces.create', { name: 'Android verification', memoryScope: 'space_only', primaryDirectory: null, primaryDirectorySelectionVerified: false })
  let status = await management.request('privateNetwork.configure', { enabled: true, bindAddress: '127.0.0.1', port })
  if (process.env.LEXORA_FIXTURE_RESET_TLS === '1')
    status = await management.request('privateNetwork.resetIdentity', {})
  if (status.state !== 'listening')
    throw new Error(`Fixture listener failed: ${status.errorCode}`)
  await fs.writeFile(endpointPath, JSON.stringify(status), { mode: 0o600 })
  async function issue() {
    const qr = await management.request('privateNetwork.issuePairing', {})
    await fs.writeFile(qrPath, JSON.stringify(qr), { mode: 0o600 })
    process.stdout.write(`${JSON.stringify({ endpoint: status.endpoint, qrPath, endpointPath, fixture: directory })}\n`)
  }
  await issue()
  process.on('SIGUSR1', () => void issue())
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'FIXTURE_FAILED'}\n`)
    process.exitCode = 1
  })
}

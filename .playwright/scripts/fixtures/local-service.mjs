import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { chromium, expect } from '@playwright/test'

export async function connectLocalService(discovery, secret, role = 'management') {
  const socket = net.createConnection(role === 'product' ? discovery.productEndpoint : discovery.managementEndpoint)
  const rpc = createRequests(frame => socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`), randomUUID)
  let buffer = ''
  let welcome
  const ready = new Promise((resolve, reject) => {
    welcome = { resolve, reject }
  })
  socket.on('error', (error) => {
    welcome.reject(error)
    rpc.reject(error)
  })
  socket.on('close', () => {
    const error = new Error('SERVICE_CLOSED')
    welcome.reject(error)
    rpc.reject(error)
  })
  socket.on('data', (chunk) => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n')
      const frame = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (frame.type === 'welcome')
        welcome.resolve(frame)
      else rpc.receive(frame)
    }
  })
  const { protocol, profileId, serviceInstanceId, buildId, sessionId, userId } = discovery
  socket.write(`${JSON.stringify({ protocol, profileId, serviceInstanceId, buildId, sessionId, userId, type: 'hello', role, secret })}\n`)
  try {
    expect(await ready).toMatchObject({ serviceInstanceId, buildId, sessionId, userId })
    return { request: rpc.request, close: () => socket.destroy() }
  }
  catch (error) {
    socket.destroy()
    throw error
  }
}

export async function launchDaemonDesktop({ home, buddyRoot, hostExecutable, hostArguments, environment, artifactDirectory }) {
  assert.equal(process.platform, 'linux', 'Daemon Desktop fixture currently requires Linux')
  assert.equal(environment.LEXORA_BUDDY_PROFILE, 'test')
  environment = { ...environment, XDG_SESSION_ID: process.env.XDG_SESSION_ID }
  const output = path.join(buddyRoot, '.output')
  const release = await readJson(path.join(output, 'release-set.json'))
  const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const runtimeDirectory = path.join(home, '.runtime')
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  const config = {
    version: 1,
    profile: 'test',
    profileRoot: home,
    resourcesRoot: path.join(output, path.dirname(release.core.entry), 'resources'),
    nodeExecutable: path.join(output, release.node.entry),
    coreEntry: path.join(output, release.core.entry),
    hostExecutable,
    hostArguments: [...hostArguments, '--inspect=127.0.0.1:0', '--remote-debugging-port=0', buddyRoot],
    releaseSetPath: path.join(output, 'release-set.json'),
    buildId: release.buildId,
    sessionId: `${boot}:${process.env.XDG_SESSION_ID}`,
    userId: String(process.getuid()),
    leaseDirectory: path.join(path.dirname(home), '.leases'),
    storageAuthority: 'sqlite',
  }
  const launchFile = path.join(runtimeDirectory, 'launch.json')
  await fs.writeFile(launchFile, JSON.stringify(config), { mode: 0o600 })
  const core = spawn(config.nodeExecutable, [config.coreEntry, '--config', launchFile], { cwd: buddyRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  for (const stream of [core.stdout, core.stderr]) {
    stream.on('data', (chunk) => {
      log = `${log}${chunk}`.slice(-1024 * 1024)
    })
  }
  let browser
  let inspector
  let client
  let hostPid
  const stopped = once(core, 'exit')
  const close = async () => {
    await inspector?.close()
    await browser?.close().catch(() => {})
    try {
      if (core.exitCode === null && core.signalCode === null) {
        const discovery = await readJson(path.join(runtimeDirectory, 'service.json'))
        if (client && discovery)
          await client.request('service.stop', { expectedServiceInstanceId: discovery.serviceInstanceId, commandId: randomUUID(), reason: 'explicit' }).catch(() => {})
        else core.kill('SIGTERM')
        await expect.poll(() => core.exitCode !== null || core.signalCode !== null, { timeout: 20000 }).toBe(true)
      }
      await stopped
      if (hostPid)
        await expect.poll(() => processAlive(hostPid)).toBe(false)
    }
    finally {
      client?.close()
      if (core.exitCode === null && core.signalCode === null)
        core.kill('SIGTERM')
      await fs.writeFile(path.join(artifactDirectory, 'daemon.log'), log, { mode: 0o600 })
    }
  }
  try {
    await expect.poll(async () => {
      assert(core.exitCode === null && core.signalCode === null, `Node service exited: ${log}`)
      return (await readJson(path.join(runtimeDirectory, 'service.json')))?.phase
    }, { timeout: 120000 }).toBe('ready')
    const discovery = await readJson(path.join(runtimeDirectory, 'service.json'))
    expect(discovery.process.pid).toBe(core.pid)
    expect(await fs.realpath(`/proc/${core.pid}/exe`)).toBe(await fs.realpath(config.nodeExecutable))
    const credentials = await readJson(path.join(runtimeDirectory, 'local-client.json'))
    client = await connectLocalService(discovery, credentials.managementSecret)
    await expect.poll(() => /DevTools listening on ws:\/\/\S+/.test(log)).toBe(true)
    browser = await chromium.connectOverCDP(log.match(/DevTools listening on (ws:\/\/\S+)/)[1])
    await expect.poll(() => /Debugger listening on ws:\/\/\S+/.test(log)).toBe(true)
    inspector = await connectInspector(log.match(/Debugger listening on (ws:\/\/\S+)/)[1])
    hostPid = await inspector.evaluate(() => process.pid)
    expect(hostPid).not.toBe(core.pid)
    const opened = await client.request('service.openDesktop', { expectedServiceInstanceId: discovery.serviceInstanceId, intent: { kind: 'tasks' } })
    expect(opened).toMatchObject({ accepted: true, uiReady: true, targetVisible: true, visible: true })
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('lexora-app:'))
    assert(page, 'Service did not open Desktop')
    await fs.writeFile(path.join(artifactDirectory, 'daemon.json'), JSON.stringify({ corePid: core.pid, hostPid, buildId: release.buildId, nodeExecutable: config.nodeExecutable }, null, 2))
    return { serviceMode: 'daemon', context: () => page.context(), firstWindow: async () => page, process: () => core, evaluate: inspector.evaluate, detachMain: () => inspector.close(), close }
  }
  catch (error) {
    await close()
    throw error
  }
}

async function connectInspector(endpoint) {
  const socket = new WebSocket(endpoint)
  const rpc = createRequests(frame => socket.send(JSON.stringify(frame)))
  socket.addEventListener('message', event => rpc.receive(JSON.parse(event.data)))
  socket.addEventListener('close', () => rpc.reject(new Error('INSPECTOR_CLOSED')))
  await once(socket, 'open')
  return {
    async evaluate(callback, argument) {
      const result = await rpc.request('Runtime.evaluate', { expression: `(${callback.toString()})(process.mainModule.require('electron'), ${JSON.stringify(argument) ?? 'undefined'})`, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN) {
        const closed = once(socket, 'close')
        socket.close()
        await closed
      }
    },
  }
}

function createRequests(send, nextId) {
  const pending = new Map()
  let sequence = 0
  return {
    request(method, params) {
      const id = nextId ? nextId() : ++sequence
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Request timed out: ${method}`))
        }, 45000)
        pending.set(id, { resolve, reject, timeout })
        send({ id, method, params })
      })
    },
    receive(frame) {
      const request = pending.get(frame.id)
      if (!request)
        return
      pending.delete(frame.id)
      clearTimeout(request.timeout)
      if (frame.error)
        request.reject(new Error(frame.error.message))
      else request.resolve(frame.result)
    },
    reject(error) {
      for (const request of pending.values()) {
        clearTimeout(request.timeout)
        request.reject(error)
      }
      pending.clear()
    },
  }
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  }
  catch (error) {
    if (error.code === 'ENOENT')
      return null
    throw error
  }
}

export async function processAlive(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
  return stat !== null && !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])
}

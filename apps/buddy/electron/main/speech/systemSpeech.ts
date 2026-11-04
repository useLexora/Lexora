import type { NetConnectOpts } from 'node:net'
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { currentPlatform } from '../../../platform/currentPlatform'

const execute = promisify(execFile)

function speechDispatcherAddress() {
  const [method = 'unix_socket', address, port = '6560'] = process.env.SPEECHD_ADDRESS?.split(':') ?? []
  if (method === 'unix_socket') {
    const runtime = process.env.XDG_RUNTIME_DIR || process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
    const path = address || join(runtime, 'speech-dispatcher', 'speechd.sock')
    return { connection: { path }, args: ['--communication-method', method, '--socket-path', path], local: true }
  }
  if (method === 'inet_socket' && /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535) {
    const host = address || '127.0.0.1'
    return { connection: { host, port: Number(port) }, args: ['--communication-method', method, '--port', port], local: host === 'localhost' || host.startsWith('127.') }
  }
  return undefined
}

function canConnect(options: NetConnectOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(options)
    const settle = (available: boolean) => {
      socket.destroy()
      resolve(available)
    }
    socket.setTimeout(1000, () => settle(false))
    socket.once('error', () => settle(false))
    socket.once('connect', () => settle(true))
  })
}

export async function prepareSystemSpeech(): Promise<boolean> {
  if (currentPlatform.id !== 'linux')
    return true
  const endpoint = speechDispatcherAddress()
  if (!endpoint)
    return false
  if (await canConnect(endpoint.connection))
    return true
  if (!endpoint.local)
    return false
  try {
    await execute(process.env.SPEECHD_CMD || 'speech-dispatcher', ['--spawn', ...endpoint.args], { timeout: 5000, maxBuffer: 64 * 1024 })
  }
  catch {
    return canConnect(endpoint.connection)
  }
  return canConnect(endpoint.connection)
}

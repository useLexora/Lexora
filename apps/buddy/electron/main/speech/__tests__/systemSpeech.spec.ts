import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareSystemSpeech } from '../systemSpeech'

const { start } = vi.hoisted(() => ({ start: vi.fn<() => Promise<void>>() }))
vi.mock('node:child_process', () => ({
  execFile: (_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    void start().then(() => callback(null, '', ''), error => callback(error))
  },
}))
const cleanups: (() => Promise<void>)[] = []
let socketPath: string
beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-speech-'))
  socketPath = join(directory, 'speech.sock')
  vi.stubEnv('SPEECHD_ADDRESS', `unix_socket:${socketPath}`)
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  start.mockRejectedValue(new Error('ENOENT'))
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
  start.mockReset()
})
async function serve() {
  const server = createServer(socket => socket.end())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
}
const linuxTest = it.skipIf(process.platform !== 'linux')

linuxTest('accepts a running service even if its executable is unavailable', async () => {
  await serve()
  expect(await prepareSystemSpeech()).toBe(true)
})

linuxTest('requires a reachable service after a successful spawn', async () => {
  start.mockResolvedValue(undefined)
  expect(await prepareSystemSpeech()).toBe(false)
  start.mockImplementation(serve)
  expect(await prepareSystemSpeech()).toBe(true)
})

linuxTest('accepts a service that started concurrently despite a spawn error', async () => {
  start.mockImplementation(async () => {
    await serve()
    throw new Error('Already running')
  })
  expect(await prepareSystemSpeech()).toBe(true)
})

linuxTest('rejects unsupported addresses without changing system configuration', async () => {
  vi.stubEnv('SPEECHD_ADDRESS', 'inet_socket:localhost:invalid')
  expect(await prepareSystemSpeech()).toBe(false)
  vi.stubEnv('SPEECHD_ADDRESS', 'unknown:address')
  expect(await prepareSystemSpeech()).toBe(false)
})

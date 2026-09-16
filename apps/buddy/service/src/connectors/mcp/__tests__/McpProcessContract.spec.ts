import type { McpClientSessionOptions } from '../McpClientSession'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuddyServiceEnvironment } from '../../../../../electron/main/runtime/buddyServiceEnvironment'
import { McpClientSession } from '../McpClientSession'

const fixtureServer = fileURLToPath(new URL('./fixtures/process-contract-server.mjs', import.meta.url))
const sessions: McpClientSession[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('mCP real stdio process contract', () => {
  it('preserves platform runtime inputs across Service and MCP boundaries without ambient secrets', async () => {
    const environment = createBuddyServiceEnvironment({
      LANG: 'zh_CN.UTF-8',
      XDG_CONFIG_HOME: '/fixture/config',
      https_proxy: 'http://127.0.0.1:18080',
    }, '/fixture/buddy')
    for (const [key, value] of Object.entries(environment))
      vi.stubEnv(key, value)
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-secret')
    vi.stubEnv('PI_TOOLS_DIR', '/fixture/bundled-tools')
    const session = createSession({ credential: { type: 'stdio', env: { MCP_TOKEN: 'synthetic-connector-token', https_proxy: 'http://override.invalid:1', NODE_USE_ENV_PROXY: '0', NO_PROXY: '*' } } })
    const runtime = await readRuntime(session)
    expect(runtime.environment).toEqual({
      LANG: 'zh_CN.UTF-8',
      XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME ?? null,
      https_proxy: 'http://127.0.0.1:18080',
      MCP_TOKEN: 'synthetic-connector-token',
      OPENAI_API_KEY: null,
      LEXORA_BUDDY_HOME: null,
      PI_CODING_AGENT_DIR: null,
      PI_TOOLS_DIR: null,
    })
  })

  it('passes cwd and argument boundaries literally, including Chinese, spaces and shell characters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy MCP 空格-'))
    directories.push(directory)
    const argv = ['你好 世界', 'quote"value', 'semi;colon', 'a&b']
    const session = createSession({ args: argv, cwd: directory })
    expect(await readRuntime(session)).toMatchObject({ argv, cwd: directory })
    await expect(session.callTool('echo', { text: '中文输出' }))
      .resolves
      .toMatchObject({ content: [{ type: 'text', text: '中文输出' }] })
  })

  it('keeps protocol responses flowing when the server writes more than a pipe buffer to stderr', async () => {
    const session = createSession()
    await session.connect()
    await expect(session.callTool('stderr', {}, AbortSignal.timeout(1500)))
      .resolves
      .toMatchObject({ content: [{ type: 'text', text: 'stderr complete' }] })
  })

  it('waits for the process to exit for every concurrent close caller', async () => {
    const session = createSession()
    const { pid } = await readRuntime(session)
    const first = session.close()
    const second = session.close()
    await second
    expect(isProcessAlive(pid)).toBe(false)
    await first
  })

  it('cancels a request without discarding the reusable connection', async () => {
    const session = createSession()
    const { pid } = await readRuntime(session)
    await expect(session.callTool('hold', {}, AbortSignal.timeout(100))).rejects.toBeDefined()
    expect((await readRuntime(session)).pid).toBe(pid)
  })

  it('reaps a process before reporting an initialization failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-mcp-failure-'))
    directories.push(directory)
    const pidFile = join(directory, 'pid')
    const session = createSession({ args: ['--fail-handshake', `--pid-file=${pidFile}`] })
    await expect(session.connect()).rejects.toMatchObject({ code: 'MCP_SERVER_UNAVAILABLE' })
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(isProcessAlive(pid)).toBe(false)
  })

  it('rejects pending calls on close and never reconnects a closed session', async () => {
    const session = createSession()
    const { pid } = await readRuntime(session)
    const pending = session.callTool('hold', {}).catch(error => error)
    await session.close()
    expect(await pending).toMatchObject({ code: 'MCP_SERVER_UNAVAILABLE' })
    expect(isProcessAlive(pid)).toBe(false)
    await expect(session.connect()).rejects.toMatchObject({ code: 'MCP_SERVER_UNAVAILABLE' })
  })
})

function createSession(options: { args?: string[], cwd?: string | null, credential?: McpClientSessionOptions['credential'] } = {}) {
  const session = new McpClientSession({
    config: {
      args: [fixtureServer, ...options.args ?? []],
      command: process.execPath,
      credentialRef: null,
      cwd: options.cwd ?? null,
      enabled: true,
      id: 'process-fixture',
      name: 'Process fixture',
      transport: 'stdio',
    },
    credential: options.credential ?? null,
  })
  sessions.push(session)
  return session
}

async function readRuntime(session: McpClientSession) {
  const result = await session.callTool('runtime', {}) as { content: [{ type: 'text', text: string }] }
  return JSON.parse(result.content[0].text) as {
    argv: string[]
    cwd: string
    environment: Record<string, string | null>
    pid: number
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH')
      return false
    throw error
  }
}

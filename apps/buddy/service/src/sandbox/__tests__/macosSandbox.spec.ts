import type { SandboxProcessInput } from '../../../../shared/permissions/shellSandbox'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSandboxEnvironment } from '../../../../platform/process/sandboxEnvironment'
import { runSrtSandbox } from '../backends/srt/runSrtSandbox'
import { runSandboxCommand } from '../runSandboxCommand'

const buddyRoot = process.cwd()
const environment = { ...process.env }
const home = homedir()
const quote = (value: string) => `'${value.replaceAll('\'', '\'\\\'\'')}'`

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('macOS shell isolation', () => {
  let directory: string
  let workspace: string
  let outside: string
  let input: SandboxProcessInput

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lexora-macos-sandbox-')))
    workspace = join(directory, 'workspace')
    outside = join(directory, 'outside')
    const privateRoot = join(directory, 'private')
    await Promise.all([workspace, outside, join(privateRoot, 'home'), join(privateRoot, 'tmp')].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(outside, 'preserved'), 'outside-preserved')
    const isolatedEnvironment = createSandboxEnvironment(environment, privateRoot)
    for (const key of new Set([...Object.keys(process.env), ...Object.keys(isolatedEnvironment)]))
      vi.stubEnv(key, isolatedEnvironment[key])
    process.chdir(privateRoot)
    input = {
      command: '',
      requestId: randomUUID(),
      timeout: 5,
      cwd: workspace,
      home,
      path: environment.PATH ?? '',
      privateRoot,
      protectedRoots: [],
      roots: [workspace],
      workspaceRoots: [workspace],
      additionalDirectories: [],
      resourceReadRoots: [],
      readOnly: false,
      searchDirectory: resolve(buddyRoot, '.output/build/search-tools/darwin-arm64'),
      backend: { kind: 'macos-srt' },
    }
  })

  afterEach(async () => {
    process.chdir(buddyRoot)
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  async function execute(command: string, overrides: Partial<SandboxProcessInput> = {}, options: Partial<Parameters<typeof runSandboxCommand>[1]> = {}) {
    const output: Buffer[] = []
    const result = await runSandboxCommand({ ...input, ...overrides, command, requestId: randomUUID() }, {
      signal: new AbortController().signal,
      onData: data => output.push(data),
      approveNetwork: async () => false,
      ...options,
    })
    return { result, output: Buffer.concat(output).toString('utf8') }
  }

  it('keeps workspace writes while denying secrets, symlink escapes and Git changes', async () => {
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, '.git/config'), 'git-preserved')
    await writeFile(join(workspace, '.env'), 'synthetic-secret')
    await symlink(outside, join(workspace, 'escape'))
    const output: Buffer[] = []
    const exitCode = await runSrtSandbox({
      ...input,
      backend: { kind: 'macos-srt' },
      command: `set -e; printf created > output; cat output; ! cat .env; ! cat escape/preserved; ! sh -c 'echo changed > .git/config'; ! sh -c ${quote(`echo changed > ${quote(join(outside, 'preserved'))}`)}`,
    }, {
      signal: AbortSignal.timeout(10_000),
      onStarted: () => {},
      onData: data => output.push(data),
      approveNetwork: async () => false,
    })
    const text = Buffer.concat(output).toString('utf8')
    expect(exitCode, text).toBe(0)
    expect(text).toContain('created')
    expect(text).not.toContain('synthetic-secret')
    expect(text).not.toContain('outside-preserved')
    expect(await readFile(join(outside, 'preserved'), 'utf8')).toBe('outside-preserved')
    expect(await readFile(join(workspace, '.git/config'), 'utf8')).toBe('git-preserved')
  }, 15_000)

  it('enforces read-only access while keeping isolated HOME and scratch space usable', async () => {
    const run = await execute('set -e; ! touch new-file; test -z "$SSH_AUTH_SOCK$ANTHROPIC_API_KEY"; printf scratch > "$TMPDIR/scratch"; cat "$TMPDIR/scratch"; printf "%s" "$HOME"', { readOnly: true })
    expect(run.result, run.output).toEqual({ ok: true, exitCode: 0 })
    expect(run.output).toContain('scratch')
    expect(run.output).toContain(join(input.privateRoot, 'home'))
    await expect(access(join(workspace, 'new-file'))).rejects.toThrow()
  }, 15_000)

  it('blocks direct network access and contacts a destination only after approval', async () => {
    let hits = 0
    const server = createServer((_request, response) => {
      hits++
      response.end('approved')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing test listener')
      const command = `curl --max-time 2 --silent --fail http://127.0.0.1:${address.port}`
      const denied = await execute(command)
      expect(denied.result).toMatchObject({ ok: true })
      expect(denied.result).not.toMatchObject({ exitCode: 0 })
      const direct = await execute(`HTTPS_PROXY='' HTTP_PROXY='' ALL_PROXY='' https_proxy='' http_proxy='' all_proxy='' ${command}`)
      expect(direct.result).not.toMatchObject({ exitCode: 0 })
      expect(hits).toBe(0)
      const allowed = await execute(command, {}, { approveNetwork: async target => target.host === '127.0.0.1' && target.port === address.port })
      expect(allowed.result, allowed.output).toEqual({ ok: true, exitCode: 0 })
      expect(allowed.output).toBe('approved')
      expect(hits).toBe(1)
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 30_000)

  it('cancels descendants and fails closed when required resources are missing', async () => {
    const timedOut = await execute('(sleep 1; touch late) & wait', { timeout: 0.05 })
    expect(timedOut.result).toEqual({ ok: false, code: 'SANDBOX_TIMEOUT' })
    await setTimeout(1100)
    await expect(access(join(workspace, 'late'))).rejects.toThrow()
    const unavailable = await execute('touch must-not-run', { searchDirectory: join(directory, 'missing') })
    expect(unavailable.result).toEqual({ ok: false, code: 'SANDBOX_UNAVAILABLE' })
    await expect(access(join(workspace, 'must-not-run'))).rejects.toThrow()
  }, 15_000)
})

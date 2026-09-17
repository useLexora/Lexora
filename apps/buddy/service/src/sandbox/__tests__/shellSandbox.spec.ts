import type { SandboxProcessInput } from '../../../../shared/permissions/shellSandbox'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSandboxEnvironment } from '../../../../platform/process/sandboxEnvironment'
import { runSandboxCommand } from '../runSandboxCommand'

const buddyRoot = process.cwd()
const originalEnvironment = { ...process.env }
const originalHome = homedir()
const quote = (value: string) => `'${value.replaceAll('\'', '\'\\\'\'')}'`

describe.skipIf(process.platform !== 'linux')('linux shell enforcement', () => {
  let directory: string
  let workspace: string
  let outside: string
  let input: SandboxProcessInput

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lexora-sandbox-test-'))
    workspace = join(directory, 'workspace')
    outside = join(directory, 'outside')
    const privateRoot = join(directory, 'private')
    await Promise.all([workspace, outside, join(privateRoot, 'home'), join(privateRoot, 'tmp')].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(outside, 'preserved'), 'outside-preserved')
    const environment = createSandboxEnvironment(originalEnvironment, privateRoot)
    for (const key of new Set([...Object.keys(process.env), ...Object.keys(environment)]))
      vi.stubEnv(key, environment[key])
    process.chdir(privateRoot)
    input = {
      command: '',
      additionalDirectories: [],
      resourceReadRoots: [],
      cwd: workspace,
      home: originalHome,
      path: originalEnvironment.PATH ?? '',
      privateRoot,
      protectedRoots: [],
      readOnly: false,
      requestId: randomUUID(),
      roots: [workspace],
      workspaceRoots: [workspace],
      backend: { kind: 'linux-srt', sandboxDirectory: resolve(buddyRoot, `.output/build/shell-sandbox/linux-${process.arch}`) },
      searchDirectory: resolve(buddyRoot, `.output/build/search-tools/linux-${process.arch}`),
      timeout: 5,
    }
  })

  afterEach(async () => {
    process.chdir(buddyRoot)
    vi.unstubAllEnvs()
    await rm(directory, { force: true, recursive: true })
  })

  async function execute(command: string, options: Partial<Parameters<typeof runSandboxCommand>[1]> = {}, overrides: Partial<SandboxProcessInput> = {}) {
    const output: Buffer[] = []
    const result = await runSandboxCommand({ ...input, ...overrides, command, requestId: randomUUID() }, {
      approveNetwork: async () => false,
      onData: data => output.push(data),
      signal: new AbortController().signal,
      ...options,
    })
    return { result, output: Buffer.concat(output).toString('utf8') }
  }

  it('executes compound commands and workspace edits while masking secrets, symlink escapes and Git metadata', async () => {
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, '.git/config'), 'git-preserved')
    await writeFile(join(workspace, '.env'), 'synthetic-secret')
    await writeFile(join(workspace, '.env.example'), 'example-allowed')
    await symlink(outside, join(workspace, 'escape'))
    const { result, output } = await execute(`set -e; command -v sh; printf created > file; cat file; rm file; cat .env.example; ! cat .env; ! cat escape/preserved; ! sh -c 'echo changed > .git/config'; ! sh -c ${quote(`echo changed > ${join(outside, 'preserved')}`)}`)
    expect(result).toEqual({ ok: true, exitCode: 0 })
    expect(output).toContain('created')
    expect(output).toContain('example-allowed')
    expect(output).not.toContain('synthetic-secret')
    expect(output).not.toContain('outside-preserved')
    expect(await readFile(join(outside, 'preserved'), 'utf8')).toBe('outside-preserved')
    expect(await readFile(join(workspace, '.git/config'), 'utf8')).toBe('git-preserved')
    await expect(access(join(workspace, 'file'))).rejects.toThrow()
  }, 15_000)

  it('enforces read-only writes in the kernel while retaining private scratch space', async () => {
    await writeFile(join(workspace, 'preserved'), 'workspace-preserved')
    const { result } = await execute('set -e; ! rm preserved; ! touch new-file; printf scratch > "$TMPDIR/scratch"; test "$(cat "$TMPDIR/scratch")" = scratch', {}, { readOnly: true })
    expect(result).toEqual({ ok: true, exitCode: 0 })
    expect(await readFile(join(workspace, 'preserved'), 'utf8')).toBe('workspace-preserved')
    await expect(access(join(workspace, 'new-file'))).rejects.toThrow()
  }, 15_000)

  it('returns an ordinary program failure without adding sandbox recovery advice', async () => {
    const { result, output } = await execute('printf ordinary-program-error >&2; exit 7')
    expect(result).toEqual({ ok: true, exitCode: 7 })
    expect(output).toBe('ordinary-program-error')
  }, 15_000)

  it('limits additional read permission across interpreters and descendants without silently granting write access', async () => {
    const metadata = await stat(outside, { bigint: true })
    const grant = { access: 'read' as const, path: outside, device: String(metadata.dev), inode: String(metadata.ino) }
    const target = join(outside, 'preserved')
    const command = `set -e; node -e ${quote(`const fs=require('node:fs'); console.log(fs.readFileSync(${JSON.stringify(target)},'utf8')); try { fs.writeFileSync(${JSON.stringify(target)},'changed'); process.exit(1) } catch(e) { if(!['EACCES','EROFS'].includes(e.code)) throw e }`)}; ! sh -c ${quote(`rm ${quote(target)}`)}`
    const read = await execute(command, {}, { additionalDirectories: [grant] })
    expect(read.result).toEqual({ ok: true, exitCode: 0 })
    expect(read.output).toContain('outside-preserved')
    expect(await readFile(target, 'utf8')).toBe('outside-preserved')
    const write = await execute(`printf updated > ${quote(target)}`, {}, { additionalDirectories: [{ ...grant, access: 'write' }] })
    expect(write.result).toEqual({ ok: true, exitCode: 0 })
    expect(await readFile(target, 'utf8')).toBe('updated')
    const expired = await execute(`cat ${quote(target)}`)
    expect(expired.result).not.toMatchObject({ exitCode: 0 })
    expect(expired.output).not.toContain('updated')
  }, 30_000)

  it('reads an installed skill package while keeping it immutable and sibling product data private', async () => {
    const storage = join(directory, 'product')
    const skill = join(storage, 'skills', 'installed', 'revision', 'writer')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'guide.txt'), 'skill-reference')
    await writeFile(join(storage, 'private.json'), 'private-product-storage')
    const result = await execute(`set -e; cat ${quote(join(skill, 'guide.txt'))}; ! touch ${quote(join(skill, 'new-file'))}; ! rm ${quote(join(skill, 'guide.txt'))}; ! cat ${quote(join(storage, 'private.json'))}; printf created > task-output`, {}, {
      resourceReadRoots: [skill],
      protectedRoots: [storage],
    })
    expect(result.result, result.output).toEqual({ ok: true, exitCode: 0 })
    expect(result.output).toContain('skill-reference')
    expect(result.output).not.toContain('private-product-storage')
    expect(await readFile(join(skill, 'guide.txt'), 'utf8')).toBe('skill-reference')
    expect(await readFile(join(workspace, 'task-output'), 'utf8')).toBe('created')
  }, 15_000)

  it('blocks desktop Unix sockets and does not expose the real HOME or host credentials', async () => {
    const { result, output } = await execute('set -e; test -z "$SSH_AUTH_SOCK$DBUS_SESSION_BUS_ADDRESS$ANTHROPIC_API_KEY"; node -e "require(\'node:net\').createConnection(\'/tmp/host.sock\').on(\'error\', e => { console.log(e.code); process.exitCode = e.code === \'EPERM\' ? 0 : 1 })"; printf "%s" "$HOME"')
    expect(result).toEqual({ ok: true, exitCode: 0 })
    expect(output).toContain('EPERM')
    expect(output).toContain(join(input.privateRoot, 'home'))
  }, 15_000)

  it('keeps an authorized child writable when its parent receives additional read access', async () => {
    const reference = join(directory, 'reference')
    const project = join(reference, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(reference, 'preserved'), 'read-only-parent')
    const metadata = await stat(reference, { bigint: true })
    const result = await execute(`set -e; printf changed > ${quote(join(project, 'changed'))}; ! rm ${quote(join(reference, 'preserved'))}`, {}, {
      roots: [project],
      cwd: project,
      workspaceRoots: [project],
      additionalDirectories: [{ path: reference, access: 'read', device: String(metadata.dev), inode: String(metadata.ino) }],
    })
    expect(result.result, result.output).toEqual({ ok: true, exitCode: 0 })
    expect(await readFile(join(project, 'changed'), 'utf8')).toBe('changed')
    expect(await readFile(join(reference, 'preserved'), 'utf8')).toBe('read-only-parent')
  })

  it('uses trusted workspace ownership without exposing sibling product storage', async () => {
    const storage = join(directory, 'product')
    const project = join(storage, 'arbitrary-layout', 'task-files')
    await mkdir(project, { recursive: true })
    await writeFile(join(storage, 'private.json'), 'private-product-storage')
    const result = await execute(`set -e; printf created > owned; ! cat ${quote(join(storage, 'private.json'))}`, {}, {
      roots: [project],
      workspaceRoots: [project],
      cwd: project,
      protectedRoots: [storage],
    })
    expect(result.result).toEqual({ ok: true, exitCode: 0 })
    expect(result.output).not.toContain('private-product-storage')
    expect(await readFile(join(project, 'owned'), 'utf8')).toBe('created')
    const untrusted = await execute('touch must-not-run', {}, { roots: [project], workspaceRoots: [], cwd: project, protectedRoots: [storage] })
    expect(untrusted.result).toEqual({ ok: false, code: 'SANDBOX_UNAVAILABLE' })
  })

  it('asks once per destination per command, denies before contact, and does not reuse the next command authorization', async () => {
    let hits = 0
    let asks = 0
    const server = createServer((_request, response) => {
      hits++
      response.end('approved')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing test server address')
    const url = `http://127.0.0.1:${address.port}`
    try {
      const approveNetwork = async (target: { host: string, port: number }) => {
        asks++
        expect(target).toEqual({ host: '127.0.0.1', port: address.port })
        return true
      }
      const first = await execute(`curl --silent --fail ${url}; curl --silent --fail ${url}`, { approveNetwork })
      expect(first.result).toEqual({ ok: true, exitCode: 0 })
      expect(hits).toBe(2)
      expect(asks).toBe(1)
      await execute(`curl --silent --fail ${url}`, { approveNetwork })
      expect(asks).toBe(2)
      expect(hits).toBe(3)
      const denied = await execute(`curl --silent --fail ${url}`)
      expect(denied.result).toMatchObject({ ok: true })
      expect(denied.result).not.toMatchObject({ exitCode: 0 })
      expect(hits).toBe(3)
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 30_000)

  it('cancels descendants and reports timeouts without leaving deferred writes', async () => {
    const controller = new AbortController()
    const cancelled = await execute('(sleep 1; touch late) & printf started; wait', {
      signal: controller.signal,
      onData: () => controller.abort(),
    })
    expect(cancelled.result).toEqual({ ok: false, code: 'SANDBOX_CANCELLED' })
    const timedOut = await execute('sleep 5; touch timed-out', {}, { timeout: 0.05 })
    expect(timedOut.result).toEqual({ ok: false, code: 'SANDBOX_TIMEOUT' })
    await setTimeout(1_100)
    await expect(access(join(workspace, 'late'))).rejects.toThrow()
    await expect(access(join(workspace, 'timed-out'))).rejects.toThrow()
  }, 15_000)

  it('fails closed when the packaged helper is missing', async () => {
    const { result } = await execute('touch must-not-run', {}, { backend: { kind: 'linux-srt', sandboxDirectory: join(directory, 'missing') } })
    expect(result).toEqual({ ok: false, code: 'SANDBOX_UNAVAILABLE' })
    await expect(access(join(workspace, 'must-not-run'))).rejects.toThrow()
  })
})

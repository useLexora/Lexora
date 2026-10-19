import type { SandboxProcessInput } from '../../../../shared/permissions/shellSandbox'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createUnixServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveSandboxDependencies } from '../../../../platform/process/sandboxDependencies'
import { createSandboxDirectory } from '../../../../platform/process/sandboxDirectory'
import { createSandboxEnvironment } from '../../../../platform/process/sandboxEnvironment'
import { resolveSensitivePathRoots } from '../../permissions/sensitivePaths'
import { runSandboxCommand } from '../runSandboxCommand'

const buddyRoot = process.cwd()
const originalEnvironment = { ...process.env }
const originalHome = homedir()
const quote = (value: string) => `'${value.replaceAll('\'', '\'\\\'\'')}'`

describe.skipIf(process.platform !== 'linux')('linux shell enforcement', () => {
  let directory: string
  let workspace: string
  let outside: string
  let privateRoot: string
  let input: SandboxProcessInput

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lexora-sandbox-test-'))
    workspace = join(directory, 'workspace')
    outside = join(directory, 'outside')
    privateRoot = await createSandboxDirectory()
    await Promise.all([workspace, outside].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(outside, 'preserved'), 'outside-preserved')
    const environment = createSandboxEnvironment(originalEnvironment, privateRoot)
    environment.LEXORA_BUDDY_PROCESS_CONTROL = originalEnvironment.LEXORA_BUDDY_PROCESS_CONTROL
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
      sensitiveRoots: resolveSensitivePathRoots({ home: originalHome, environment: originalEnvironment }),
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
    await Promise.all([directory, privateRoot].map(path => rm(path, { force: true, recursive: true })))
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

  it('executes workspace edits with protected paths, redacted lifecycle events and verified process release', async () => {
    const events: import('../../../../shared/permissions/sandboxLifecycle').SandboxLifecycleEvent[] = []
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, '.git/config'), 'git-preserved')
    await writeFile(join(workspace, '.env'), 'synthetic-secret')
    await writeFile(join(workspace, '.env.example'), 'example-allowed')
    await symlink(outside, join(workspace, 'escape'))
    const { result, output } = await execute(`set -e; printf created > file; cat file; rm file; cat .env.example; cat .env; cat escape/preserved; ! sh -c 'echo changed > .git/config'; ! sh -c ${quote(`echo changed > ${join(outside, 'preserved')}`)}`, { onLifecycle: event => events.push(event) })
    expect(result, output).toEqual({ ok: true, exitCode: 0 })
    expect(output).toContain('created')
    expect(output).toContain('example-allowed')
    expect(output).toContain('synthetic-secret')
    expect(output).toContain('outside-preserved')
    expect(await readFile(join(outside, 'preserved'), 'utf8')).toBe('outside-preserved')
    expect(await readFile(join(workspace, '.git/config'), 'utf8')).toBe('git-preserved')
    await expect(access(join(workspace, 'file'))).rejects.toThrow()
    const processes = events.filter(event => event.kind === 'process').map(event => event.snapshot.process!)
    const dispatched = processes.filter(process => !process.pid)
    const supervised = processes.filter(process => process.pid)
    expect(dispatched.map(process => process.phase)).toEqual(['spawned', 'cleanup_requested', 'resources_released'])
    expect(new Set(dispatched.map(process => process.processId)).size).toBe(1)
    expect(supervised.map(process => process.phase)).toEqual(['spawned', 'exited', 'closed', 'cleanup_requested', 'resources_released'])
    expect(supervised[0]?.pid).toBeGreaterThan(0)
    expect(new Set(supervised.map(process => process.pid)).size).toBe(1)
    const dispatch = JSON.parse(dispatched[0]!.processId!)
    const identity = JSON.parse(supervised[0]!.processId!)
    expect(dispatch).toMatchObject({ kind: 'native-shell-dispatch', nonce: identity.nonce })
    expect(processes.find(process => process.phase === 'exited')?.exitCode).toBe(0)
    expect(JSON.stringify(events)).not.toMatch(/synthetic-secret|example-allowed|printf/)
  }, 15_000)

  it('enforces read-only writes in the kernel while retaining private scratch space', async () => {
    await writeFile(join(workspace, 'preserved'), 'workspace-preserved')
    const { result, output } = await execute('set -e; ! rm preserved; ! touch new-file; printf scratch > "$TMPDIR/scratch"; test "$(cat "$TMPDIR/scratch")" = scratch; if test -w /tmp; then scratch=$(mktemp /tmp/standard-XXXXXX); printf private > "$scratch"; test "$(cat "$scratch")" = private; rm "$scratch"; fi', {}, { readOnly: true })
    expect(result, output).toEqual({ ok: true, exitCode: 0 })
    expect(await readFile(join(workspace, 'preserved'), 'utf8')).toBe('workspace-preserved')
    await expect(access(join(workspace, 'new-file'))).rejects.toThrow()
  }, 15_000)

  it('protects host-resolved credentials after HOME and XDG variables are isolated', async () => {
    const home = join(directory, 'host-home')
    const configuration = join(directory, 'relocated-config')
    const data = join(directory, 'relocated-data')
    const environment = { XDG_CONFIG_HOME: configuration, XDG_DATA_HOME: data }
    const credentials = [join(home, '.netrc'), join(home, '_netrc'), join(home, '.ssh', 'id_ed25519'), join(configuration, 'gcloud', 'credentials.db'), join(data, 'keyrings', 'login.keyring')]
    for (const path of credentials) {
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, 'SYNTHETIC_CREDENTIAL')
    }
    await writeFile(join(workspace, '.netrc'), 'PROJECT_FIXTURE')
    await writeFile(join(configuration, 'ordinary.txt'), 'ORDINARY_CONFIGURATION')
    const sensitiveRoots = resolveSensitivePathRoots({ home, environment })
    const command = `set -e; ${credentials.map(path => `! cat ${quote(path)}`).join('; ')}; cat .netrc; cat ${quote(join(configuration, 'ordinary.txt'))}; test "$HOME" != ${quote(home)}; test "${'$'}{XDG_CONFIG_HOME:-}" != ${quote(configuration)}`
    const result = await execute(command, {}, { home, sensitiveRoots, readOnly: true })
    expect(result.result, result.output).toEqual({ ok: true, exitCode: 0 })
    expect(result.output).not.toContain('SYNTHETIC_CREDENTIAL')
    expect(result.output).toContain('PROJECT_FIXTURE')
    expect(result.output).toContain('ORDINARY_CONFIGURATION')
    const forbidden = await execute('printf must-not-run', {}, { home, sensitiveRoots, cwd: join(configuration, 'gcloud'), roots: [join(configuration, 'gcloud')], workspaceRoots: [join(configuration, 'gcloud')] })
    expect(forbidden.result).toMatchObject({ ok: false, code: 'SANDBOX_UNAVAILABLE' })
    expect(forbidden.output).not.toContain('must-not-run')
  }, 15_000)

  it('limits additional read permission across interpreters and descendants without silently granting write access', async () => {
    const metadata = await stat(outside, { bigint: true })
    const grant = { access: 'read' as const, path: outside, device: String(metadata.dev), inode: String(metadata.ino) }
    const target = join(outside, 'preserved')
    const command = `set -e; node -e ${quote(`const fs=require('node:fs'); console.log(fs.readFileSync(${JSON.stringify(target)},'utf8')); try { fs.writeFileSync(${JSON.stringify(target)},'changed'); process.exit(1) } catch(e) { if(!['EACCES','EROFS'].includes(e.code)) throw e }`)}; ! sh -c ${quote(`rm ${quote(target)}`)}`
    const read = await execute(command, {}, { additionalDirectories: [grant] })
    expect(read.result, read.output).toEqual({ ok: true, exitCode: 0 })
    expect(read.output).toContain('outside-preserved')
    expect(await readFile(target, 'utf8')).toBe('outside-preserved')
    const write = await execute(`printf updated > ${quote(target)}`, {}, { additionalDirectories: [{ ...grant, access: 'write' }] })
    expect(write.result).toEqual({ ok: true, exitCode: 0 })
    expect(await readFile(target, 'utf8')).toBe('updated')
    const expired = await execute(`cat ${quote(target)}; ! sh -c ${quote(`echo forbidden > ${quote(target)}`)}`)
    expect(expired.result).toMatchObject({ exitCode: 0 })
    expect(expired.output).toContain('updated')
    expect(await readFile(target, 'utf8')).toBe('updated')
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

  it('supports private IPC across descendants while isolating host credentials and readable host sockets in both modes', async () => {
    const dependencies = await resolveSandboxDependencies({ backend: { kind: 'linux-srt', sandboxDirectory: resolve(buddyRoot, `.output/build/shell-sandbox/linux-${process.arch}`) }, searchDirectory: input.searchDirectory })
    if (dependencies.platform !== 'linux')
      throw new Error('Expected Linux dependencies')
    const hostSocket = join(workspace, 'host.sock')
    let hits = 0
    const server = createUnixServer((socket) => {
      hits++
      socket.end('host-service')
    })
    await new Promise<void>(resolve => server.listen(hostSocket, resolve))
    const script = `
      const net = require('node:net');
      const {spawn} = require('node:child_process');
      const assert = require('node:assert/strict');
      const host = net.createConnection(${JSON.stringify(hostSocket)});
      host.on('connect', () => { throw new Error('Host socket accessible') });
      host.on('error', async error => {
        assert.ok(['ENOENT', ${JSON.stringify(dependencies.privateUnixSockets ? 'EACCES' : 'EPERM')}].includes(error.code));
        const path = process.env.TMPDIR + '/private.sock';
        const server = net.createServer(socket => socket.end('private-reply'));
        ${dependencies.privateUnixSockets
          ? `server.listen(path, () => {
              const child = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:net').createConnection(process.argv[1]).on('data', data => process.send(data.toString())).on('error', error => { throw error })`)}, path], {stdio:['ignore','inherit','inherit','ipc']});
              let received = false;
              child.on('message', reply => { assert.equal(reply, 'private-reply'); received = true });
              child.on('error', error => { throw error });
              child.on('exit', code => { assert.equal(code, 0); assert.ok(received); server.close() });
            });`
          : `server.on('error', error => assert.equal(error.code, 'EPERM')); server.listen(path);`}
      });`
    try {
      const command = `set -e; test -z "$SSH_AUTH_SOCK$DBUS_SESSION_BUS_ADDRESS$ANTHROPIC_API_KEY"; test "$HOME" = ${quote(join(input.privateRoot, 'home'))}; node -e ${quote(script)}`
      for (const readOnly of [false, true]) {
        const { result, output } = await execute(command, {}, { readOnly })
        expect(result, output).toEqual({ ok: true, exitCode: 0 })
        expect(hits).toBe(0)
      }
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 30_000)

  it('keeps legacy kernel isolation strict instead of falling back to host execution', async () => {
    const helper = join(privateRoot, 'legacy-helper')
    await writeFile(helper, `#!/bin/sh\nif [ "$1" = --probe-sandbox-ipc ]; then\n  printf '{"protocol":1,"privateUnixSockets":false}\\n'\nelse\n  exec ${quote(originalEnvironment.LEXORA_BUDDY_PROCESS_CONTROL!)} "$@"\nfi\n`, { mode: 0o700 })
    vi.stubEnv('LEXORA_BUDDY_PROCESS_CONTROL', helper)
    const command = `set -e; printf legacy > owned; cat ${quote(join(outside, 'preserved'))}; node -e ${quote(`require('node:net').createServer().on('error', error => { if(error.code !== 'EPERM') throw error }).listen(process.env.TMPDIR + '/denied.sock')`)}`
    const { result, output } = await execute(command)
    expect(result, output).toEqual({ ok: true, exitCode: 0 })
    expect(output).toContain('outside-preserved')
    expect(await readFile(join(workspace, 'owned'), 'utf8')).toBe('legacy')
  })

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

  it('reaches its own HTTP servers directly without proxy approvals in both modes', async () => {
    const script = `
      const http = require('node:http');
      const {spawn} = require('node:child_process');
      const assert = require('node:assert/strict');
      (async () => {
        for (const host of ['127.0.0.1', '::1']) {
          const server = http.createServer((request, response) => response.end('private-http'));
          await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
          const addresses = host === '::1' ? ['[::1]', 'localhost'] : [host];
          for (const address of addresses) {
            const curl = spawn('curl', ['--silent', '--show-error', '--fail', '--max-time', '3', 'http://' + address + ':' + server.address().port], {stdio:['ignore','inherit','inherit']});
            assert.equal(await new Promise((resolve, reject) => curl.once('error', reject).once('exit', resolve)), 0);
          }
          await new Promise(resolve => server.close(resolve));
        }
      })().catch(error => { console.error(error); process.exit(1) });`
    for (const readOnly of [false, true]) {
      const { result, output } = await execute(`node -e ${quote(script)}`, {
        approveNetwork: async () => {
          throw new Error('Private HTTP must not reach the host proxy')
        },
      }, { readOnly })
      expect(result, output).toEqual({ ok: true, exitCode: 0 })
      expect(output).toBe('private-http'.repeat(3))
    }
  }, 30_000)

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
      const first = await execute(`curl --noproxy '' --silent --fail ${url}; curl --noproxy '' --silent --fail ${url}`, { approveNetwork })
      expect(first.result).toEqual({ ok: true, exitCode: 0 })
      expect(hits).toBe(2)
      expect(asks).toBe(1)
      await execute(`curl --noproxy '' --silent --fail ${url}`, { approveNetwork })
      expect(asks).toBe(2)
      expect(hits).toBe(3)
      const denied = await execute(`curl --noproxy '' --silent --fail ${url}`)
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

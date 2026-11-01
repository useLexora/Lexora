import type { WslShellRequest } from '../WslHostPool'
import type { Helper } from './wslFixtures'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WslHostPool } from '../WslHostPool'
import { distribution, FakeHelper, hasBash, hasHelperPython, localHelper, sequence } from './wslFixtures'

const settle = () => new Promise(resolve => setImmediate(resolve))

describe.skipIf(!hasHelperPython || !hasBash)('wslHostPool shell with the real helper', () => {
  let root: string
  let home: string
  let started: Helper[]
  let pool: WslHostPool
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wsl-shell-'))
    home = await mkdtemp(join(tmpdir(), 'wsl-home-'))
    // A login shell reads ~/.profile, which loads ~/.bashrc. As on Ubuntu, .bashrc stops early for a shell that is not
    // interactive, so the PATH it exports is only seen by the interactive probe, never by a plain `bash -lc`.
    await writeFile(join(home, '.profile'), '[ -n "$BASH_VERSION" ] && . "$HOME/.bashrc"\n')
    await writeFile(join(home, '.bashrc'), 'case $- in *i*) ;; *) return;; esac\nexport PATH="/wsl-probe-marker:$PATH"\n')
    started = []
    pool = new WslHostPool({ spawnProcess: localHelper(started, { ...process.env, HOME: home }), idleSeconds: 60 })
  })
  afterEach(async () => {
    await pool.dispose()
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  async function run(command: string, overrides: Partial<WslShellRequest> = {}) {
    const chunks: Buffer[] = []
    const result = await pool.shell({ distribution, cwd: root, command, onData: chunk => chunks.push(chunk), ...overrides })
    return { ...result, output: Buffer.concat(chunks).toString() }
  }

  async function pidOf(file: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(file) && (await readFile(file, 'utf8')).trim())
        return Number((await readFile(file, 'utf8')).trim())
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error('the command did not start')
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    }
    catch {
      return false
    }
  }

  it('runs bash in the directory and returns its exit code', async () => {
    expect(await run('pwd')).toEqual({ exitCode: 0, output: `${root}\n` })
    expect((await run('exit 3')).exitCode).toBe(3)
    expect((await run('kill -9 $$')).exitCode).toBe(137)
  })

  it('passes the command through untouched, with no quoting of its own', async () => {
    const command = String.raw`X='q"r $HOME'; printf '[%s]' "$X"; echo; echo 'it'"'"'s' | tr a-z A-Z; printf '%s\n' *.nothing`
    expect((await run(command)).output).toBe(`[q"r $HOME]\nIT'S\n*.nothing\n`)
  })

  it('merges stderr into stdout in the order written, with no terminal', async () => {
    expect((await run('echo one; echo two >&2; echo three')).output).toBe('one\ntwo\nthree\n')
    expect((await run('[ -t 0 ] && echo tty || echo notty')).output).toBe('notty\n')
  })

  it('runs with the PATH of the login shell, not the one wsl.exe inherits', async () => {
    expect((await run('echo "$PATH"')).output).toContain('/wsl-probe-marker')
  })

  it('streams a large output whole', async () => {
    const { output } = await run(`head -c 3000000 /dev/zero | tr '\\0' x`)
    expect(output.length).toBe(3_000_000)
  })

  it('runs commands at the same time on one helper', async () => {
    const outputs = await Promise.all(Array.from({ length: 4 }, () => run('echo $$')))
    expect(new Set(outputs.map(item => item.output)).size).toBe(4)
    expect(started).toHaveLength(1)
  })

  it('does not stop a command that outlasts the idle timeout', async () => {
    const idle = new WslHostPool({ spawnProcess: localHelper(started, { ...process.env, HOME: home }), idleSeconds: 1 })
    try {
      const chunks: Buffer[] = []
      await idle.shell({ distribution, cwd: root, command: 'sleep 2.5; echo finished', onData: chunk => chunks.push(chunk) })
      expect(Buffer.concat(chunks).toString()).toBe('finished\n')
    }
    finally {
      await idle.dispose()
    }
  })

  it('reports a missing directory and a command that cannot be started', async () => {
    await expect(run('pwd', { cwd: join(root, 'missing') })).rejects.toThrow(`Working directory does not exist: ${join(root, 'missing')}`)
    await expect(run('echo a\0b')).rejects.toThrow('bash could not be started')
  })

  it('kills the command when it times out, and reports the timeout', async () => {
    const file = join(root, 'pid')
    const pending = run(`echo $$ > ${file}; exec sleep 30`, { timeout: 0.4 })
    const pid = await pidOf(file)
    await expect(pending).rejects.toThrow('timeout:0.4')
    expect(alive(pid)).toBe(false)
  })

  it('kills the whole process group when the call is aborted', async () => {
    const file = join(root, 'pid')
    const controller = new AbortController()
    const pending = run(`sleep 30 & echo $! > ${file}; wait`, { signal: controller.signal })
    const pid = await pidOf(file)
    expect(alive(pid)).toBe(true)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(alive(pid)).toBe(false)
  })

  it('kills a command still running when the pool is closed', async () => {
    const file = join(root, 'pid')
    const pending = run(`echo $$ > ${file}; exec sleep 30`)
    pending.catch(() => {})
    const pid = await pidOf(file)
    await pool.dispose()
    for (let attempt = 0; attempt < 50 && alive(pid); attempt++)
      await new Promise(resolve => setTimeout(resolve, 30))
    expect(alive(pid)).toBe(false)
    await expect(pending).rejects.toThrow()
  })
})

describe('wslHostPool shell when the helper misbehaves', () => {
  const shellRequest = (overrides: Partial<WslShellRequest> = {}, output: string[] = []): WslShellRequest => ({ distribution, cwd: '/home/x', command: 'make', onData: chunk => void output.push(chunk.toString()), ...overrides })
  const reply = (code: number | null, reason?: string) => (request: { id: number }, helper: FakeHelper) => helper.frame({ id: request.id, t: 'exit', code, ...reason ? { err: reason } : {} })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses to run when the helper cannot start, instead of guessing another way', async () => {
    const helper = new FakeHelper({ ready: null })
    setImmediate(() => {
      helper.stderr('<3>WSL (1 - Relay) ERROR: CreateProcessCommon:875: execvpe(python3) failed: No such file or directory')
      helper.close(1)
    })
    const { spawnProcess, calls } = sequence(helper)
    const pool = new WslHostPool({ spawnProcess })
    await expect(pool.shell(shellRequest())).rejects.toThrow(/Commands cannot run in the WSL distribution Ubuntu-24\.04.*execvpe\(python3\).*python3.*sudo apt install python3/s)
    expect(calls).toHaveLength(1)
    await pool.dispose()
  })

  it('never starts a command again once it reached a helper that then went away', async () => {
    const output: string[] = []
    const dying = new FakeHelper({ onRequest: (request, helper) => {
      helper.out(request.id, 'partial\n')
      setTimeout(() => helper.close(1), 10)
    } })
    const { spawnProcess, calls } = sequence(dying, new FakeHelper())
    const pool = new WslHostPool({ spawnProcess })
    await expect(pool.shell(shellRequest({}, output))).rejects.toThrow('it may have run only in part')
    expect(output).toEqual(['partial\n'])
    expect(calls).toHaveLength(1)
    const silent = sequence(new FakeHelper({ onRequest: (_request, helper) => helper.close(1) }), new FakeHelper())
    const quiet = new WslHostPool({ spawnProcess: silent.spawnProcess })
    await expect(quiet.shell(shellRequest())).rejects.toThrow('it may have run only in part')
    expect(silent.calls).toHaveLength(1)
    await pool.dispose()
    await quiet.dispose()
  })

  it('starts a new helper for the next command when the old one ended in between, without running anything twice', async () => {
    const answer = (request: { id: number }, helper: FakeHelper) => {
      helper.out(request.id, 'ran\n')
      helper.frame({ id: request.id, t: 'exit', code: 0 })
    }
    const first = new FakeHelper({ onRequest: answer })
    const second = new FakeHelper({ onRequest: answer })
    const output: string[] = []
    const { spawnProcess, calls } = sequence(first, second)
    const pool = new WslHostPool({ spawnProcess })
    expect(await pool.shell(shellRequest({}, output))).toEqual({ exitCode: 0 })
    // The first helper leaves after being idle, as it does in service.
    first.close(0)
    await settle()
    await settle()
    expect(await pool.shell(shellRequest({}, output))).toEqual({ exitCode: 0 })
    expect(output).toEqual(['ran\n', 'ran\n'])
    expect(calls).toHaveLength(2)
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    await pool.dispose()
  })

  it('sends the directory and the command as given, and returns data from both streams in order', async () => {
    const output: string[] = []
    const helper = new FakeHelper({ onRequest: (request, self) => {
      self.out(request.id, 'a')
      self.err(request.id, 'b')
      self.out(request.id, 'c')
      self.frame({ id: request.id, t: 'exit', code: 5 })
    } })
    const pool = new WslHostPool({ spawnProcess: sequence(helper).spawnProcess })
    expect(await pool.shell(shellRequest({ cwd: '/home/lenovo/code/Foo', command: 'echo "$HOME" | tr a b\nls' }, output))).toEqual({ exitCode: 5 })
    expect(output).toEqual(['a', 'b', 'c'])
    expect(helper.requests).toEqual([{ id: 1, op: 'shell', cwd: '/home/lenovo/code/Foo', command: 'echo "$HOME" | tr a b\nls' }])
    await pool.dispose()
  })

  it('maps how the command ended', async () => {
    const outcomes: [number | null, string | undefined, number | string][] = [[0, undefined, 0], [7, undefined, 7], [-15, undefined, 143], [-9, undefined, 137], [null, 'ENOENT', 'bash is not installed in the WSL distribution Ubuntu-24.04'], [null, 'CWD', 'Working directory does not exist: /home/x'], [null, 'SPAWN', 'bash could not be started']]
    for (const [code, reason, expected] of outcomes) {
      const pool = new WslHostPool({ spawnProcess: sequence(new FakeHelper({ onRequest: reply(code, reason) })).spawnProcess })
      if (typeof expected === 'number')
        expect(await pool.shell(shellRequest())).toEqual({ exitCode: expected })
      else
        await expect(pool.shell(shellRequest())).rejects.toThrow(expected)
      await pool.dispose()
    }
  })

  it('cancels on abort and reports it once the helper confirms the command ended', async () => {
    const helper = new FakeHelper({ onRequest: (request, self) => {
      if (request.op === 'cancel')
        self.frame({ id: request.id, t: 'exit', code: -9 })
    } })
    const pool = new WslHostPool({ spawnProcess: sequence(helper).spawnProcess })
    const controller = new AbortController()
    const pending = pool.shell(shellRequest({ signal: controller.signal }))
    pending.catch(() => {})
    while (helper.requests.length < 1)
      await settle()
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(helper.requests.map(request => request.op)).toEqual(['shell', 'cancel'])
    expect(helper.requests[1]!.id).toBe(helper.requests[0]!.id)
    await pool.dispose()
  })

  it('does not start a command for a call that is already aborted', async () => {
    const helper = new FakeHelper()
    const pool = new WslHostPool({ spawnProcess: sequence(helper).spawnProcess })
    await expect(pool.shell(shellRequest({ signal: AbortSignal.abort() }))).rejects.toThrow()
    expect(helper.requests).toEqual([])
    await pool.dispose()
  })

  it('stops waiting for a helper that does not confirm a cancel, and reports the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const helper = new FakeHelper()
    const pool = new WslHostPool({ spawnProcess: sequence(helper).spawnProcess })
    const pending = pool.shell(shellRequest({ timeout: 1 }))
    const outcome = pending.then(() => 'resolved', (error: Error) => error.message)
    while (helper.requests.length < 1)
      await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(helper.requests.map(request => request.op)).toEqual(['shell', 'cancel'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(await outcome).toBe('timeout:1')
    await pool.dispose()
  })
})

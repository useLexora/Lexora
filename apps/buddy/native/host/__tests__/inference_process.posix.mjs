/* eslint test/no-import-node-test: off */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, constants, openSync, readFileSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import * as nativeTest from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const supervisor = process.platform === 'darwin' ? process.env.LEXORA_BUDDY_PROCESS_CONTROL : process.env.LEXORA_POSIX_INFERENCE_SUPERVISOR
const options = { skip: !['darwin', 'linux'].includes(process.platform), timeout: 15000 }

async function fixture(t, paused = false) {
  assert.ok(supervisor, 'Set the freshly built macOS helper or Linux POSIX test example')
  const directory = await mkdtemp(join(tmpdir(), 'lexora inference 中文-'))
  const children = []
  const descendants = []
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'close')
      }
    }
    for (const pid of descendants) {
      if (alive(pid))
        process.kill(pid, 'SIGKILL')
    }
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(join(directory, 'plugin', 'native'), { recursive: true })
  await writeFile(join(directory, 'runtime.mjs'), 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[2]).href)')
  await writeFile(join(directory, 'plugin', 'native', 'fixture.mjs'), `
import { spawn } from 'node:child_process';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stderr.write('diagnostic fixture\\n');
process.stdout.write(JSON.stringify({ runtime: process.pid, descendant: descendant.pid, secret: process.env.INFERENCE_FIXTURE_SECRET ?? null, home: process.env.HOME, tmp: process.env.TMPDIR, libraries: process.env.DYLD_LIBRARY_PATH }) + '\\n');
${paused ? 'process.stdin.pause(); setInterval(() => {}, 1000);' : 'process.stdin.pipe(process.stdout);'}
`)
  return {
    configuration: { executable: process.execPath, directory, entry: 'native/fixture.mjs', libraryPaths: [directory], parentPid: process.pid },
    track(child) {
      children.push(child)
      return child
    },
    record(started) {
      descendants.push(started.runtime, started.descendant)
      return started
    },
  }
}

function observe(child) {
  const output = []
  let diagnostic = ''
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk
  })
  child.stdin?.on('error', () => {})
  return { output, closed: once(child, 'close'), diagnostic: () => diagnostic }
}

async function waitUntil(probe, description, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = probe()
    if (result)
      return result
    await delay(20)
  }
  assert.fail(description)
}

async function terminated(pids, description) {
  try {
    await waitUntil(() => pids.every(pid => !alive(pid)), description)
  }
  catch (error) {
    const state = execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,stat=,comm=', '-p', pids.join(',')], { encoding: 'utf8' })
    throw new Error(`${description}\n${state}`, { cause: error })
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return status.slice(status.lastIndexOf(')') + 2, status.lastIndexOf(')') + 3) !== 'Z'
    }
    return true
  }
  catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT')
      return false
    throw error
  }
}

async function identity(observation) {
  return waitUntil(() => {
    const output = Buffer.concat(observation.output)
    const newline = output.indexOf(10)
    return newline < 0 ? undefined : { ...JSON.parse(output.subarray(0, newline)), prefix: newline + 1 }
  }, 'runtime startup was not observed')
}

for (const ending of ['eof', 'supervisor-crash']) {
  nativeTest.test(`binary stdio remains separate and ${ending} terminates standard descendants`, options, async (t) => {
    const f = await fixture(t)
    const child = f.track(spawn(supervisor, ['--supervise-inference'], { stdio: 'pipe', env: { ...process.env, INFERENCE_FIXTURE_SECRET: 'must-not-inherit' } }))
    const observed = observe(child)
    child.stdin.write(`${JSON.stringify(f.configuration)}\n`)
    const started = f.record(await identity(observed))
    assert.equal(started.secret, null)
    assert.equal(started.home, f.configuration.directory)
    assert.equal(started.tmp, f.configuration.directory)
    assert.equal(started.libraries, f.configuration.directory)
    assert.ok(alive(started.runtime) && alive(started.descendant))
    const payload = Buffer.from([0, 255, 10, 0, 128, 13, 1, 2])
    child.stdin.write(payload)
    await waitUntil(() => Buffer.concat(observed.output).length >= started.prefix + payload.length, 'binary echo missing')
    assert.deepEqual(Buffer.concat(observed.output).subarray(started.prefix), payload)
    assert.match(observed.diagnostic(), /diagnostic fixture/)
    if (ending === 'eof')
      child.stdin.end()
    else
      child.kill('SIGKILL')
    await observed.closed
    await terminated([started.runtime, started.descendant], 'process group survived supervision end')
  })
}

for (const transport of ['socket', 'pipe']) {
  nativeTest.test(`closing ${transport} stdin terminates blocked forwarding while the parent stays alive`, options, async (t) => {
    const f = await fixture(t, true)
    let descriptor
    t.after(() => {
      if (descriptor !== undefined)
        closeSync(descriptor)
    })
    let child
    if (transport === 'pipe') {
      const fifo = join(f.configuration.directory, 'input.fifo')
      execFileSync('mkfifo', [fifo])
      child = f.track(spawn('/bin/sh', ['-c', 'exec "$1" --supervise-inference < "$2"', 'inference-fixture', supervisor, fifo], { stdio: ['ignore', 'pipe', 'pipe'] }))
      descriptor = await waitUntil(() => {
        try {
          return openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
        }
        catch (error) {
          if (error.code !== 'ENXIO')
            throw error
        }
      }, 'helper did not open the input pipe')
    }
    else {
      child = f.track(spawn(supervisor, ['--supervise-inference'], { stdio: 'pipe' }))
    }
    const observed = observe(child)
    const configuration = `${JSON.stringify(f.configuration)}\n`
    if (descriptor !== undefined)
      writeSync(descriptor, configuration)
    else
      child.stdin.write(configuration)
    const started = f.record(await identity(observed))
    if (descriptor !== undefined) {
      const payload = Buffer.alloc(65536)
      let written = 0
      const deadline = Date.now() + 100
      do {
        try {
          while (written < 8 * 1024 * 1024)
            written += writeSync(descriptor, payload)
        }
        catch (error) {
          if (error.code !== 'EAGAIN')
            throw error
        }
        await delay(10)
      } while (Date.now() < deadline)
      assert.ok(written > 0 && written < 8 * 1024 * 1024, 'pipe must reach backpressure before closure')
    }
    else {
      child.stdin.write(Buffer.alloc(8 * 1024 * 1024))
      await delay(100)
      assert.ok(child.stdin.writableLength > 0, 'socket must reach backpressure before closure')
    }
    assert.ok(alive(child.pid) && alive(started.runtime) && alive(started.descendant))
    if (descriptor !== undefined) {
      closeSync(descriptor)
      descriptor = undefined
    }
    else {
      child.stdin.destroy()
    }
    await waitUntil(() => child.exitCode !== null && !alive(started.runtime) && !alive(started.descendant), 'stdin closure left the blocked process group alive', 1000)
    const [code] = await observed.closed
    assert.equal(code, 0)
    assert.equal(f.configuration.parentPid, process.pid)
    assert.ok(alive(process.pid))
  })
}

for (const ending of ['parent-crash', 'supervisor-crash']) {
  nativeTest.test(`${ending} terminates the group even when stdin forwarding is blocked`, options, async (t) => {
    const f = await fixture(t, true)
    const parent = f.track(spawn(process.execPath, ['--input-type=module', '-e', `
import { spawn } from 'node:child_process';
const helper = spawn(process.argv[1], ['--supervise-inference'], { stdio: 'pipe' });
helper.stdin.on('error', () => {});
helper.stdout.on('data', chunk => process.send({ output: chunk.toString(), supervisor: helper.pid }));
helper.stderr.resume();
helper.stdin.write(JSON.stringify({ ...JSON.parse(process.argv[2]), parentPid: process.pid }) + '\\n');
helper.stdin.write(Buffer.alloc(8 * 1024 * 1024));
setInterval(() => {}, 1000);
`, supervisor, JSON.stringify(f.configuration)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
    let output = ''
    let helperPid
    parent.on('message', (message) => {
      output += message.output
      helperPid = message.supervisor
    })
    const closed = once(parent, 'close')
    const started = f.record(await waitUntil(() => output.includes('\n') ? JSON.parse(output.slice(0, output.indexOf('\n'))) : undefined, 'child did not start under parent'))
    await delay(100)
    if (ending === 'parent-crash') {
      parent.kill('SIGKILL')
      await closed
    }
    else {
      process.kill(helperPid, 'SIGKILL')
    }
    await terminated([helperPid, started.runtime, started.descendant], 'blocked forwarding left supervised descendants running')
  })
}

nativeTest.test('preserves worker exit status and terminates a surviving child', options, async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.configuration.directory, 'plugin', 'native', 'fixture.mjs'), `
import { spawn } from 'node:child_process';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ runtime: process.pid, descendant: descendant.pid }) + '\\n', () => process.exit(23));
`)
  const child = f.track(spawn(supervisor, ['--supervise-inference'], { stdio: 'pipe' }))
  const observed = observe(child)
  child.stdin.write(`${JSON.stringify(f.configuration)}\n`)
  const started = f.record(await identity(observed))
  const [code] = await observed.closed
  assert.equal(code, 23)
  await terminated([started.descendant], 'worker exit left its descendant running')
})

nativeTest.test('rejects invalid entries, unrelated parents and oversized launch metadata before worker execution', options, async (t) => {
  const f = await fixture(t)
  for (const request of [
    { ...f.configuration, entry: '../runtime.mjs' },
    { ...f.configuration, parentPid: 1 },
    { ...f.configuration, libraryPaths: ['relative'] },
    { ...f.configuration, libraryPaths: ['/bad:separator'] },
    { ...f.configuration, extra: true },
    { ...f.configuration, executable: `/${'x'.repeat(65536)}` },
  ]) {
    const child = f.track(spawn(supervisor, ['--supervise-inference'], { stdio: 'pipe' }))
    const observed = observe(child)
    child.stdin.end(`${JSON.stringify(request)}\n`)
    const [code] = await observed.closed
    assert.notEqual(code, 0)
    assert.equal(Buffer.concat(observed.output).length, 0)
  }
})

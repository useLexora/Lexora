/* eslint test/no-import-node-test: off */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import * as nativeTest from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const supervisor = process.env.LEXORA_BUDDY_PROCESS_CONTROL
const options = { skip: process.platform !== 'win32', timeout: 15000 }

async function fixture(t, paused = false) {
  assert.ok(supervisor, 'Set LEXORA_BUDDY_PROCESS_CONTROL to the freshly built helper')
  const directory = await mkdtemp(join(tmpdir(), 'lexora inference 中文-'))
  const children = []
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'close')
      }
    }
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(join(directory, 'plugin', 'native'), { recursive: true })
  await writeFile(join(directory, 'runtime.mjs'), 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[2]).href)')
  await writeFile(join(directory, 'plugin', 'native', 'fixture.mjs'), `
import { spawn } from 'node:child_process';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
process.stderr.write('diagnostic fixture\\n');
process.stdout.write(JSON.stringify({ runtime: process.pid, descendant: descendant.pid, secret: process.env.INFERENCE_FIXTURE_SECRET ?? null }) + '\\n');
${paused ? 'process.stdin.pause(); setInterval(() => {}, 1000);' : 'process.stdin.pipe(process.stdout);'}
`)
  return {
    configuration: { executable: process.execPath, directory, entry: 'native/fixture.mjs', libraryPaths: [], parentPid: process.pid },
    track(child) {
      children.push(child)
      return child
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
  child.stdin.on('error', () => {})
  const closed = once(child, 'close')
  return { output, closed, diagnostic: () => diagnostic }
}

async function waitUntil(probe, description) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const result = probe()
    if (result)
      return result
    await delay(20)
  }
  assert.fail(description)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    if (error.code === 'ESRCH')
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
  nativeTest.test(`binary stdio remains separate and ${ending} reaps detached descendants`, options, async (t) => {
    const { configuration, track } = await fixture(t)
    const child = track(spawn(supervisor, ['--supervise-inference'], { stdio: 'pipe', env: { ...process.env, INFERENCE_FIXTURE_SECRET: 'must-not-inherit' } }))
    const observed = observe(child)
    child.stdin.write(`${JSON.stringify(configuration)}\n`)
    const started = await identity(observed)
    assert.equal(started.secret, null)
    assert.ok(alive(started.runtime) && alive(started.descendant))
    const payload = Buffer.from([0, 255, 10, 0, 128, 13, 1, 2])
    child.stdin.write(payload)
    await waitUntil(() => Buffer.concat(observed.output).length >= started.prefix + payload.length, 'binary echo missing')
    assert.deepEqual(Buffer.concat(observed.output).subarray(started.prefix), payload)
    assert.match(observed.diagnostic(), /diagnostic fixture/)
    if (ending === 'eof')
      child.stdin.end()
    else
      child.kill()
    await observed.closed
    await waitUntil(() => !alive(started.runtime) && !alive(started.descendant), 'process tree survived supervision end')
  })
}

nativeTest.test('parent crash reaps the tree even when stdin forwarding is blocked', options, async (t) => {
  const { configuration, track } = await fixture(t, true)
  const parent = track(spawn(process.execPath, ['--input-type=module', '-e', `
import { spawn } from 'node:child_process';
const helper = spawn(process.argv[1], ['--supervise-inference'], { stdio: 'pipe' });
helper.stdin.on('error', () => {});
helper.stdout.on('data', chunk => process.send({ output: chunk.toString(), supervisor: helper.pid }));
helper.stderr.resume();
helper.stdin.write(JSON.stringify({ ...JSON.parse(process.argv[2]), parentPid: process.pid }) + '\\n');
helper.stdin.write(Buffer.alloc(8 * 1024 * 1024));
setInterval(() => {}, 1000);
`, supervisor, JSON.stringify(configuration)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
  let output = ''
  let helperPid
  parent.on('message', (message) => {
    output += message.output
    helperPid = message.supervisor
  })
  const closed = once(parent, 'close')
  const started = await waitUntil(() => output.includes('\n') ? JSON.parse(output.slice(0, output.indexOf('\n'))) : undefined, 'child did not start under parent')
  parent.kill()
  await closed
  await waitUntil(() => !alive(helperPid) && !alive(started.runtime) && !alive(started.descendant), 'parent crash left supervised descendants running')
})

nativeTest.test('rejects paths outside the fixed native entry before launch', options, async (t) => {
  const { configuration, track } = await fixture(t)
  const child = track(spawn(supervisor, ['--supervise-inference'], { stdio: 'pipe' }))
  const observed = observe(child)
  child.stdin.end(`${JSON.stringify({ ...configuration, entry: '../runtime.mjs' })}\n`)
  const [code] = await observed.closed
  assert.notEqual(code, 0)
  assert.equal(Buffer.concat(observed.output).length, 0)
})

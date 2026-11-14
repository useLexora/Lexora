import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import process from 'node:process'
import test from 'vitest'

const executable = process.env.LEXORA_TEST_RUNTIME_GUARD ?? path.resolve(import.meta.dirname, '../../target/debug/lexora-buddy-runtime-guard.exe')

test('guard confirms that the terminated runtime and its child have left the private Job', { skip: process.platform !== 'win32', timeout: 30_000 }, async (context) => {
  const target = spawn(process.execPath, ['-e', `
    process.stdin.once('data', () => {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      child.once('spawn', () => process.stdout.write(String(child.pid) + '\\n'))
    })
    setInterval(() => {}, 1000)
  `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  await once(target, 'spawn')
  context.after(() => target.kill())
  const guard = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  context.after(() => guard.kill())
  const guardExit = once(guard, 'exit')
  let output = ''
  let stderr = ''
  guard.stdout.on('data', (chunk) => {
    output += chunk
  })
  guard.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  guard.stdin.end(JSON.stringify({ pid: target.pid, observeCleanup: true }))
  await waitUntil(() => output.includes('ready\n'), () => `Guard did not become ready: ${stderr}`)
  target.stdin.end('spawn')
  const [chunk] = await once(target.stdout, 'data')
  const descendant = Number(String(chunk).trim())
  assert(Number.isInteger(descendant) && descendant > 1)
  target.kill()
  const [code] = await guardExit
  assert.equal(code, 0, stderr)
  assert.equal(output, 'ready\nclean\n')
  assert.throws(() => process.kill(descendant, 0), error => error.code === 'ESRCH')
})

async function waitUntil(condition, failure) {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() >= deadline)
      assert.fail(failure())
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

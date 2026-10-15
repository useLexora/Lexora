import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { afterEach, it } from 'vitest'
import { createRunDirectory } from '../run-artifacts.mjs'
import RunReporter from '../run-reporter.mjs'

const execute = promisify(execFile)
const temporary = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

async function root() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lexora-run-artifacts-'))
  temporary.push(directory)
  return directory
}

it('allocates readable local dates and independent same-second invocations without overwriting evidence', async () => {
  const directory = await root()
  const now = new Date(2026, 9, 15, 14, 32, 5)
  const first = createRunDirectory({ task: 'buddy-cloud-backup', root: directory, now })
  await fs.writeFile(path.join(first, 'evidence.txt'), 'first invocation')
  const second = createRunDirectory({ task: 'buddy-cloud-backup', root: directory, now })
  assert.equal(path.relative(directory, first), path.join('2026-10-15', 'buddy-cloud-backup', '14-32-05'))
  assert.equal(path.basename(second), '14-32-05-02')
  assert.equal(await fs.readFile(path.join(first, 'evidence.txt'), 'utf8'), 'first invocation')
  const summary = JSON.parse(await fs.readFile(path.join(second, 'run.json'), 'utf8'))
  assert.equal(summary.startedAt, now.toISOString())
  assert.equal(summary.utcOffsetMinutes + now.getTimezoneOffset(), 0)
  assert.equal(summary.status, 'created')
  assert.notEqual(summary.runId, JSON.parse(await fs.readFile(path.join(first, 'run.json'), 'utf8')).runId)
})

it('reserves distinct directories across processes starting in the same second', async () => {
  const directory = await root()
  const helper = new URL('../run-artifacts.mjs', import.meta.url).href
  const script = `import { createRunDirectory } from ${JSON.stringify(helper)}; console.log(createRunDirectory({ task: 'buddy-concurrent', root: ${JSON.stringify(directory)}, now: new Date(2026, 9, 15, 14, 32, 5) }))`
  const results = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, ['--input-type=module', '-e', script])))
  assert.equal(new Set(results.map(result => result.stdout.trim())).size, 4)
  assert.equal((await fs.readdir(path.join(directory, '2026-10-15/buddy-concurrent'))).length, 4)
})

it('rejects unsafe task paths before allocating artifacts', async () => {
  const directory = await root()
  for (const task of ['../escape', '/absolute', 'buddy/cloud-backup', 'CloudBackup', ''])
    assert.throws(() => createRunDirectory({ task, root: directory }), /Invalid test task name/)
  assert.deepEqual(await fs.readdir(directory), [])
})

it('records standalone process completion and failure without claiming assertions passed', async () => {
  const directory = await root()
  const helper = new URL('../run-artifacts.mjs', import.meta.url).href
  for (const code of [0, 2]) {
    const script = `import { createRunDirectory } from ${JSON.stringify(helper)}; console.log(createRunDirectory({ task: 'buddy-standalone', root: ${JSON.stringify(directory)}, completeOnExit: true })); process.exitCode = ${code}`
    const result = await execute(process.execPath, ['--input-type=module', '-e', script]).then(result => ({ ...result, code: 0 }), error => error)
    assert.equal(result.code, code)
    const summary = JSON.parse(await fs.readFile(path.join(result.stdout.trim(), 'run.json'), 'utf8'))
    assert.equal(summary.status, code === 0 ? 'completed' : 'failed')
    assert.equal(summary.exitCode, code)
    assert.ok(summary.finishedAt)
  }
})

it('records the runner verdict, retries and logs alongside its report without changing test results', async () => {
  const directory = createRunDirectory({ task: 'buddy-recovery', root: await root() })
  const reporter = new RunReporter({ directory })
  reporter.onBegin({ projects: [{ name: 'buddy' }] }, { allTests: () => ['test'] })
  reporter.onStdOut('diagnostic\n')
  reporter.onTestEnd({ titlePath: () => ['settings', 'rollback'], expectedStatus: 'passed' }, { status: 'failed', retry: 0 })
  reporter.onEnd({ status: 'failed', duration: 25 })
  const summary = JSON.parse(await fs.readFile(path.join(directory, 'run.json'), 'utf8'))
  assert.equal(summary.status, 'failed')
  assert.equal(summary.report, 'report/index.html')
  assert.equal(summary.outcomes[0].status, 'failed')
  assert.equal(summary.durationMs, 25)
  assert.ok(summary.finishedAt)
  assert.equal(await fs.readFile(path.join(directory, 'logs/stdout.log'), 'utf8'), 'diagnostic\n')
})

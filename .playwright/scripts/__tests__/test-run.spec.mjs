import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'vitest'
import { createBuddyTestRun } from '../buddy-test.mjs'

const temporary = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

async function options() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'lexora-test-')))
  temporary.push(directory)
  return { runId: 'same-task', dataRoot: path.join(directory, 'data'), artifactRoot: path.join(directory, 'artifacts') }
}

it('concurrent callers share a task directory but own distinct instances and cleanup', async () => {
  const settings = await options()
  const first = await createBuddyTestRun(settings)
  const second = await createBuddyTestRun(settings)
  const [a, b, c] = await Promise.all([first.createInstance('ui'), second.createInstance('ui'), second.createInstance('runtime')])
  assert.equal(first.directory, second.directory)
  assert.equal(new Set([a.home, b.home, c.home]).size, 3)
  await fs.writeFile(path.join(b.home, 'sentinel'), 'preserved')
  await first.dispose()
  await assert.rejects(fs.access(a.home), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(b.home, 'sentinel'), 'utf8'), 'preserved')
  await second.dispose()
})

it('retains instance data when disposal requests preservation', async () => {
  const run = await createBuddyTestRun(await options())
  const instance = await run.createInstance()
  await run.dispose({ preserve: true })
  await fs.access(path.join(instance.home, 'config.toml'))
})

it('rejects product data roots and traversal before creating test data', async () => {
  for (const name of ['.lexora', '.lexora-dev'])
    await assert.rejects(createBuddyTestRun({ dataRoot: path.join(homedir(), name) }), /must not overlap/)
  await assert.rejects(createBuddyTestRun({ ...await options(), runId: '../escape' }), /Invalid test run ID/)
})

it('cleanup refuses a replaced instance directory', async () => {
  const run = await createBuddyTestRun(await options())
  const instance = await run.createInstance()
  const backup = `${instance.home}-original`
  await fs.rename(instance.home, backup)
  await fs.mkdir(instance.home)
  await fs.writeFile(path.join(instance.home, 'sentinel'), 'replacement')
  await assert.rejects(run.dispose(), /Could not clean up test instances/)
  assert.equal(await fs.readFile(path.join(instance.home, 'sentinel'), 'utf8'), 'replacement')
  await fs.access(backup)
})

it('disposal waits for pending allocations and rejects late allocations and launches', async () => {
  const run = await createBuddyTestRun(await options())
  const creating = run.createInstance()
  await run.dispose()
  const instance = await creating
  await assert.rejects(fs.access(instance.home), { code: 'ENOENT' })
  await assert.rejects(run.createInstance(), /disposed/)
  await assert.rejects(instance.launch(), /disposed/)
})

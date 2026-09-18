import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionScheduler } from '../ExtensionScheduler'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-schedule-spec-'))
  let available = true
  const dispatched: string[] = []
  const scheduler = new ExtensionScheduler(root, { available: () => available, execute: async (id, command) => {
    dispatched.push(`${id}/${command}`)
  }, failed: () => {} })
  cleanups.push(async () => {
    scheduler.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await scheduler.load()
  return { scheduler, root, dispatched, unavailable: () => {
    available = false
  } }
}
const input = { id: 'water', command: 'tests.water.notify', enabled: true, intervalMinutes: 1 }

it('persists next due before delivery and stops disabled or removed jobs', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const { scheduler, root, dispatched, unavailable } = await fixture()
  const initial = await scheduler.set('tests.water', input, () => {})
  await vi.advanceTimersByTimeAsync(60000)
  await vi.waitFor(() => expect(dispatched).toHaveLength(1))
  expect(JSON.parse(await readFile(join(root, 'schedules.json'), 'utf8')).jobs[0].nextRunAt).toBe(initial.nextRunAt! + 60000)
  unavailable()
  scheduler.refresh()
  await vi.advanceTimersByTimeAsync(180000)
  expect(dispatched).toHaveLength(1)
  await scheduler.remove('tests.water')
  expect(scheduler.get('tests.water', 'water')).toBeNull()
})

it('skips reminders missed while suspended or offline instead of replaying them', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const { scheduler, root, dispatched } = await fixture()
  await scheduler.set('tests.water', input, () => {})
  scheduler.suspend()
  await vi.advanceTimersByTimeAsync(3600000)
  await scheduler.resume()
  expect(dispatched).toHaveLength(0)
  expect(scheduler.get('tests.water', 'water')?.nextRunAt).toBe(Date.now() + 60000)
  scheduler.dispose()
  const saved = JSON.parse(await readFile(join(root, 'schedules.json'), 'utf8'))
  saved.jobs[0].nextRunAt = Date.now() - 3600000
  await writeFile(join(root, 'schedules.json'), JSON.stringify(saved))
  const restored = new ExtensionScheduler(root, { available: () => true, execute: async () => {
    dispatched.push('restored')
  }, failed: () => {} })
  cleanups.push(async () => restored.dispose())
  await restored.load()
  expect(restored.get('tests.water', 'water')?.nextRunAt).toBe(Date.now() + 60000)
  expect(dispatched).toHaveLength(0)
})

it('rejects stale writes without overwriting the saved schedule', async () => {
  const { scheduler } = await fixture()
  const saved = await scheduler.set('tests.water', input, () => {})
  await expect(scheduler.set('tests.water', { ...input, intervalMinutes: 2 }, () => {
    throw new Error('EXTENSION_HOST_STOPPED')
  })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  expect(scheduler.get('tests.water', 'water')).toEqual(saved)
})

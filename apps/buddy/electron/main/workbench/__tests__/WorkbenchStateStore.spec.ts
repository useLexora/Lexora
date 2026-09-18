import type { WorkbenchState } from '../../../../shared/workbench/workbenchState'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fileStorage } from '../../../../platform/filesystem/fileStorage'
import { WorkbenchStateStore } from '../WorkbenchStateStore'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
it('preserves saved content after a failed replacement and permits a later retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-workbench-'))
  directories.push(directory)
  const store = new WorkbenchStateStore(directory)
  const snapshot: WorkbenchState = { version: 1, layout: {}, configuration: {}, backups: [] }
  await store.read()
  await store.write(snapshot)
  vi.spyOn(fileStorage, 'replace').mockRejectedValueOnce(new Error('storage unavailable'))
  const updated = { ...snapshot, configuration: { changed: true } }
  await expect(store.write(updated)).rejects.toThrow('storage unavailable')
  expect(await store.read()).toEqual(snapshot)
  expect((await readdir(directory)).some(file => file.endsWith('.tmp'))).toBe(false)
  await store.write(updated)
  expect(await new WorkbenchStateStore(directory).read()).toEqual(updated)
})
it('recovers the previous snapshot and preserves malformed data before allowing writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-workbench-'))
  directories.push(directory)
  const store = new WorkbenchStateStore(directory)
  const snapshot: WorkbenchState = { version: 1, layout: { version: 1 }, configuration: {}, backups: [{ key: 'file:fixture', resource: {}, text: 'valuable', baseText: 'old', etag: 'hash', savedAt: '2026-09-17' }] }
  await expect(store.write(snapshot)).rejects.toThrow('WORKBENCH_NOT_RESTORED')
  expect(await store.read()).toBeNull()
  await store.write(snapshot)
  await store.write({ ...snapshot, configuration: { setting: true } })
  await writeFile(join(directory, 'workbench.json'), '{interrupted')
  const restarted = new WorkbenchStateStore(directory)
  expect(await restarted.read()).toEqual(snapshot)
  const recovery = (await readdir(directory)).find(file => file.startsWith('workbench.recovery-'))!
  expect(await readFile(join(directory, recovery), 'utf8')).toBe('{interrupted')
  await restarted.write(snapshot)
  expect(await restarted.read()).toEqual(snapshot)
  expect(await readFile(join(directory, recovery), 'utf8')).toBe('{interrupted')
  await rm(join(directory, 'workbench.json'))
  expect(await new WorkbenchStateStore(directory).read()).toEqual(snapshot)
  await writeFile(join(directory, 'workbench.previous.json'), '{also interrupted')
  const unreadable = new WorkbenchStateStore(directory)
  await expect(unreadable.read()).rejects.toThrow('WORKBENCH_RECOVERY_FAILED')
  await expect(unreadable.read()).rejects.toThrow('WORKBENCH_RECOVERY_FAILED')
  await expect(unreadable.write(snapshot)).rejects.toThrow('WORKBENCH_NOT_RESTORED')
})

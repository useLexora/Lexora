import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { DesktopUpdateStore, emptyUpdateRecord } from '../DesktopUpdateStore'

it('round-trips update decisions in a private file without changing configuration', async () => {
  const directory = await createTemporaryDirectory('desktop-updates-')
  const store = new DesktopUpdateStore(directory)
  expect(await store.read()).toEqual(emptyUpdateRecord())
  const record = { ...emptyUpdateRecord(), ignoredVersion: '1.2.0', notifiedVersion: '1.1.0', lastNotifiedAt: 1000 }
  await store.write(record)
  expect(await new DesktopUpdateStore(directory).read()).toEqual(record)
  if (process.platform !== 'win32')
    expect((await stat(join(directory, 'updates.json'))).mode & 0o777).toBe(0o600)
})

it('preserves corrupt or unknown-version state rather than silently resetting opt-outs', async () => {
  const directory = await createTemporaryDirectory('desktop-updates-')
  const path = join(directory, 'updates.json')
  const store = new DesktopUpdateStore(directory)
  for (const content of ['{broken', JSON.stringify({ ...emptyUpdateRecord(), version: 2 })]) {
    await writeFile(path, content)
    await expect(store.read()).rejects.toThrow('UPDATE_STATE_UNAVAILABLE')
    expect(await readFile(path, 'utf8')).toBe(content)
  }
})

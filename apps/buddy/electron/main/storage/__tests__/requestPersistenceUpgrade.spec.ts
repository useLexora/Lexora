import type { DesktopStorage } from '../storageBootstrap'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { StorageLocationStore } from '../../../../platform/storage/StorageLocationStore'
import { openBuddyDatabase, openBuddySqliteDatabase } from '../../../../service/src/storage/database'
import { requestPersistenceUpgrade } from '../requestPersistenceUpgrade'

it.each(['legacy_jsonl', 'sqlite'] as const)('requests a separate upgrade only for legacy data without rewriting the %s database', async (authority) => {
  const root = await createTemporaryDirectory('desktop-persistence-upgrade-')
  const databasePath = join(root, 'buddy/buddy.sqlite3')
  const open = authority === 'sqlite' ? openBuddySqliteDatabase : openBuddyDatabase
  open({ databasePath }).close()
  const original = await readFile(databasePath)
  const store = new StorageLocationStore(join(root, 'bootstrap/location.json'), root)
  const storage: DesktopStorage = {
    store,
    state: await store.read(),
    bootstrapRoot: join(root, 'bootstrap'),
    leaseDirectory: join(root, 'leases'),
    legacySources: [],
    protection: { sensitiveRoots: [], sandboxRoots: [] },
  }
  await requestPersistenceUpgrade(storage)
  const result = await store.read()
  if (authority === 'legacy_jsonl') {
    expect(result.pending).toMatchObject({ kind: 'upgrade', source: root, target: root, phase: 'pending' })
    storage.state = result
    await requestPersistenceUpgrade(storage)
    expect(await store.read()).toEqual(result)
  }
  else {
    expect(result.pending).toBeNull()
  }
  expect(await readFile(databasePath)).toEqual(original)
})

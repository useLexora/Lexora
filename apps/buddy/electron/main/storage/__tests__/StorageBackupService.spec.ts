import type { DesktopRuntimeHost } from '../../app/DesktopRuntimeHost'
import type { DesktopEnvironment } from '../../app/typing'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { resolveBuddyPrivateDirectories } from '../../../../platform/native/nativeHost'
import { writeSnapshotManifest } from '../../../../platform/storage/SnapshotRepository'
import { LexoraConfigStore } from '../../config/LexoraConfigStore'
import { StorageBackupService } from '../StorageBackupService'

async function retentionFixture() {
  const root = await createTemporaryDirectory('lexora-backup-retention-')
  const configStore = new LexoraConfigStore({ configPath: join(root, 'config.toml') })
  let pending: { snapshotId: string } | null = null
  const environment = {
    paths: { lexoraHome: root },
    storage: {
      privateDirectoriesExecutable: resolveBuddyPrivateDirectories({ appPath: process.cwd(), resourcesPath: '', isPackaged: false }),
      store: { read: async () => ({ pending }) },
    },
    diagnostics: { record: () => {} },
  } as unknown as DesktopEnvironment
  const backups = new StorageBackupService(environment, () => null, { configStore } as DesktopRuntimeHost)
  async function add(day: number, automatic?: string, directory?: string) {
    const id = randomUUID()
    const target = directory ?? backups.snapshots.directory(id)
    const bytes = Buffer.from(`snapshot-${day}`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    await mkdir(join(target, 'files/buddy'), { recursive: true })
    await writeFile(join(target, 'files/buddy/buddy.sqlite3'), bytes)
    await writeSnapshotManifest(target, {
      version: 3,
      id,
      dataId: randomUUID(),
      createdAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
      sourceRoot: root,
      databaseVersion: 29,
      scopes: ['tasks'],
      credentials: false,
      excludedLinks: 0,
      ...(automatic ? { automatic } : {}),
      files: [{ kind: 'directory', path: 'buddy' }, { kind: 'file', path: 'buddy/buddy.sqlite3', size: bytes.length, hash, chunks: [{ hash, size: bytes.length }], executable: false }],
    })
    return id
  }
  return {
    root,
    backups,
    configStore,
    add,
    setPending: (id: string | null) => {
      pending = id ? { snapshotId: id } : null
    },
  }
}

it('applies the shared limit to manual and all cloud copies only when cleanup is requested', async () => {
  const f = await retentionFixture()
  const ids = [await f.add(1), await f.add(2, randomUUID()), await f.add(3, randomUUID()), await f.add(4)]
  await f.backups.run(() => f.backups.prune())
  expect((await f.backups.catalog()).snapshots.map(item => item.id)).toEqual(ids.slice(1).reverse())
  await f.configStore.update({ desktop: { localBackupLimit: 1 } })
  expect((await f.backups.catalog()).snapshots).toHaveLength(3)
  await f.backups.run(() => f.backups.prune())
  expect((await f.backups.catalog()).snapshots.map(item => item.id)).toEqual([ids[3]])
})

it('retains pending uploads, restores, unreadable backups and exported copies', async () => {
  const f = await retentionFixture()
  const ids = [await f.add(1), await f.add(2), await f.add(3), await f.add(4)]
  const unreadable = randomUUID()
  await mkdir(f.backups.snapshots.directory(unreadable), { recursive: true })
  await writeFile(join(f.backups.snapshots.directory(unreadable), 'manifest.json'), '{damaged')
  const exported = join(f.root, 'exported-copy')
  await f.add(1, undefined, exported)
  f.backups.protectedSnapshots = () => new Set([ids[0]!])
  f.setPending(ids[1]!)
  await f.configStore.update({ desktop: { localBackupLimit: 1 } })
  await f.backups.run(() => f.backups.prune())
  expect((await f.backups.catalog()).snapshots.map(item => item.id)).toEqual([ids[3], ids[1], ids[0]])
  expect((await f.backups.catalog()).unreadableIds).toEqual([unreadable])
  expect(await readFile(join(exported, 'files/buddy/buddy.sqlite3'), 'utf8')).toBe('snapshot-1')
  f.backups.protectedSnapshots = () => {
    throw new Error('BACKUP_SCHEDULE_UNAVAILABLE')
  }
  await expect(f.backups.run(() => f.backups.prune())).rejects.toThrow('BACKUP_SCHEDULE_UNAVAILABLE')
  expect((await f.backups.catalog()).snapshots).toHaveLength(3)
  f.backups.protectedSnapshots = () => new Set()
  f.setPending(null)
  await f.backups.run(() => f.backups.prune())
  expect((await f.backups.catalog()).snapshots.map(item => item.id)).toEqual([ids[3]])
})

it('keeps an older imported backup within the limit and never prunes for a failed import', async () => {
  const f = await retentionFixture()
  const latest = await f.add(5)
  await f.add(4)
  await f.add(3)
  const imported = join(f.root, 'incoming')
  const importedId = await f.add(1, undefined, imported)
  await f.backups.run(() => f.backups.import(imported))
  expect((await f.backups.catalog()).snapshots.map(item => item.id)).toEqual([latest, expect.any(String), importedId])
  const before = (await f.backups.catalog()).snapshots.map(item => item.id)
  const corrupt = join(f.root, 'corrupt')
  await f.add(2, undefined, corrupt)
  await writeFile(join(corrupt, 'files/buddy/buddy.sqlite3'), 'corrupt')
  await expect(f.backups.run(() => f.backups.import(corrupt))).rejects.toThrow()
  expect((await f.backups.catalog()).snapshots.map(item => item.id)).toEqual(before)
})

it('preserves a newly imported backup when old-copy removal fails and reports recoverable cleanup status', async () => {
  const f = await retentionFixture()
  await f.add(1)
  await f.configStore.update({ desktop: { localBackupLimit: 1 } })
  const incoming = join(f.root, 'incoming')
  const id = await f.add(2, undefined, incoming)
  const remove = f.backups.snapshots.remove.bind(f.backups.snapshots)
  f.backups.snapshots.remove = async () => {
    throw new Error('EACCES')
  }
  expect(await f.backups.run(() => f.backups.import(incoming))).toMatchObject({ id })
  expect(await f.backups.catalog()).toMatchObject({ cleanupError: true, snapshots: expect.arrayContaining([expect.objectContaining({ id })]) })
  f.backups.snapshots.remove = remove
  await f.backups.run(() => f.backups.prune())
  expect(await f.backups.catalog()).toMatchObject({ cleanupError: false, snapshots: [expect.objectContaining({ id })] })
})

it('deletes only the selected backup and protects pending uploads and restores', async () => {
  const f = await retentionFixture()
  const id = await f.add(1)
  const neighbor = await f.add(2)
  f.backups.protectedSnapshots = () => new Set([id])
  await expect(f.backups.run(() => f.backups.remove(id))).rejects.toThrow('SNAPSHOT_IN_USE')
  f.backups.protectedSnapshots = () => new Set()
  f.setPending(id)
  await expect(f.backups.run(() => f.backups.remove(id))).rejects.toThrow('SNAPSHOT_IN_USE')
  f.setPending(null)
  await expect(f.backups.run(() => f.backups.remove('../escape'))).rejects.toThrow()
  await f.backups.run(() => f.backups.remove(id))
  await expect(access(f.backups.snapshots.directory(id))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.backups.snapshots.directory(neighbor), 'files/buddy/buddy.sqlite3'), 'utf8')).toBe('snapshot-2')
})

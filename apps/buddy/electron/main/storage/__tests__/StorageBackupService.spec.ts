import type { DesktopRuntimeHost } from '../../app/DesktopRuntimeHost'
import type { DesktopEnvironment } from '../../app/typing'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { StorageBackupService } from '../StorageBackupService'

it('deletes only the selected backup and protects pending uploads and restores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-delete-backup-'))
  const id = randomUUID()
  const neighbor = randomUUID()
  let pending: { snapshotId: string } | null = null
  const environment = { paths: { lexoraHome: root }, storage: { store: { read: async () => ({ pending }) } } } as unknown as DesktopEnvironment
  const backups = new StorageBackupService(environment, () => null, {} as DesktopRuntimeHost)
  try {
    for (const item of [id, neighbor]) {
      await mkdir(backups.snapshots.directory(item), { recursive: true })
      await writeFile(join(backups.snapshots.directory(item), 'fixture'), 'retained')
    }
    backups.protectedSnapshots = () => new Set([id])
    await expect(backups.run(() => backups.remove(id))).rejects.toThrow('SNAPSHOT_IN_USE')
    backups.protectedSnapshots = () => new Set()
    pending = { snapshotId: id }
    await expect(backups.run(() => backups.remove(id))).rejects.toThrow('SNAPSHOT_IN_USE')
    pending = null
    await expect(backups.run(() => backups.remove('../escape'))).rejects.toThrow()
    await backups.run(() => backups.remove(id))
    await expect(access(backups.snapshots.directory(id))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(backups.snapshots.directory(neighbor), 'fixture'), 'utf8')).toBe('retained')
  }
  finally {
    backups.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

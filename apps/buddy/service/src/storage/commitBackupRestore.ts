import type { StorageOperation } from '../../../shared/storage/storageApi'
import { lstat, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { isMissing, readStorageJson, storageError, syncStorageDirectory, writeStorageJson } from '../../../platform/storage/storageFiles'
import { storageOperationStage } from '../../../platform/storage/storageOperationFiles'
import { persistenceUpgradePaths } from './persistenceMigration/persistenceSources'

const paths = ['buddy', 'config.toml', 'device/sync.json'] as const
const entryPath = z.enum([...paths, ...persistenceUpgradePaths])
const journalSchema = z.object({ id: z.uuid(), entries: z.array(z.object({ path: entryPath, original: z.boolean(), replacement: z.boolean().default(true) }).strict()).min(1) }).strict()
export const restoreStage = storageOperationStage
export const restoreRetained = (operation: StorageOperation) => join(operation.target, 'recovery', `${operation.kind}-${operation.id}`)
function exists(path: string) {
  return lstat(path).catch((error) => {
    if (isMissing(error))
      return null
    throw error
  })
}
export async function prepareRestoreCommit(operation: StorageOperation): Promise<void> {
  const stage = restoreStage(operation)
  const entries = []
  const selected = operation.kind === 'upgrade' ? persistenceUpgradePaths : paths
  for (const path of selected) {
    const replacement = !!await exists(join(stage, 'profile', path))
    const original = !!await exists(join(operation.target, path))
    if (replacement || (operation.kind === 'upgrade' && original && /^buddy\/buddy\.sqlite3-(?:wal|shm|journal)$/.test(path)))
      entries.push({ path, original, replacement })
  }
  await writeStorageJson(join(stage, 'commit.json'), { id: operation.id, entries })
}
export async function commitBackupRestore(operation: StorageOperation): Promise<void> {
  const stage = restoreStage(operation)
  const journal = journalSchema.parse(await readStorageJson(join(stage, 'commit.json')))
  if (journal.id !== operation.id || new Set(journal.entries.map(item => item.path)).size !== journal.entries.length
    || (journal.entries.some(item => item.path === 'buddy') && journal.entries.some(item => item.path.startsWith('buddy/')))) {
    throw storageError('STORAGE_STAGE_NOT_OWNED')
  }
  for (const entry of journal.entries) {
    if ((entry.path.startsWith('buddy/') && operation.kind !== 'upgrade')
      || (!entry.replacement && (operation.kind !== 'upgrade' || !/^buddy\/buddy\.sqlite3-(?:wal|shm|journal)$/.test(entry.path)))) {
      throw storageError('STORAGE_STAGE_NOT_OWNED')
    }
  }
  for (const entry of journal.entries) {
    const candidate = join(stage, 'profile', entry.path)
    const current = join(operation.target, entry.path)
    const retained = join(restoreRetained(operation), entry.path)
    const [next, previous, saved] = await Promise.all([exists(candidate), exists(current), exists(retained)])
    if (!entry.replacement) {
      if (next || !entry.original || (previous && saved) || (!previous && !saved))
        throw storageError('STORAGE_RESTORE_CONFLICT')
      if (previous) {
        await mkdir(dirname(retained), { recursive: true, mode: 0o700 })
        await rename(current, retained)
        await syncStorageDirectory(dirname(retained))
        await syncStorageDirectory(dirname(current))
      }
      continue
    }
    if (next) {
      if (previous) {
        if (saved || !entry.original)
          throw storageError('STORAGE_RESTORE_CONFLICT')
        await mkdir(dirname(retained), { recursive: true, mode: 0o700 })
        await rename(current, retained)
        await syncStorageDirectory(dirname(retained))
        await syncStorageDirectory(dirname(current))
      }
      else if (entry.original && !saved) {
        throw storageError('STORAGE_RESTORE_CONFLICT')
      }
      await mkdir(dirname(current), { recursive: true, mode: 0o700 })
      await rename(candidate, current)
      await syncStorageDirectory(dirname(candidate))
      await syncStorageDirectory(dirname(current))
    }
    else if (!previous || (entry.original && !saved)) {
      throw storageError('STORAGE_RESTORE_CONFLICT')
    }
  }
}

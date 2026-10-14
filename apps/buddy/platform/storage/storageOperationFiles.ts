import type { StorageOperation } from '../../shared/storage/storageApi'
import { lstat, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { isMissing, readStorageJson, storageError, writeStorageJson } from './storageFiles'

export function storageOperationStage(operation: StorageOperation): string {
  return operation.kind === 'relocate'
    ? join(dirname(operation.target), `.${basename(operation.target)}.storage-${operation.id}`)
    : join(operation.target, `.storage-${operation.id}`)
}

export function restoreCredentialStage(locationPath: string, operationId: string): string {
  return join(dirname(locationPath), 'restore-secrets', operationId)
}

async function removeOwnedStage(operation: StorageOperation): Promise<void> {
  const stage = storageOperationStage(operation)
  const existing = await lstat(stage).catch((error) => {
    if (isMissing(error))
      return null
    throw error
  })
  if (!existing)
    return
  if (!existing.isDirectory() || existing.isSymbolicLink())
    throw storageError('STORAGE_STAGE_NOT_OWNED')
  const owner = await readStorageJson(join(stage, '.storage-owner.json'))
  if (!owner || typeof owner !== 'object' || !('id' in owner) || owner.id !== operation.id)
    throw storageError('STORAGE_STAGE_NOT_OWNED')
  await rm(stage, { recursive: true })
}

export async function prepareStorageStage(operation: StorageOperation, privateDirectoriesExecutable?: string): Promise<string> {
  await removeOwnedStage(operation)
  const stage = storageOperationStage(operation)
  await ensurePrivateDirectories([stage], privateDirectoriesExecutable)
  await writeStorageJson(join(stage, '.storage-owner.json'), { id: operation.id })
  return stage
}

export async function discardStorageOperation(operation: StorageOperation, locationPath: string): Promise<void> {
  if (operation.phase === 'ready')
    throw storageError('STORAGE_COMMITTING')
  await removeOwnedStage(operation)
  await rm(restoreCredentialStage(locationPath, operation.id), { recursive: true, force: true })
}

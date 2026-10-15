import type { StorageCopyPlan, StorageReporter } from '../../../platform/storage/storageTree'
import type { StorageIdentity, StorageOperation, StorageProgress } from '../../../shared/storage/storageApi'
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { ensurePrivateDirectories } from '../../../platform/filesystem/privateDirectories'
import { legacyStorageExcluded, migrationStorageExcluded } from '../../../platform/storage/storageCopyPolicy'
import { isMissing, readStorageJson, storageError, syncStorageDirectory, syncStorageFile, writeStorageJson } from '../../../platform/storage/storageFiles'
import { assertStorageIdentity, STORAGE_IDENTITY_FILE, StorageLocationStore } from '../../../platform/storage/StorageLocationStore'
import { prepareStorageStage, restoreCredentialStage } from '../../../platform/storage/storageOperationFiles'
import { acquireStorageRootLease } from '../../../platform/storage/StorageRootLease'
import { copyStorageTree, planStorageCopy, syncStorageDirectories } from '../../../platform/storage/storageTree'
import { storageIdentitySchema } from '../../../shared/storage/storageApi'
import { commitBackupRestore, prepareRestoreCommit, restoreRetained, restoreStage } from './commitBackupRestore'
import { openBuddyDatabase } from './database'
import { relocateDatabaseReferences, relocateProfileJournals, relocateStructuredPaths, verifyProfileReferences } from './relocateProfileReferences'
import { prepareBackupRestore } from './restoreBackup'

export interface LegacyStorageSource {
  source: string
  destination: string
}
export interface StorageMigrationInput {
  locationPath: string
  defaultRoot: string
  leaseDirectory?: string
  privateDirectoriesExecutable?: string
  legacySources: LegacyStorageSource[]
}
export async function runStorageMigration(input: StorageMigrationInput, signal: AbortSignal, report: StorageReporter): Promise<void> {
  const store = new StorageLocationStore(input.locationPath, input.defaultRoot)
  const state = await store.read()
  const operation = state.pending
  if (!operation)
    throw storageError('STORAGE_OPERATION_MISSING')
  const resumingCommit = operation.phase === 'ready'
  const activeSignal = resumingCommit ? new AbortController().signal : signal
  const checkpoint = (phase: StorageOperation['phase']) => resumingCommit && phase !== 'ready' ? Promise.resolve() : store.checkpoint(operation, phase)
  let releaseTarget = () => {}
  let progress: StorageProgress = { phase: 'preparing', completedBytes: 0, totalBytes: null, files: 0, error: null }
  const publish = (next: Partial<StorageProgress>) => {
    progress = { ...progress, ...next }
    report(progress)
  }
  try {
    if (operation.source !== operation.target)
      releaseTarget = acquireStorageRootLease(operation.target, input.leaseDirectory, input.privateDirectoriesExecutable)
    await checkpoint('copying')
    activeSignal.throwIfAborted()
    const retainedPath = operation.kind === 'restore' && operation.source === operation.target ? restoreRetained(operation) : join(dirname(operation.target), `.${basename(operation.target)}.retained-${operation.id}`)
    const retained = async () => await lstat(retainedPath).catch((error) => {
      if (!isMissing(error))
        throw error
      return null
    })
      ? retainedPath
      : undefined
    const identity: StorageIdentity = { version: 1, dataId: state.identity?.dataId ?? operation.id, generation: operation.id, layoutVersion: 1 }
    const activate = async () => {
      if (operation.source !== operation.target)
        await writeStorageJson(join(operation.source, '.storage-retired.json'), { operationId: operation.id, target: operation.target })
      await store.activate(operation, identity, await retained())
      if (operation.kind === 'restore' && operation.source === operation.target) {
        await rm(restoreStage(operation), { recursive: true, force: true })
        await rm(restoreCredentialStage(input.locationPath, operation.id), { recursive: true, force: true })
      }
    }
    const descriptor = await readStorageJson(join(operation.target, STORAGE_IDENTITY_FILE))
    if (resumingCommit && descriptor && storageIdentitySchema.parse(descriptor).generation === operation.id) {
      await activate()
      publish({ phase: 'completed' })
      return
    }
    await assertStorageIdentity(state)
    if (operation.kind === 'restore' && operation.source === operation.target) {
      if (!resumingCommit) {
        const stage = await prepareStorageStage(operation, input.privateDirectoriesExecutable)
        await prepareBackupRestore(operation, stage, input.locationPath, activeSignal, publish, input.privateDirectoriesExecutable)
        activeSignal.throwIfAborted()
        await prepareRestoreCommit(operation)
        await checkpoint('ready')
      }
      publish({ phase: 'activating' })
      await commitBackupRestore(operation)
    }
    else if (operation.kind === 'consolidate') {
      await consolidateStorage(operation, input.legacySources, activeSignal, publish, input.privateDirectoriesExecutable)
      activeSignal.throwIfAborted()
      await store.checkpoint(operation, 'ready')
    }
    else {
      const existing = await readStorageJson(join(operation.target, STORAGE_IDENTITY_FILE))
      if (existing && storageIdentitySchema.parse(existing).generation === operation.id) {
        await store.checkpoint(operation, 'ready')
        await activate()
        publish({ phase: 'completed' })
        return
      }
      await relocateStorage(operation, identity, activeSignal, publish, checkpoint, input.privateDirectoriesExecutable)
    }
    publish({ phase: 'activating' })
    await writeStorageJson(join(operation.target, STORAGE_IDENTITY_FILE), identity)
    await activate()
    publish({ phase: 'completed' })
  }
  catch (error) {
    const current = await store.read()
    if (!current.pending && current.identity?.generation === operation.id) {
      publish({ phase: 'completed' })
      return
    }
    const cancelled = activeSignal.aborted && current.pending?.phase !== 'ready'
    const code = cancelled ? 'STORAGE_CANCELLED' : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'STORAGE_MIGRATION_FAILED'
    if (current.pending?.id === operation.id)
      await store.checkpoint(operation, current.pending.phase === 'ready' ? 'ready' : 'failed', code)
    publish({ phase: cancelled ? 'cancelled' : 'failed', error: code })
    throw Object.assign(storageError(code), { cause: error })
  }
  finally {
    releaseTarget()
  }
}
async function consolidateStorage(operation: StorageOperation, sources: LegacyStorageSource[], signal: AbortSignal, report: StorageReporter, privateDirectoriesExecutable?: string): Promise<void> {
  await ensurePrivateDirectories([operation.source], privateDirectoriesExecutable)
  const stage = await prepareStorageStage(operation, privateDirectoriesExecutable)
  const copies: Array<LegacyStorageSource & { plan: StorageCopyPlan }> = []
  for (const { source, destination } of sources) {
    if (destination === 'logs' || destination === 'device/crashes')
      continue
    signal.throwIfAborted()
    if (!await lstat(source).catch((error) => {
      if (!isMissing(error))
        throw error
      return null
    })) {
      continue
    }
    const target = join(operation.source, destination)
    const imported = await readStorageJson(join(target, '.storage-import.json'))
    if (imported && typeof imported === 'object' && 'operation' in imported && imported.operation === operation.id)
      continue
    if (await lstat(target).catch((error) => {
      if (!isMissing(error))
        throw error
      return null
    })) {
      throw storageError('STORAGE_TARGET_NOT_EMPTY')
    }
    const plan = await planStorageCopy(source, { signal, report, exclude: path => legacyStorageExcluded(destination, path) })
    copies.push({ source, destination, plan })
  }
  const totalBytes = copies.reduce((total, copy) => total + copy.plan.totalBytes, 0)
  let completedBytes = 0
  let files = 0
  for (const { source, destination, plan } of copies) {
    signal.throwIfAborted()
    const target = join(operation.source, destination)
    const candidate = join(stage, destination)
    await copyStorageTree(source, candidate, {
      signal,
      report: progress => report({ ...progress, totalBytes, completedBytes: completedBytes + progress.completedBytes, files: files + progress.files, category: destination === 'device/state' ? 'preferences' : 'browser' }),
      destinationRoot: target,
      privateDirectoriesExecutable,
      plan,
    })
    await writeStorageJson(join(candidate, '.storage-import.json'), { operation: operation.id })
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(candidate, target)
    await syncStorageDirectory(dirname(target))
    completedBytes += plan.totalBytes
    files += plan.entries.filter(entry => !entry.directory).length
  }
  await rm(stage, { recursive: true })
}
async function relocateStorage(operation: StorageOperation, identity: StorageIdentity, signal: AbortSignal, report: StorageReporter, checkpoint: (phase: StorageOperation['phase']) => Promise<void>, privateDirectoriesExecutable?: string): Promise<void> {
  const stage = await prepareStorageStage(operation, privateDirectoriesExecutable)
  const candidate = join(stage, 'profile')
  await copyStorageTree(operation.source, candidate, { signal, report, destinationRoot: operation.target, privateDirectoriesExecutable, exclude: migrationStorageExcluded })
  signal.throwIfAborted()
  await checkpoint('converting')
  report({ phase: 'converting', completedBytes: 0, totalBytes: null, files: 0, error: null })
  const databasePath = join(candidate, 'buddy', 'buddy.sqlite3')
  const exists = await lstat(databasePath).catch((error) => {
    if (!isMissing(error))
      throw error
    return null
  })
  if (exists) {
    if (!exists.isFile() || exists.isSymbolicLink())
      throw storageError('STORAGE_DATABASE_INVALID')
    const database = openBuddyDatabase({ databasePath })
    try {
      relocateDatabaseReferences(database, operation.source, operation.target)
      await relocateProfileJournals(candidate, operation.source, operation.target, signal)
      await checkpoint('verifying')
      report({ phase: 'verifying', completedBytes: 0, totalBytes: null, files: 0, error: null })
      if (Object.values(database.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok')
        throw storageError('STORAGE_DATABASE_INVALID')
      await verifyProfileReferences(database, candidate, operation.target)
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    }
    finally {
      database.close()
    }
    await syncStorageFile(databasePath)
  }
  const config = join(candidate, 'config.toml')
  const text = await readFile(config, 'utf8').catch((error) => {
    if (!isMissing(error))
      throw error
    return null
  })
  if (text !== null)
    await writeFile(config, stringify(relocateStructuredPaths(parse(text), operation.source, operation.target) as ReturnType<typeof parse>), { mode: 0o600, flush: true })
  signal.throwIfAborted()
  await writeStorageJson(join(candidate, STORAGE_IDENTITY_FILE), identity)
  await syncStorageDirectories(candidate)
  signal.throwIfAborted()
  const targetIdentity = await readStorageJson(join(operation.target, STORAGE_IDENTITY_FILE))
  if (targetIdentity && storageIdentitySchema.parse(targetIdentity).dataId !== identity.dataId)
    throw storageError('STORAGE_TARGET_NOT_EMPTY')
  if (!targetIdentity && (await readdir(operation.target).catch((error) => {
    if (!isMissing(error))
      throw error
    return []
  })).length) {
    throw storageError('STORAGE_TARGET_NOT_EMPTY')
  }
  signal.throwIfAborted()
  await checkpoint('ready')
  report({ phase: 'activating', completedBytes: 0, totalBytes: null, files: 0, error: null })
  if (targetIdentity) {
    await rename(operation.target, join(dirname(operation.target), `.${basename(operation.target)}.retained-${operation.id}`))
  }
  else {
    await rmdir(operation.target).catch((error) => {
      if (!isMissing(error))
        throw error
    })
  }
  await rename(candidate, operation.target)
  await syncStorageDirectory(dirname(operation.target))
  await rm(stage, { recursive: true })
}

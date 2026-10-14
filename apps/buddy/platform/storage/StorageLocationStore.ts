import type { BackupScope } from '../../shared/storage/backupScope'
import type { StorageHistory, StorageIdentity, StorageOperation } from '../../shared/storage/storageApi'
import { randomUUID } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { z } from 'zod'
import { storageHistorySchema, storageIdentitySchema, storageOperationSchema } from '../../shared/storage/storageApi'
import { canonicalStoragePath, containsStoragePath, isMissing, readStorageJson, storageError, writeStorageJson } from './storageFiles'
import { discardStorageOperation } from './storageOperationFiles'

export const STORAGE_IDENTITY_FILE = 'storage.json'
export const storageLocationSchema = z.object({
  version: z.literal(1),
  activeRoot: z.string().min(1),
  identity: storageIdentitySchema.nullable(),
  pending: storageOperationSchema.nullable(),
  history: z.array(storageHistorySchema),
}).strict()
export type StorageLocation = z.infer<typeof storageLocationSchema>
export class StorageLocationStore {
  readonly path: string
  readonly defaultRoot: string
  constructor(path: string, defaultRoot: string) {
    this.path = path
    this.defaultRoot = defaultRoot
  }

  async read(): Promise<StorageLocation> {
    const raw = await readStorageJson(this.path)
    return raw === null
      ? { version: 1, activeRoot: this.defaultRoot, identity: null, pending: null, history: [] }
      : storageLocationSchema.parse(raw)
  }

  async write(value: StorageLocation): Promise<void> {
    await writeStorageJson(this.path, storageLocationSchema.parse(value))
  }

  async request(kind: StorageOperation['kind'], target: string, protectedRoots: string[] = [], snapshotId?: string, scopes?: BackupScope[], credentials = false, operationId = randomUUID()): Promise<StorageLocation> {
    const state = await this.read()
    if (state.pending)
      throw storageError('STORAGE_OPERATION_PENDING')
    await assertStorageIdentity(state)
    const restoringHere = kind === 'restore' && await canonicalStoragePath(target) === await canonicalStoragePath(state.activeRoot)
    if (kind === 'restore' && !restoringHere)
      throw storageError('STORAGE_RESTORE_ROOT_MISMATCH')
    const canonical = restoringHere ? state.activeRoot : await validateStorageTarget(state.activeRoot, target, [dirname(this.path), ...protectedRoots], state.identity?.dataId)
    const pending: StorageOperation = { id: operationId, kind, ...(kind === 'restore' ? { credentials } : {}), ...(scopes ? { scopes } : {}), ...(snapshotId ? { snapshotId } : {}), source: state.activeRoot, target: canonical, phase: 'pending', error: null, createdAt: new Date().toISOString() }
    const next = { ...state, pending }
    await this.write(next)
    return next
  }

  async activate(operation: StorageOperation, identity: StorageIdentity, retainedTarget?: string): Promise<void> {
    const state = await this.read()
    if (state.pending?.id !== operation.id || state.activeRoot !== operation.source || state.pending.phase !== 'ready')
      throw storageError('STORAGE_OPERATION_CHANGED')
    const history: StorageHistory = { id: operation.id, kind: operation.kind, source: operation.source, target: operation.target, ...(retainedTarget ? { retainedTarget } : {}), completedAt: new Date().toISOString() }
    await this.write({ ...state, activeRoot: operation.target, identity, pending: null, history: [...state.history, history] })
  }

  async checkpoint(operation: StorageOperation, phase: StorageOperation['phase'], error: string | null = null): Promise<void> {
    const state = await this.read()
    if (state.pending?.id !== operation.id || state.activeRoot !== operation.source)
      throw storageError('STORAGE_OPERATION_CHANGED')
    const transitions: Record<StorageOperation['phase'], StorageOperation['phase'][]> = {
      pending: ['copying', 'failed'],
      copying: ['copying', 'converting', 'ready', 'failed'],
      converting: ['copying', 'verifying', 'ready', 'failed'],
      verifying: ['copying', 'ready', 'failed'],
      ready: ['ready'],
      failed: ['copying', 'failed'],
    }
    if (!transitions[state.pending.phase].includes(phase))
      throw storageError('STORAGE_INVALID_TRANSITION')
    await this.write({ ...state, pending: { ...state.pending, phase, error } })
  }

  async cancel(): Promise<void> {
    const state = await this.read()
    if (state.pending)
      await discardStorageOperation(state.pending, this.path)
    await this.write({ ...state, pending: null })
  }
}
export async function assertStorageIdentity(state: StorageLocation): Promise<void> {
  const raw = await readStorageJson(join(state.activeRoot, STORAGE_IDENTITY_FILE))
  const identity = raw === null ? null : storageIdentitySchema.parse(raw)
  if (state.identity && (!identity || identity.dataId !== state.identity.dataId || identity.generation !== state.identity.generation))
    throw storageError('STORAGE_IDENTITY_MISMATCH')
  if (state.identity && !(await lstat(state.activeRoot)).isDirectory())
    throw storageError('STORAGE_ROOT_UNAVAILABLE')
}
export async function validateStorageTarget(source: string, target: string, protectedRoots: string[], dataId?: string): Promise<string> {
  const [from, to] = await Promise.all([canonicalStoragePath(source), canonicalStoragePath(target)])
  if (containsStoragePath(from, to) || containsStoragePath(to, from) || parse(to).root === to)
    throw storageError('STORAGE_PATH_OVERLAP')
  for (const root of protectedRoots) {
    const protectedPath = await canonicalStoragePath(root)
    if (containsStoragePath(to, protectedPath) || containsStoragePath(protectedPath, to))
      throw storageError('STORAGE_PROTECTED_PATH')
  }
  let ancestor = dirname(to)
  while (dirname(ancestor) !== ancestor) {
    if (await readStorageJson(join(ancestor, STORAGE_IDENTITY_FILE)))
      throw storageError('STORAGE_PROTECTED_PATH')
    ancestor = dirname(ancestor)
  }
  try {
    const metadata = await lstat(to)
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw storageError('STORAGE_TARGET_NOT_EMPTY')
    if ((await readdir(to)).length) {
      const identity = storageIdentitySchema.safeParse(await readStorageJson(join(to, STORAGE_IDENTITY_FILE)))
      if (!dataId || !identity.success || identity.data.dataId !== dataId)
        throw storageError('STORAGE_TARGET_NOT_EMPTY')
    }
  }
  catch (error) {
    if (!isMissing(error))
      throw error
  }
  return to
}

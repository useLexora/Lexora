import type { StorageLocation } from '../../../platform/storage/StorageLocationStore'
import type { LegacyStorageSource } from '../../../service/src/storage/StorageMigration'
import type { BuddyRuntimePaths } from '../paths'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensurePrivateDirectoriesSync } from '../../../platform/filesystem/privateDirectories'
import { profileStorageProtection } from '../../../platform/storage/ProfileLocations'
import { legacyStorageExcluded } from '../../../platform/storage/storageCopyPolicy'
import { readStorageJsonSync, storageError, writeStorageJsonSync } from '../../../platform/storage/storageFiles'
import { STORAGE_IDENTITY_FILE, storageLocationSchema, StorageLocationStore } from '../../../platform/storage/StorageLocationStore'
import { storageIdentitySchema } from '../../../shared/storage/storageApi'
import { StorageUnavailableError } from './storageUnavailable'

export interface DesktopStorage {
  store: StorageLocationStore
  state: StorageLocation
  legacySources: LegacyStorageSource[]
  bootstrapRoot: string
  leaseDirectory: string
  protection: ReturnType<typeof profileStorageProtection>
  privateDirectoriesExecutable?: string
}
export function storageBootstrapRoot(root: string): string {
  return join(dirname(root), '.lexora-locations', createHash('sha256').update(root).digest('hex').slice(0, 24))
}
export function readStorageBootstrap(defaultRoot: string) {
  const bootstrapRoot = storageBootstrapRoot(defaultRoot)
  const store = new StorageLocationStore(join(bootstrapRoot, 'location.json'), defaultRoot)
  const raw = readStorageJsonSync(store.path)
  const state: StorageLocation = raw === null ? { version: 1, activeRoot: defaultRoot, identity: null, pending: null, history: [] } : storageLocationSchema.parse(raw)
  if (raw === null && readStorageJsonSync(join(state.activeRoot, '.storage-retired.json')))
    throw new StorageUnavailableError(state.activeRoot)
  const descriptor = readStorageJsonSync(join(state.activeRoot, STORAGE_IDENTITY_FILE))
  if (state.identity) {
    const identity = storageIdentitySchema.safeParse(descriptor)
    const finishingRestore = state.pending?.kind === 'restore' && state.pending.phase === 'ready' && state.pending.target === state.activeRoot
    if (!identity.success || identity.data.dataId !== state.identity.dataId || (identity.data.generation !== state.identity.generation && !(finishingRestore && identity.data.generation === state.pending?.id)))
      throw new StorageUnavailableError(state.activeRoot)
  }
  return { bootstrapRoot, store, state, descriptor }
}
export function prepareStorageBootstrap(legacy: BuddyRuntimePaths, privateDirectoriesExecutable?: string): DesktopStorage {
  const initial = readStorageBootstrap(legacy.lexoraHome)
  const { bootstrapRoot, store, descriptor } = initial
  let { state } = initial
  const legacySources: LegacyStorageSource[] = [
    { source: legacy.userData, destination: 'device/electron' },
    { source: legacy.sessionData, destination: 'device/chromium' },
    { source: dirname(legacy.windowState), destination: 'device/state' },
  ]
  if (!state.identity && !state.pending) {
    if (descriptor !== null) {
      state = { ...state, identity: storageIdentitySchema.parse(descriptor) }
    }
    else if (legacySources.some(({ source, destination }) => existsSync(source) && readdirSync(source).some(name => !legacyStorageExcluded(destination, name)))) {
      state = { ...state, pending: { id: randomUUID(), kind: 'consolidate', source: state.activeRoot, target: state.activeRoot, phase: 'pending', createdAt: new Date().toISOString(), error: null } }
    }
    else {
      const identity = { version: 1 as const, layoutVersion: 1 as const, dataId: randomUUID(), generation: randomUUID() }
      ensurePrivateDirectoriesSync([state.activeRoot], privateDirectoriesExecutable)
      if (!lstatSync(state.activeRoot).isDirectory())
        throw storageError('STORAGE_ROOT_UNAVAILABLE')
      writeStorageJsonSync(join(state.activeRoot, STORAGE_IDENTITY_FILE), identity)
      state = { ...state, identity }
    }
    ensurePrivateDirectoriesSync([bootstrapRoot], privateDirectoriesExecutable)
    writeStorageJsonSync(store.path, state)
  }
  const leaseDirectory = join(legacy.profile === 'test' ? dirname(legacy.lexoraHome) : homedir(), '.lexora-locations', 'locks')
  const protection = profileStorageProtection({ activeRoot: state.activeRoot, defaultRoot: legacy.lexoraHome, bootstrapRoot, leaseDirectory, history: state.history, legacyRoots: legacySources.map(item => item.source) })
  return { store, state, legacySources, bootstrapRoot, leaseDirectory, protection, privateDirectoriesExecutable }
}
export function unifiedStoragePaths(legacy: BuddyRuntimePaths, root: string): BuddyRuntimePaths {
  return {
    ...legacy,
    lexoraHome: root,
    buddyHome: join(root, 'buddy'),
    agentDirectory: join(root, 'buddy', 'agent'),
    configPath: join(root, 'config.toml'),
    userData: join(root, 'device', 'electron'),
    sessionData: join(root, 'device', 'chromium'),
    logs: join(root, 'logs'),
    crashDumps: join(root, 'device', 'crashes'),
    windowState: join(root, 'device', 'state', 'window-state.json'),
    nativePetState: legacy.nativePetState ? join(root, 'device', 'state', 'pet-state.json') : null,
  }
}

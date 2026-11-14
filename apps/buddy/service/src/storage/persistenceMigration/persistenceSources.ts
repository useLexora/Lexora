import type { BigIntStats } from 'node:fs'
import type { StorageCopyPlan, StorageEntry, StorageReporter } from '../../../../platform/storage/storageTree'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { containsStoragePath, isMissing, readStorageJson, writeStorageJson } from '../../../../platform/storage/storageFiles'
import { copyStorageTree, hashStorageFile, planStorageCopy } from '../../../../platform/storage/storageTree'
import { PersistenceMigrationError } from './legacyRunHistory'

const sourceEntrySchema = z.object({
  path: z.string().min(1).refine(value => !isAbsolute(value) && !value.split(/[\\/]/).some(segment => segment === '..' || segment === '.')),
  size: z.number().int().nonnegative(),
  link: z.string().nullable(),
  mtimeMs: z.number(),
  directory: z.boolean(),
  executable: z.boolean(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  identity: z.string(),
}).strict()
const sourceManifestSchema = z.object({
  version: z.literal(1),
  scope: z.enum(['profile', 'upgrade']).default('profile'),
  sourceRoot: z.string(),
  candidateRoot: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  copied: z.boolean(),
  workingCopyReady: z.boolean(),
  entries: z.array(sourceEntrySchema),
}).strict()
export type PersistenceSourceManifest = z.infer<typeof sourceManifestSchema>
export type PersistenceSourceEntry = PersistenceSourceManifest['entries'][number]
const MANIFEST_NAME = '.persistence-migration.json'

export const persistenceUpgradePaths = [
  'buddy/buddy.sqlite3',
  'buddy/buddy.sqlite3-wal',
  'buddy/buddy.sqlite3-shm',
  'buddy/buddy.sqlite3-journal',
  'buddy/conversations',
  'buddy/drafts',
  'buddy/spaces',
  'buddy/agent',
  'buddy/skills',
] as const

export function persistenceUpgradeIncludes(path: string): boolean {
  return path === 'buddy' || persistenceUpgradePaths.some(root => path === root || path.startsWith(`${root}/`))
}

function sourceExcluded(path: string, scope: PersistenceSourceManifest['scope']): boolean {
  return path === '.runtime' || path === 'buddy/buddy.sqlite3-shm'
    || (scope === 'upgrade' && !persistenceUpgradeIncludes(path))
}

export async function readPersistenceSourceManifest(candidateRoot: string): Promise<PersistenceSourceManifest | null> {
  const value = await readStorageJson(join(candidateRoot, MANIFEST_NAME))
  if (!value)
    return null
  const manifest = sourceManifestSchema.parse(value)
  if (manifest.candidateRoot !== resolve(candidateRoot) || sourceDigest(manifest.entries) !== manifest.fingerprint)
    throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
  return manifest
}

export async function preparePersistenceSources(input: {
  sourceRoot: string
  candidateRoot: string
  signal: AbortSignal
  scope?: PersistenceSourceManifest['scope']
  report?: StorageReporter
}): Promise<PersistenceSourceManifest> {
  const { signal } = input
  const scope = input.scope ?? 'profile'
  const report = input.report ?? (() => {})
  const sourceRoot = await realpath(input.sourceRoot)
  const candidateRoot = resolve(input.candidateRoot)
  if (!isAbsolute(input.sourceRoot) || !isAbsolute(input.candidateRoot)
    || containsStoragePath(sourceRoot, candidateRoot) || containsStoragePath(candidateRoot, sourceRoot)
    || await realpath(dirname(candidateRoot)) !== dirname(candidateRoot)) {
    throw new PersistenceMigrationError('MIGRATION_CANDIDATE_PATH_INVALID')
  }
  const manifestPath = join(candidateRoot, MANIFEST_NAME)
  const target = await lstat(candidateRoot).catch((error) => {
    if (!isMissing(error))
      throw error
    return null
  })
  if (target?.isSymbolicLink() || (target && !target.isDirectory()))
    throw new PersistenceMigrationError('MIGRATION_CANDIDATE_PATH_INVALID')
  const previous = target ? await readStorageJson(manifestPath) : null
  if (target && !previous)
    throw new PersistenceMigrationError('MIGRATION_TARGET_NOT_EMPTY')
  const plan = await planStorageCopy(sourceRoot, {
    signal,
    report,
    exclude: path => sourceExcluded(path, scope),
  })
  if (plan.entries.some(entry => entry.path === MANIFEST_NAME))
    throw new PersistenceMigrationError('MIGRATION_SOURCE_ALREADY_CANDIDATE')
  const entries = await fingerprintEntries(sourceRoot, plan, signal, report, 'preparing')
  if (!entries.some(entry => entry.path === 'buddy/buddy.sqlite3' && entry.digest))
    throw new PersistenceMigrationError('MIGRATION_DATABASE_MISSING')
  const fingerprint = sourceDigest(entries)
  let manifest: PersistenceSourceManifest = { version: 1, scope, sourceRoot, candidateRoot, fingerprint, copied: false, workingCopyReady: false, entries }
  if (previous) {
    manifest = sourceManifestSchema.parse(previous)
    if (manifest.scope !== scope || manifest.sourceRoot !== sourceRoot || manifest.candidateRoot !== candidateRoot
      || manifest.fingerprint !== fingerprint || sourceDigest(manifest.entries) !== fingerprint) {
      throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
    }
    if (manifest.copied)
      return manifest
  }
  else {
    await mkdir(candidateRoot, { mode: 0o700 })
    await writeStorageJson(manifestPath, manifest)
  }
  await copyStorageTree(sourceRoot, join(candidateRoot, 'source'), { signal, report, plan, overwrite: !!previous })
  await verifyPersistenceSources(manifest, signal, report)
  manifest = { ...manifest, copied: true }
  await writeStorageJson(manifestPath, manifest)
  return manifest
}

export async function preparePersistenceWorkingCopy(manifest: PersistenceSourceManifest, signal: AbortSignal, report: StorageReporter = () => {}): Promise<string> {
  const profile = join(manifest.candidateRoot, 'profile')
  const source = join(manifest.candidateRoot, 'source')
  const plan = await planStorageCopy(source, { signal, report, exclude: path => path === 'buddy/buddy.sqlite3-shm' })
  const snapshot = await fingerprintEntries(source, plan, signal, report, 'verifying')
  const digests = new Map(snapshot.map(entry => [entry.path, entry.digest]))
  for (const entry of manifest.entries) {
    if (entry.digest && digests.get(entry.path) !== entry.digest)
      throw new PersistenceMigrationError('MIGRATION_SNAPSHOT_CHANGED')
  }
  if (manifest.workingCopyReady)
    return profile
  await copyStorageTree(source, profile, { signal, report, plan, overwrite: true })
  manifest.workingCopyReady = true
  await writeStorageJson(join(manifest.candidateRoot, MANIFEST_NAME), manifest)
  return profile
}

export async function verifyPersistenceSources(manifest: PersistenceSourceManifest, signal: AbortSignal, report: StorageReporter = () => {}): Promise<void> {
  const plan = await planStorageCopy(manifest.sourceRoot, { signal, report, exclude: path => sourceExcluded(path, manifest.scope) })
  if (sourceDigest(await fingerprintEntries(manifest.sourceRoot, plan, signal, report, 'verifying')) !== manifest.fingerprint)
    throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
}

export async function readPersistenceSource(manifest: PersistenceSourceManifest, path: string): Promise<string | null> {
  const entry = manifest.entries.find(item => item.path === path)
  if (!entry)
    return null
  if (entry.link || entry.directory || !entry.digest)
    throw new PersistenceMigrationError('MIGRATION_SOURCE_NOT_REGULAR')
  const content = await readFile(join(manifest.candidateRoot, 'source', path))
  if (createHash('sha256').update(content).digest('hex') !== entry.digest)
    throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
  return content.toString('utf8')
}

async function fingerprintEntries(root: string, plan: StorageCopyPlan, signal: AbortSignal, report: StorageReporter, phase: 'preparing' | 'verifying'): Promise<PersistenceSourceEntry[]> {
  const entries: PersistenceSourceEntry[] = []
  let completedBytes = 0
  let lastReport = 0
  for (const entry of plan.entries) {
    signal.throwIfAborted()
    const before = await lstat(join(root, entry.path), { bigint: true })
    const digest = entry.directory || entry.link !== null ? null : await hashStorageFile(join(root, entry.path), signal)
    const after = await lstat(join(root, entry.path), { bigint: true })
    if (identity(before) !== identity(after))
      throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
    entries.push({ ...entry, digest, identity: identity(after) })
    completedBytes += entry.size
    if (Date.now() - lastReport >= 100) {
      report({ phase, completedBytes, totalBytes: plan.totalBytes, files: entries.length, error: null })
      lastReport = Date.now()
    }
  }
  report({ phase, completedBytes, totalBytes: plan.totalBytes, files: entries.length, error: null })
  return entries
}

function identity(metadata: BigIntStats): string {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs, metadata.birthtimeNs].join(':')
}

function sourceDigest(entries: readonly (StorageEntry & { digest: string | null, identity: string })[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

import type { DatabaseSync } from 'node:sqlite'
import type { StorageReporter } from '../../../../platform/storage/storageTree'
import type { PersistenceSourceManifest } from './persistenceSources'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { DatabaseSync as ReadonlyDatabase } from 'node:sqlite'
import { containsStoragePath } from '../../../../platform/storage/storageFiles'
import { acquireStorageRootLease, assertStorageRootLease } from '../../../../platform/storage/StorageRootLease'
import { hashStorageFile } from '../../../../platform/storage/storageTree'
import { RUN_EVENT_PROJECTION_VERSION } from '../../events/RunEventRecovery'
import { createAttachmentPersistenceRepository } from '../attachmentPersistenceRepository'
import { openBuddyMigrationCandidate } from '../database'
import { relocateDatabaseReferences, relocateProfileJournals, relocateStructuredPaths } from '../relocateProfileReferences'
import { withTransaction } from '../transaction'
import { importLegacyRunHistory, PERSISTENCE_MIGRATION_ID, PersistenceMigrationError } from './legacyRunHistory'
import { preparePersistenceSources, preparePersistenceWorkingCopy, readPersistenceSource, verifyPersistenceSources } from './persistenceSources'

export interface PersistenceCandidateInput {
  sourceRoot: string
  sourceLease?: () => void
  candidateRoot: string
  signal: AbortSignal
  scope?: PersistenceSourceManifest['scope']
  report?: StorageReporter
  leaseDirectory?: string
  privateDirectoriesExecutable?: string
  checkpoint?: (phase: 'copied' | 'run' | 'files' | 'verified') => Promise<void>
}

export async function importPersistenceCandidate(input: PersistenceCandidateInput): Promise<{ profileRoot: string, sourceFingerprint: string, runs: number, files: number }> {
  if (input.sourceLease)
    assertStorageRootLease(input.sourceLease, input.sourceRoot)
  const release = input.sourceLease ? undefined : acquireStorageRootLease(input.sourceRoot, input.leaseDirectory, input.privateDirectoriesExecutable)
  try {
    const releaseCandidate = acquireStorageRootLease(join(input.candidateRoot, 'profile'), input.leaseDirectory, input.privateDirectoriesExecutable)
    try {
      return await importCandidate(input)
    }
    finally { releaseCandidate() }
  }
  finally { release?.() }
}

async function importCandidate(input: PersistenceCandidateInput): Promise<{ profileRoot: string, sourceFingerprint: string, runs: number, files: number }> {
  const manifest = await preparePersistenceSources(input)
  const profileRoot = await preparePersistenceWorkingCopy(manifest, input.signal, input.report)
  await input.checkpoint?.('copied')
  const original = new ReadonlyDatabase(join(manifest.candidateRoot, 'source/buddy/buddy.sqlite3'), { readOnly: true })
  let database: DatabaseSync | undefined
  try {
    const sourceSchema = Number(original.prepare('PRAGMA user_version').get()!.user_version)
    database = openBuddyMigrationCandidate({ databasePath: join(profileRoot, 'buddy/buddy.sqlite3') })
    const previous = database.prepare('SELECT * FROM persistence_migrations WHERE id = ?').get(PERSISTENCE_MIGRATION_ID)
    if (previous && previous.source_fingerprint !== manifest.fingerprint)
      throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
    if (previous?.state === 'activated')
      throw new PersistenceMigrationError('MIGRATION_ALREADY_ACTIVATED')
    if (!previous) {
      withTransaction(database, () => {
        database!.prepare(`INSERT INTO persistence_migrations (id, source_fingerprint, source_schema, state, created_at)
          VALUES (?, ?, ?, 'importing', ?)`).run(PERSISTENCE_MIGRATION_ID, manifest.fingerprint, sourceSchema, new Date().toISOString())
      })
    }
    relocateDatabaseReferences(database, manifest.sourceRoot, profileRoot)
    const runs = database.prepare('SELECT id, conversation_id FROM runs ORDER BY rowid').all() as { id: string, conversation_id: string }[]
    const hasCheckpoints = !!original.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_event_checkpoints'`).get()
    for (const run of runs) {
      input.signal.throwIfAborted()
      const path = `buddy/conversations/${run.conversation_id}/events/${run.id}.jsonl`
      const entry = manifest.entries.find(item => item.path === path)
      const checkpoint = hasCheckpoints ? original.prepare('SELECT * FROM run_event_checkpoints WHERE run_id = ?').get(run.id) : undefined
      const content = await readPersistenceSource(manifest, path)
      const mapped = content === null ? null : mapEventContent(content, manifest.sourceRoot, profileRoot)
      const projectedLast = original.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM run_events WHERE run_id = ?').get(run.id)?.value
      importLegacyRunHistory(database, {
        runId: run.id,
        content: mapped,
        sourceFingerprint: entry?.digest ?? 'missing',
        certifiedThrough: entry && checkpoint?.file_fingerprint === entry.identity
          && checkpoint.projection_version === RUN_EVENT_PROJECTION_VERSION && checkpoint.last_sequence === projectedLast
          ? Number(checkpoint.last_sequence)
          : null,
      })
      await input.checkpoint?.('run')
    }
    importAliases(database)
    const files = await importFiles(database, profileRoot, manifest, input.signal)
    await verifyPiReferences(database, profileRoot, manifest, input.signal)
    await relocateProfileJournals(profileRoot, manifest.sourceRoot, profileRoot, input.signal)
    await verifyCandidateFiles(manifest, profileRoot, input.signal)
    verifyDrafts(database, original, manifest.sourceRoot, profileRoot)
    await input.checkpoint?.('files')
    await verifyPersistenceSources(manifest, input.signal, input.report)
    if (database.prepare('PRAGMA foreign_key_check').all().length
      || database.prepare('SELECT 1 FROM runs WHERE next_event_sequence IS NULL').get()) {
      throw new PersistenceMigrationError('MIGRATION_VERIFICATION_FAILED')
    }
    withTransaction(database, () => {
      database!.prepare(`UPDATE persistence_migrations SET state = 'verified' WHERE id = ?`).run(PERSISTENCE_MIGRATION_ID)
    })
    await input.checkpoint?.('verified')
    return { profileRoot, sourceFingerprint: manifest.fingerprint, runs: runs.length, files }
  }
  finally {
    database?.close()
    original.close()
  }
}

function mapEventContent(content: string, source: string, target: string): string {
  try {
    return content.split('\n').map(line => line.trim() ? JSON.stringify(relocateStructuredPaths(JSON.parse(line), source, target)) : line).join('\n')
  }
  catch (cause) {
    throw new PersistenceMigrationError('MIGRATION_EVENT_CORRUPTED', { cause })
  }
}

function importAliases(database: DatabaseSync): void {
  const namespaces = ['turn_requests', 'command_requests', 'chat_queue', 'automation_mutation_requests', 'automation_occurrences'] as const
  withTransaction(database, () => {
    for (const namespace of namespaces) {
      for (const row of database.prepare(`SELECT * FROM ${namespace} WHERE request_id IS NOT NULL`).iterate()) {
        const target = Object.fromEntries(Object.entries(row).filter(([key]) => ['id', 'run_id', 'conversation_id', 'branch_id', 'automation_id', 'draft_id', 'draft_revision', 'committed_draft_revision', 'state', 'status', 'kind'].includes(key)))
        const fingerprint = digest(row)
        const existing = database.prepare('SELECT source_fingerprint FROM legacy_request_aliases WHERE namespace = ? AND request_id = ?').get(namespace, row.request_id!)
        if (existing && existing.source_fingerprint !== fingerprint)
          throw new PersistenceMigrationError('MIGRATION_LEGACY_ALIAS_CHANGED')
        if (!existing) {
          database.prepare('INSERT INTO legacy_request_aliases (namespace, request_id, target_json, source_fingerprint) VALUES (?, ?, ?, ?)')
            .run(namespace, row.request_id!, JSON.stringify({ observed: target, originalTargetKnown: false }), fingerprint)
        }
        recordEvidence(database, 'alias', `${namespace}:${row.request_id}`, fingerprint, { namespace })
      }
    }
    for (const draft of database.prepare('SELECT * FROM composer_drafts ORDER BY id').iterate())
      recordEvidence(database, 'draft', String(draft.id), digest(draft), { revision: draft.revision, scope: draft.scope_kind })
  })
}

async function importFiles(database: DatabaseSync, root: string, manifest: PersistenceSourceManifest, signal: AbortSignal): Promise<number> {
  const catalog = createAttachmentPersistenceRepository(database)
  const records = database.prepare('SELECT id, stored_path, size_bytes FROM attachments ORDER BY id').all() as { id: string, stored_path: string, size_bytes: number }[]
  for (const record of records) {
    signal.throwIfAborted()
    const path = await requireOwnedFile(root, record.stored_path)
    const source = manifest.entries.find(entry => entry.path === relative(root, path).replaceAll('\\', '/'))
    if (!source?.digest || source.size !== record.size_bytes || await hashStorageFile(path, signal) !== source.digest)
      throw new PersistenceMigrationError('MIGRATION_ATTACHMENT_MISMATCH')
    withTransaction(database, () => {
      catalog.adopt({ path, sizeBytes: record.size_bytes, sha256: source.digest })
      recordEvidence(database, 'file', record.id, source.digest!, { sizeBytes: record.size_bytes })
    })
  }
  return records.length
}

async function verifyPiReferences(database: DatabaseSync, root: string, manifest: PersistenceSourceManifest, signal: AbortSignal): Promise<void> {
  const references = database.prepare(`SELECT pi_session_file AS path FROM runs WHERE pi_session_file IS NOT NULL
    UNION SELECT session_file FROM execution_thread_bindings
    UNION SELECT session_file FROM conversation_pi_trees`).all() as { path: string }[]
  for (const reference of references) {
    signal.throwIfAborted()
    const path = await requireOwnedFile(root, reference.path)
    const sourcePath = relative(root, path).replaceAll('\\', '/')
    const source = manifest.entries.find(entry => entry.path === sourcePath)
    if (!source?.digest)
      throw new PersistenceMigrationError('MIGRATION_PI_SOURCE_MISSING')
    const content = await readPersistenceSource(manifest, sourcePath)
    if (content === null)
      throw new PersistenceMigrationError('MIGRATION_PI_SOURCE_MISSING')
    const ids = new Set<string>()
    try {
      const entries = content.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { id?: unknown, parentId?: unknown, type?: unknown })
      if (entries[0]?.type !== 'session')
        throw new Error('Missing Pi session header')
      for (const entry of entries) {
        if (typeof entry.id !== 'string' || ids.has(entry.id)
          || (entry.parentId !== undefined && entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId)))) {
          throw new Error('Invalid Pi tree')
        }
        ids.add(entry.id)
      }
    }
    catch (cause) {
      throw new PersistenceMigrationError('MIGRATION_PI_CORRUPTED', { cause })
    }
    const current = await readFile(path, 'utf8')
    const expected = mapEventContent(content, manifest.sourceRoot, root)
    if (current !== content && current !== `${expected.trimEnd()}\n` && current !== expected)
      throw new PersistenceMigrationError('MIGRATION_PI_CHANGED')
    const bindings = database.prepare(`SELECT root_entry_id AS id FROM execution_thread_bindings WHERE session_file = ?
      UNION SELECT root_entry_id FROM conversation_pi_trees WHERE session_file = ?`).all(path, path)
    if (bindings.some(binding => binding.id !== null && !ids.has(String(binding.id))))
      throw new PersistenceMigrationError('MIGRATION_PI_BINDING_MISSING')
    withTransaction(database, () => recordEvidence(database, 'pi', sourcePath, source.digest!, { entries: ids.size }))
  }
}

async function verifyCandidateFiles(manifest: PersistenceSourceManifest, root: string, signal: AbortSignal): Promise<void> {
  for (const entry of manifest.entries) {
    signal.throwIfAborted()
    if (/^buddy\/buddy\.sqlite3(?:-(?:wal|shm|journal))?$/.test(entry.path))
      continue
    const path = join(root, entry.path)
    const metadata = await lstat(path)
    if (entry.directory) {
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
      continue
    }
    if (entry.link !== null) {
      const expected = containsStoragePath(manifest.sourceRoot, entry.link)
        ? join(root, relative(manifest.sourceRoot, entry.link))
        : entry.link
      if (!metadata.isSymbolicLink() || await readlink(path) !== expected)
        throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
      continue
    }
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
    if (await hashStorageFile(path, signal) === entry.digest)
      continue
    const isJournal = /^buddy\/conversations\/[^/]+\/(?:events|session)\/.+\.jsonl$/.test(entry.path)
    const isWorkbench = /^buddy\/workbench(?:\.previous)?\.json$/.test(entry.path)
    if (!isJournal && !isWorkbench)
      throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
    const original = await readPersistenceSource(manifest, entry.path)
    if (original === null)
      throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
    const expected = isJournal
      ? `${mapEventContent(original, manifest.sourceRoot, root).trimEnd()}\n`
      : JSON.stringify(relocateStructuredPaths(JSON.parse(original), manifest.sourceRoot, root))
    if (await readFile(path, 'utf8') !== expected)
      throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
  }
}

function verifyDrafts(database: DatabaseSync, original: DatabaseSync, source: string, target: string): void {
  if (!original.prepare('SELECT 1 FROM sqlite_master WHERE name = \'composer_drafts\' AND type = \'table\'').get())
    return
  const actor = database.prepare('SELECT local_actor_id FROM storage_profile WHERE id = 1').get()?.local_actor_id
  for (const row of original.prepare('SELECT * FROM composer_drafts').iterate()) {
    const current = database.prepare('SELECT * FROM composer_drafts WHERE id = ?').get(row.id!)
    if (!current || current.owner_actor_id !== actor)
      throw new PersistenceMigrationError('MIGRATION_DRAFT_OWNER_MISMATCH')
    for (const key of ['revision', 'content_json', 'model_selection_json', 'approval_policy', 'execution_profile', 'participants_json']) {
      if (!(key in row))
        continue
      const value = row[key]
      const expected = key.endsWith('_json') && typeof value === 'string'
        ? JSON.stringify(relocateStructuredPaths(JSON.parse(value), source, target))
        : value
      const actual = key.endsWith('_json') && typeof current[key] === 'string' ? JSON.stringify(JSON.parse(current[key])) : current[key]
      if (expected !== actual)
        throw new PersistenceMigrationError('MIGRATION_DRAFT_CONTENT_CHANGED')
    }
    if (!database.prepare('SELECT 1 FROM composer_draft_slots WHERE owner_actor_id = ? AND draft_id = ?').get(actor!, row.id!))
      throw new PersistenceMigrationError('MIGRATION_DRAFT_SLOT_MISSING')
  }
}

async function requireOwnedFile(root: string, path: string): Promise<string> {
  if (!containsStoragePath(root, path))
    throw new PersistenceMigrationError('MIGRATION_REFERENCE_OUTSIDE')
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || await realpath(path) !== path)
      throw new Error('Reference is not an owned regular file')
  }
  catch (cause) {
    throw new PersistenceMigrationError('MIGRATION_REFERENCE_MISSING', { cause })
  }
  return path
}

function recordEvidence(database: DatabaseSync, kind: 'alias' | 'draft' | 'file' | 'pi', id: string, fingerprint: string, evidence: object): void {
  const existing = database.prepare('SELECT source_fingerprint FROM persistence_migration_entries WHERE migration_id = ? AND kind = ? AND source_id = ?')
    .get(PERSISTENCE_MIGRATION_ID, kind, id)
  if (existing && existing.source_fingerprint !== fingerprint)
    throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
  if (!existing) {
    database.prepare('INSERT INTO persistence_migration_entries (migration_id, kind, source_id, source_fingerprint, evidence_json) VALUES (?, ?, ?, ?, ?)')
      .run(PERSISTENCE_MIGRATION_ID, kind, id, fingerprint, JSON.stringify(evidence))
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

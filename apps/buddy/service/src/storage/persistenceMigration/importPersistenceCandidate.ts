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
import { createAttachmentPersistenceRepository } from '../attachmentPersistenceRepository'
import { openBuddyMigrationCandidate } from '../database'
import { relocateDatabaseReferences, relocateProfileJournals, relocateStructuredPaths, verifyProfileReferences } from '../relocateProfileReferences'
import { withTransaction } from '../transaction'
import { checkpointEvidence, legacyEventPath, readLegacyCheckpoints, verifySparseCheckpoints } from './legacyRunCheckpoints'
import { importLegacyRunHistory, PERSISTENCE_MIGRATION_ID, PersistenceMigrationError } from './legacyRunHistory'
import { MigrationReferences } from './migrationReferences'
import { preparePersistenceSources, preparePersistenceWorkingCopy, readPersistenceSource, verifyPersistenceSources } from './persistenceSources'

import { countedUpgradeItems, reportUpgradeStep } from './upgradeProgress'

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
  const original = new ReadonlyDatabase(join(manifest.candidateRoot, 'source/buddy/buddy.sqlite3'), { readOnly: true })
  let database: DatabaseSync | undefined
  try {
    const references = new MigrationReferences(manifest)
    const report = references.inPlace ? input.report : undefined
    reportUpgradeStep(report, 'checkpoints')
    const checkpoints = readLegacyCheckpoints(original)
    await verifySparseCheckpoints(original, checkpoints, references, input.signal, report)
    reportUpgradeStep(report, 'databaseCopy')
    const resumingUpgrade = references.inPlace && manifest.workingCopyReady
    const profileRoot = await preparePersistenceWorkingCopy(manifest, input)
    await input.checkpoint?.('copied')
    reportUpgradeStep(report, 'schema')
    const sourceSchema = Number(original.prepare('PRAGMA user_version').get()!.user_version)
    database = openBuddyMigrationCandidate({ databasePath: join(profileRoot, 'buddy/buddy.sqlite3') })
    const previous = database.prepare('SELECT * FROM persistence_migrations WHERE id = ?').get(PERSISTENCE_MIGRATION_ID)
    if (resumingUpgrade && !previous)
      throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
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
    if (!references.inPlace)
      relocateDatabaseReferences(database, manifest.sourceRoot, profileRoot)
    const runs = database.prepare('SELECT id, conversation_id FROM runs ORDER BY rowid').all() as { id: string, conversation_id: string }[]
    for (const run of countedUpgradeItems(runs, 'runs', report)) {
      input.signal.throwIfAborted()
      const journal = await references.readJournal(legacyEventPath(run.conversation_id, run.id))
      importLegacyRunHistory(database, {
        runId: run.id,
        content: journal && (references.inPlace ? journal.content : mapEventContent(journal.content, manifest.sourceRoot, profileRoot)),
        sourceFingerprint: journal?.digest ?? 'missing',
        evidence: checkpointEvidence(checkpoints.get(run.id), journal?.identity),
      })
      await input.checkpoint?.('run')
    }
    reportUpgradeStep(report, 'aliases')
    importAliases(database)
    const files = await importFiles(database, references, input.signal, report)
    await verifyPiReferences(database, references, manifest.sourceRoot, input.signal, report)
    if (references.inPlace) {
      reportUpgradeStep(report, 'references')
      await verifyProfileReferences(database, references.root, references.root)
      reportUpgradeStep(report, 'integrity')
      if (database.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new PersistenceMigrationError('MIGRATION_VERIFICATION_FAILED')
    }
    else {
      await relocateProfileJournals(profileRoot, manifest.sourceRoot, profileRoot, input.signal)
      await verifyCandidateFiles(manifest, profileRoot, input.signal)
    }
    verifyDrafts(database, original, manifest.sourceRoot, references.root)
    await input.checkpoint?.('files')
    await verifyPersistenceSources(manifest, input.signal, input.report)
    await references.verify(input.signal, report)
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

async function importFiles(database: DatabaseSync, references: MigrationReferences, signal: AbortSignal, report?: StorageReporter): Promise<number> {
  const root = references.root
  const catalog = createAttachmentPersistenceRepository(database)
  const records = database.prepare('SELECT id, stored_path, size_bytes FROM attachments ORDER BY id').all() as { id: string, stored_path: string, size_bytes: number }[]
  if (!records.length)
    return 0
  const verified: { id: string, path: string, sizeBytes: number, digest: string }[] = []
  for (const record of countedUpgradeItems(records, 'attachments', report)) {
    signal.throwIfAborted()
    const path = await requireOwnedFile(root, record.stored_path)
    const digest = await references.attachmentDigest(path, relative(root, path).replaceAll('\\', '/'), record.size_bytes, signal)
    verified.push({ id: record.id, path, sizeBytes: record.size_bytes, digest })
  }
  signal.throwIfAborted()
  withTransaction(database, () => {
    // No client observes this candidate. Keep ownership and integrity triggers active during backfill.
    const revisions = database.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'
      AND name IN ('product_query_revision_managed_files_insert', 'product_query_revision_attachments_update')`).all()
    if (revisions.length !== 2)
      throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
    for (const trigger of revisions)
      database.exec(`DROP TRIGGER "${trigger.name}"`)
    for (const file of verified) {
      catalog.adopt({ path: file.path, sizeBytes: file.sizeBytes, sha256: file.digest })
      recordEvidence(database, 'file', file.id, file.digest, { sizeBytes: file.sizeBytes })
    }
    const unbound = database.prepare(`SELECT 1 FROM attachments a
      WHERE NOT EXISTS (SELECT 1 FROM managed_files f JOIN file_references r ON r.file_id = f.id
        WHERE f.path = a.stored_path AND f.state = 'ready' AND f.size_bytes = a.size_bytes AND r.binding_id = a.id
          AND r.owner_id = COALESCE(a.message_id, a.draft_id)
          AND r.kind = CASE WHEN a.message_id IS NOT NULL THEN 'message'
            WHEN EXISTS (SELECT 1 FROM chat_queue WHERE id = a.draft_id) THEN 'queue' ELSE 'draft' END)
      LIMIT 1`).get()
    if (unbound)
      throw new PersistenceMigrationError('MIGRATION_VERIFICATION_FAILED')
    for (const trigger of revisions)
      database.exec(String(trigger.sql))
  })
  return records.length
}

async function verifyPiReferences(database: DatabaseSync, files: MigrationReferences, sourceRoot: string, signal: AbortSignal, report?: StorageReporter): Promise<void> {
  const root = files.root
  const references = database.prepare(`SELECT pi_session_file AS path FROM runs WHERE pi_session_file IS NOT NULL
    UNION SELECT session_file FROM execution_thread_bindings
    UNION SELECT session_file FROM conversation_pi_trees`).all() as { path: string }[]
  for (const reference of countedUpgradeItems(references, 'sessions', report)) {
    signal.throwIfAborted()
    const path = await requireOwnedFile(root, reference.path)
    const sourcePath = relative(root, path).replaceAll('\\', '/')
    const journal = await files.readJournal(sourcePath)
    if (!journal)
      throw new PersistenceMigrationError('MIGRATION_PI_SOURCE_MISSING')
    const { content } = journal
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
    if (!files.inPlace) {
      const current = await readFile(path, 'utf8')
      const expected = mapEventContent(content, sourceRoot, root)
      if (current !== content && current !== `${expected.trimEnd()}\n` && current !== expected)
        throw new PersistenceMigrationError('MIGRATION_PI_CHANGED')
    }
    const bindings = database.prepare(`SELECT root_entry_id AS id FROM execution_thread_bindings WHERE session_file = ?
      UNION SELECT root_entry_id FROM conversation_pi_trees WHERE session_file = ?`).all(path, path)
    if (bindings.some(binding => binding.id !== null && !ids.has(String(binding.id))))
      throw new PersistenceMigrationError('MIGRATION_PI_BINDING_MISSING')
    withTransaction(database, () => recordEvidence(database, 'pi', sourcePath, journal.digest, { entries: ids.size }))
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
        ? JSON.stringify(source === target ? JSON.parse(value) : relocateStructuredPaths(JSON.parse(value), source, target))
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

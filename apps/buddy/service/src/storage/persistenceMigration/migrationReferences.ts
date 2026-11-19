import type { DatabaseSync } from 'node:sqlite'
import type { StorageReporter } from '../../../../platform/storage/storageTree'
import type { PersistenceSourceManifest } from './persistenceSources'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { containsStoragePath, isMissing } from '../../../../platform/storage/storageFiles'
import { hashStorageFile } from '../../../../platform/storage/storageTree'
import { verifyProfileReferences } from '../relocateProfileReferences'
import { legacyEventPath } from './legacyRunCheckpoints'
import { PERSISTENCE_MIGRATION_ID, PersistenceMigrationError } from './legacyRunHistory'
import { persistenceFileIdentity } from './persistenceSources'

import { countedUpgradeItems } from './upgradeProgress'

export class MigrationReferences {
  readonly #manifest: PersistenceSourceManifest
  readonly #entries: Map<string, PersistenceSourceManifest['entries'][number]>
  readonly #observed = new Map<string, string | null>()
  readonly root: string
  readonly inPlace: boolean

  constructor(manifest: PersistenceSourceManifest) {
    this.#manifest = manifest
    this.#entries = new Map(manifest.entries.map(entry => [entry.path, entry]))
    this.inPlace = manifest.scope === 'upgrade'
    this.root = this.inPlace ? manifest.sourceRoot : join(manifest.candidateRoot, 'profile')
  }

  async journalIdentity(path: string) {
    if (!this.inPlace)
      return this.#entries.get(path)?.identity
    const file = join(this.root, path)
    const identity = await this.#identity(file)
    this.#record(file, identity)
    return identity
  }

  async readJournal(path: string) {
    const entry = this.#entries.get(path)
    const root = this.inPlace ? this.root : join(this.#manifest.candidateRoot, 'source')
    const file = join(root, path)
    const identity = await this.journalIdentity(path)
    if (!identity)
      return null
    if (!this.inPlace && !entry?.digest)
      throw new PersistenceMigrationError('MIGRATION_SOURCE_NOT_REGULAR')
    const bytes = await readFile(file)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (!this.inPlace && digest !== entry?.digest)
      throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
    return { content: bytes.toString('utf8'), identity, digest }
  }

  async attachmentDigest(path: string, relativePath: string, size: number, signal: AbortSignal) {
    const entry = this.#entries.get(relativePath)
    const info = await lstat(path, { bigint: true })
    if (info.size !== BigInt(size))
      throw new PersistenceMigrationError('MIGRATION_ATTACHMENT_MISMATCH')
    if (this.inPlace)
      this.#record(path, persistenceFileIdentity(info))
    const digest = await hashStorageFile(path, signal)
    if (!this.inPlace && digest !== entry?.digest)
      throw new PersistenceMigrationError('MIGRATION_ATTACHMENT_MISMATCH')
    return digest
  }

  async verify(signal: AbortSignal, report?: StorageReporter) {
    for (const [path, identity] of countedUpgradeItems([...this.#observed], 'sourceFiles', report)) {
      signal.throwIfAborted()
      if (await this.#identity(path) !== identity)
        throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
    }
  }

  #record(path: string, identity: string | null) {
    if (this.#observed.has(path) && this.#observed.get(path) !== identity)
      throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
    this.#observed.set(path, identity)
  }

  async #identity(path: string) {
    if (!containsStoragePath(this.root, path))
      throw new PersistenceMigrationError('MIGRATION_REFERENCE_OUTSIDE')
    try {
      const stat = await lstat(path, { bigint: true })
      if (!stat.isFile() || await realpath(path) !== path)
        throw new PersistenceMigrationError('MIGRATION_SOURCE_NOT_REGULAR')
      return persistenceFileIdentity(stat)
    }
    catch (error) {
      if (isMissing(error))
        return null
      throw error
    }
  }
}

export async function verifyActivatedUpgradeReferences(database: DatabaseSync, manifest: PersistenceSourceManifest, signal: AbortSignal) {
  const references = new MigrationReferences(manifest)
  const records = database.prepare(`
    SELECT e.kind, e.source_id AS id, e.source_fingerprint AS digest, r.conversation_id AS conversation
    FROM persistence_migration_entries e LEFT JOIN runs r ON e.kind = 'run' AND r.id = e.source_id
    WHERE e.migration_id = ? AND e.kind IN ('run', 'pi')
  `)
  for (const row of records.iterate(PERSISTENCE_MIGRATION_ID)) {
    signal.throwIfAborted()
    const path = row.kind === 'pi' ? String(row.id) : legacyEventPath(String(row.conversation), String(row.id))
    const journal = await references.readJournal(path)
    if ((journal?.digest ?? 'missing') !== row.digest)
      throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
  }
  await verifyProfileReferences(database, references.root, references.root)
  await references.verify(signal)
}

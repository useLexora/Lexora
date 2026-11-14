import type { StorageCommand } from '../CommandCommitter'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandCommitter } from '../CommandCommitter'
import { openBuddyMigrationCandidate } from '../database'
import { guardStorageDatabase } from '../StorageIsolation'
import { verifyCommandReceipt } from '../verifyCommandReceipt'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lexora-receipt-verification-'))
  directories.push(root)
  const databasePath = join(root, 'candidate.sqlite3')
  const database = openBuddyMigrationCandidate({ databasePath })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const identity: StorageCommand = {
    dataGeneration: String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation),
    actorId: 'desktop-local',
    commandId: 'command-1',
    method: 'fixture',
    fingerprint: 'intent-1',
    fingerprintVersion: 1,
    sourceInstanceId: 'instance-1',
  }
  return { root, databasePath, database, identity }
}

describe('read-only command receipt verification', () => {
  it('returns only the original receipt without changing the database or independent files', () => {
    const f = fixture()
    const receipt = new CommandCommitter(f.database).accept(f.identity, () => ({ target: { runId: 'original-run' }, result: {} })).receipt
    f.database.close()
    const independent = join(f.root, 'session.jsonl')
    writeFileSync(independent, 'independent session contents\n')
    const before = readFileSync(f.databasePath)
    expect(verifyCommandReceipt(f)).toEqual(receipt)
    expect(verifyCommandReceipt({ ...f, identity: { ...f.identity, commandId: 'absent' } })).toBeNull()
    expect(readFileSync(f.databasePath)).toEqual(before)
    expect(readFileSync(independent, 'utf8')).toBe('independent session contents\n')
  })

  it.each(['generation', 'actor', 'pending'] as const)('rejects %s mismatch instead of reporting a missing command', (kind) => {
    const f = fixture()
    if (kind === 'pending')
      f.database.exec('UPDATE storage_profile SET authority = \'legacy_jsonl\', migration_state = \'pending\'')
    f.database.close()
    const before = readFileSync(f.databasePath)
    const identity = { ...f.identity }
    if (kind === 'generation')
      identity.dataGeneration = 'another-generation'
    if (kind === 'actor')
      identity.actorId = 'another-actor'
    expect(() => verifyCommandReceipt({ databasePath: f.databasePath, identity })).toThrow()
    expect(readFileSync(f.databasePath)).toEqual(before)
  })

  it('does not create or replace a missing or unreadable source', () => {
    const f = fixture()
    f.database.close()
    const missing = join(f.root, 'absent', 'candidate.sqlite3')
    expect(() => verifyCommandReceipt({ ...f, databasePath: missing })).toThrow()
    expect(existsSync(join(f.root, 'absent'))).toBe(false)
    writeFileSync(f.databasePath, 'unreadable database'.repeat(64))
    const before = readFileSync(f.databasePath)
    expect(() => verifyCommandReceipt(f)).toThrow()
    expect(readFileSync(f.databasePath)).toEqual(before)
    expect(() => verifyCommandReceipt({ ...f, databasePath: ':memory:' })).toThrow('existing absolute')
  })

  it('isolates corrupt receipts on both lookup and repeated acceptance', () => {
    for (const operation of ['find', 'accept'] as const) {
      const f = fixture()
      try {
        const committer = new CommandCommitter(f.database)
        committer.accept(f.identity, () => ({ target: {}, result: {} }))
        f.database.exec('DROP TRIGGER command_receipts_no_update; UPDATE command_receipts SET decided_at = \'invalid\'')
        const isolation = guardStorageDatabase(f.database)
        expect(() => operation === 'find' ? committer.find(f.identity) : committer.accept(f.identity, () => ({ target: {}, result: {} }))).toThrow()
        expect(isolation.failure).not.toBeNull()
        expect(() => f.database.prepare('SELECT 1')).toThrow('Storage is isolated')
      }
      finally {
        f.database.close()
      }
    }
  })
})

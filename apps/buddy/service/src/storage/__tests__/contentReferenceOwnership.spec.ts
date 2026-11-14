import type { DatabaseSync } from 'node:sqlite'
import type { BuddyUserContentV1 } from '../../../../shared/conversation/buddyUserContent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as Sqlite } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { ConversationPurgeService } from '../../conversations/ConversationPurgeService'
import { ProductContentReferences } from '../../productProtocol/ProductContentReferences'
import { ProductQueries } from '../../productProtocol/ProductQueries'
import { mergeBackupDatabase, selectBackupDatabase } from '../backupDatabase'
import { createComposerDraftCommitter } from '../commitComposerDraft'
import { createComposerDraftRepository } from '../composerDraftRepository'
import { createConversationDeletionRepository } from '../conversationDeletionRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyMigrationCandidate, openBuddySqliteDatabase } from '../database'
import { BUDDY_MIGRATION_SCHEMA_VERSION, BUDDY_SCHEMA_MIGRATIONS } from '../schema'
import { rewriteIsolatedSnapshotDatabase } from '../snapshotDatabase'

const now = '2026-11-01T00:00:00.000Z'
const executionConfig = { approvalPolicy: 'policy', executionProfile: 'workspace_write' } as const
const quoted: BuddyUserContentV1 = {
  ...createBuddyUserContent('A file quotation'),
  resourceQuotes: [{ id: 'file-quote', text: 'Private historical excerpt', source: { kind: 'file', title: 'fixture.txt', file: { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'fixture.txt' }, format: 'source' } }],
}
const databases = new Set<DatabaseSync>()
const directories: string[] = []
afterEach(() => {
  for (const database of databases) database.close()
  databases.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'lexora-reference-ownership-'))
  directories.push(home)
  const path = join(home, 'buddy.sqlite3')
  const database = openBuddySqliteDatabase({ databasePath: path })
  databases.add(database)
  const conversations = createConversationRepository(database)
  const drafts = createComposerDraftRepository(database)
  const references = new ProductContentReferences(database, 'desktop-local')
  const queries = new ProductQueries(database, 'desktop-local', 'instance', references)
  const task = (id: string) => conversations.create({ id, branchId: `branch-${id}`, spaceId: null, title: id, createdAt: now, ...executionConfig })
  const draft = (id: string, conversationId: string | null, content = quoted) => drafts.open({ draftId: id, scope: conversationId ? { kind: 'conversation_branch', conversationId, branchId: `branch-${conversationId}` } : { kind: 'task', draftId: id, spaceId: null }, initialContent: content, initialExecutionConfig: executionConfig, initialModelSelection: null, now })
  const clear = (id: string) => drafts.save({ draftId: id, expectedRevision: drafts.findById(id)!.revision, content: createBuddyUserContent(), modelSelection: null, executionConfig, now })
  const project = (id: string) => {
    const content = queries.draft(id)!.content
    if (content.kind !== 'editable')
      throw new Error('Expected editable draft')
    return content.content.resourceQuotes![0]!.resourceId
  }
  const purge = async (id: string) => {
    createConversationDeletionRepository(database).commit(id, now)
    await new ConversationPurgeService({ database, home, storageAuthority: 'sqlite' }).purge(id)
  }
  return { database, home, path, references, queries, drafts, task, draft, clear, project, purge }
}

describe('durable content reference ownership', () => {
  it('forgets an interned file quotation after draft removal and task purge', async () => {
    const f = fixture()
    f.task('task')
    f.draft('draft', 'task')
    const id = f.project('draft')
    f.clear('draft')
    expect(f.references.resolve(id)).toEqual(quoted.resourceQuotes![0])
    expect(() => f.database.exec('DELETE FROM product_content_reference_owners')).toThrow('CONTENT_REFERENCE_OWNER_IMMUTABLE')
    await f.purge('task')
    expect(f.database.prepare('SELECT quote_json FROM product_content_references WHERE id = ?').get(id)).toBeUndefined()
    expect(() => f.references.resolve(id)).toThrow('RESOURCE_UNAVAILABLE')
    expect(f.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('retains historical shared ownership even when both drafts no longer contain the quote', async () => {
    const f = fixture()
    f.task('first')
    f.task('second')
    f.draft('draft-first', 'first')
    f.draft('draft-second', 'second')
    const id = f.project('draft-first')
    expect(f.database.prepare('SELECT owner_id FROM product_content_reference_owners WHERE reference_id = ? ORDER BY owner_id').all(id))
      .toEqual([{ owner_id: 'first' }, { owner_id: 'second' }])
    f.clear('draft-first')
    f.clear('draft-second')
    await f.purge('first')
    expect(f.references.resolve(id)).toEqual(quoted.resourceQuotes![0])
    expect(f.database.prepare('SELECT owner_id FROM product_content_reference_owners WHERE reference_id = ?').all(id)).toEqual([{ owner_id: 'second' }])
    await f.purge('second')
    expect(() => f.references.resolve(id)).toThrow('RESOURCE_UNAVAILABLE')
  })

  it('attaches a preprojected Desktop quote when it is first persisted in a task draft', async () => {
    const f = fixture()
    const id = f.references.project(quoted).resourceQuotes![0]!.resourceId
    f.task('task')
    f.draft('draft', 'task')
    f.clear('draft')
    await f.purge('task')
    expect(() => f.references.resolve(id)).toThrow('RESOURCE_UNAVAILABLE')
  })

  it('transfers historical unbound draft ownership when the draft becomes a task', async () => {
    const f = fixture()
    f.draft('draft', null)
    const id = f.project('draft')
    const cleared = f.clear('draft')
    f.task('task')
    createComposerDraftCommitter(f.database)({ draftId: 'draft', expectedRevision: cleared.revision, conversationId: 'task', branchId: 'branch-task', spaceId: null, updatedAt: now, ...executionConfig })
    expect(f.database.prepare('SELECT owner_kind, owner_id FROM product_content_reference_owners WHERE reference_id = ?').all(id))
      .toEqual([{ owner_kind: 'conversation', owner_id: 'task' }])
    await f.purge('task')
    expect(() => f.references.resolve(id)).toThrow('RESOURCE_UNAVAILABLE')
  })

  it('migrates legacy quotes and collects exact source owners on first modern projection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lexora-reference-migration-'))
    directories.push(home)
    const path = join(home, 'buddy.sqlite3')
    const previous = new Sqlite(path)
    databases.add(previous)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 42)) {
      previous.exec(migration.sql)
      previous.exec(`PRAGMA user_version = ${migration.version}`)
    }
    const conversations = createConversationRepository(previous)
    for (const id of ['draft-owner', 'message-owner', 'queue-owner', 'different-quote'])
      conversations.create({ id, branchId: `branch-${id}`, spaceId: null, title: id, createdAt: now, ...executionConfig })
    const drafts = createComposerDraftRepository(previous)
    const different = { ...quoted, resourceQuotes: [{ ...quoted.resourceQuotes![0]!, text: 'Different excerpt with the same local quote ID' }] }
    for (const [id, owner, content] of [['draft', 'draft-owner', quoted], ['different', 'different-quote', different]] as const) {
      drafts.open({ draftId: id, scope: { kind: 'conversation_branch', conversationId: owner, branchId: `branch-${owner}` }, initialContent: content, initialExecutionConfig: executionConfig, initialModelSelection: null, now })
    }
    previous.prepare(`INSERT INTO messages(id,conversation_id,branch_id,role,content_json,created_at)
      VALUES ('message','message-owner','branch-message-owner','user',?,?)`).run(JSON.stringify({ userContent: quoted }), now)
    previous.prepare(`INSERT INTO chat_queue(id,conversation_id,branch_id,request_id,request_fingerprint,prepared_json,state,created_at)
      VALUES ('queue','queue-owner','branch-queue-owner','request','fingerprint',?,'cancelled',?)`).run(JSON.stringify({ userMessageContent: { userContent: quoted } }), now)
    expect(previous.prepare(`SELECT name FROM sqlite_master WHERE name IN ('product_content_references','product_content_reference_owners')`).all()).toEqual([])
    previous.exec(BUDDY_SCHEMA_MIGRATIONS.find(migration => migration.version === BUDDY_MIGRATION_SCHEMA_VERSION)!.sql)
    previous.exec(`PRAGMA user_version = ${BUDDY_MIGRATION_SCHEMA_VERSION}`)
    expect(previous.prepare('SELECT * FROM product_content_references').all()).toEqual([])
    expect(previous.prepare('SELECT * FROM product_content_reference_owners').all()).toEqual([])
    expect(previous.prepare('SELECT content_json FROM composer_drafts WHERE id = \'draft\'').get()?.content_json).toBe(JSON.stringify(quoted))
    previous.close()
    databases.delete(previous)
    const candidate = openBuddyMigrationCandidate({ databasePath: path })
    expect(candidate.prepare('PRAGMA user_version').get()?.user_version).toBe(BUDDY_MIGRATION_SCHEMA_VERSION)
    candidate.exec(`UPDATE storage_profile SET authority = 'sqlite', migration_state = 'ready'`)
    candidate.close()
    const database = openBuddySqliteDatabase({ databasePath: path })
    databases.add(database)
    const references = new ProductContentReferences(database, 'desktop-local')
    const id = references.project(quoted).resourceQuotes![0]!.resourceId
    expect(database.prepare('SELECT owner_kind,owner_id FROM product_content_reference_owners WHERE reference_id = ? ORDER BY owner_id').all(id))
      .toEqual(['draft-owner', 'message-owner', 'queue-owner'].map(owner_id => ({ owner_kind: 'conversation', owner_id })))
    database.prepare(`UPDATE composer_drafts SET content_json = ? WHERE id = 'draft'`).run(JSON.stringify(createBuddyUserContent()))
    for (const owner of ['draft-owner', 'message-owner', 'queue-owner']) {
      createConversationDeletionRepository(database).commit(owner, now)
      await new ConversationPurgeService({ database, home, storageAuthority: 'sqlite' }).purge(owner)
      if (owner !== 'queue-owner')
        expect(references.resolve(id)).toEqual(quoted.resourceQuotes![0])
    }
    expect(() => references.resolve(id)).toThrow('RESOURCE_UNAVAILABLE')
    expect(database.prepare('SELECT content_json FROM composer_drafts WHERE id = \'different\'').get()?.content_json).toBe(JSON.stringify(different))
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('merges saved ownership without deleting unrelated target references', async () => {
    const source = fixture()
    source.task('source-task')
    source.draft('source-draft', 'source-task')
    const importedId = source.project('source-draft')
    source.clear('source-draft')
    const target = fixture()
    target.task('target-task')
    target.draft('target-draft', 'target-task')
    const retainedId = target.project('target-draft')
    target.clear('target-draft')
    target.database.close()
    databases.delete(target.database)
    await rewriteIsolatedSnapshotDatabase(target.path, database => mergeBackupDatabase(database, source.database, ['tasks']))
    const database = openBuddySqliteDatabase({ databasePath: target.path })
    databases.add(database)
    createConversationDeletionRepository(database).commit('source-task', now)
    await new ConversationPurgeService({ database, home: target.home, storageAuthority: 'sqlite' }).purge('source-task')
    expect(database.prepare('SELECT 1 FROM product_content_references WHERE id = ?').get(importedId)).toBeUndefined()
    expect(new ProductContentReferences(database, 'desktop-local').resolve(retainedId)).toEqual(quoted.resourceQuotes![0])
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('preserves ownership through selective task backup and reopening before purge', async () => {
    const f = fixture()
    f.task('task')
    f.draft('draft', 'task')
    const id = f.project('draft')
    f.clear('draft')
    f.database.close()
    databases.delete(f.database)
    await rewriteIsolatedSnapshotDatabase(f.path, database => selectBackupDatabase(database, ['tasks']))
    const database = openBuddySqliteDatabase({ databasePath: f.path })
    databases.add(database)
    expect(database.prepare('SELECT owner_kind, owner_id FROM product_content_reference_owners WHERE reference_id = ?').all(id))
      .toEqual([{ owner_kind: 'conversation', owner_id: 'task' }])
    createConversationDeletionRepository(database).commit('task', now)
    await new ConversationPurgeService({ database, home: f.home, storageAuthority: 'sqlite' }).purge('task')
    expect(() => new ProductContentReferences(database, 'desktop-local').resolve(id)).toThrow('RESOURCE_UNAVAILABLE')
  })
})

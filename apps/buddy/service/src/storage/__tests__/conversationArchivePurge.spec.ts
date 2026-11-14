import type { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as Sqlite } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationPurgeService } from '../../conversations/ConversationPurgeService'
import { createAttachmentPersistenceRepository } from '../attachmentPersistenceRepository'
import { selectBackupDatabase } from '../backupDatabase'
import { createConversationArchiveRepository } from '../conversationArchiveRepository'
import { createConversationDeletionRepository } from '../conversationDeletionRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase, openBuddySqliteDatabase } from '../database'
import { createExecutionRepository, executionFence } from '../executionRepository'
import { BUDDY_SCHEMA_MIGRATIONS } from '../schema'
import { rewriteIsolatedSnapshotDatabase } from '../snapshotDatabase'
import { sqliteRunFixtureTime as now, seedSqliteRun } from './sqliteRunFixture'

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  for (const db of databases.splice(0))
    db.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'lexora-purge-'))
  directories.push(home)
  const database = openBuddySqliteDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const deletion = createConversationDeletionRepository(database)
  const archive = createConversationArchiveRepository(database)
  const purge = new ConversationPurgeService({ database, home, storageAuthority: 'sqlite' })
  return { home, database, deletion, archive, purge }
}
function seed(database: DatabaseSync, id = 'task-1') {
  createConversationRepository(database).create({ id, branchId: `branch-${id}`, spaceId: null, title: 'Fixture task', createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  seedSqliteRun(database, `run-${id}`, { conversationId: id })
  database.prepare(`UPDATE runs SET status = 'completed' WHERE conversation_id = ?`).run(id)
  database.prepare(`UPDATE execution_state SET phase = 'closed', cleanup_state = 'clean' WHERE run_id = ?`).run(`run-${id}`)
  database.prepare('INSERT INTO task_attention(conversation_id, seen_run_id) VALUES (?, ?)').run(id, `run-${id}`)
}
function content(home: string, id = 'task-1') {
  const directory = join(home, 'conversations', id)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'session.jsonl')
  writeFileSync(path, 'private content')
  return { directory, path }
}
function managed(database: DatabaseSync, path: string) {
  database.prepare(`INSERT INTO managed_files (id,path,size_bytes,sha256,state,durability,created_at,updated_at)
    VALUES ('file-1',?,15,?,'ready','file-sync',?,?)`).run(path, 'a'.repeat(64), now, now)
  database.prepare(`INSERT INTO attachments (id,message_id,draft_id,name,mime_type,size_bytes,stored_path,created_at)
    VALUES ('attachment-1','input-run-task-1',NULL,'fixture','text/plain',15,?,?)`).run(path, now)
}

describe('conversation archive and physical purge', () => {
  it('blocks expiry, legacy deletion and physical purge when terminal execution evidence is missing', async () => {
    const { database, home, deletion, archive, purge } = fixture()
    seed(database)
    const { path } = content(home)
    archive.archive('task-1', now)
    archive.setPolicy(3)
    const due = '2026-11-01T00:00:00.000Z'
    expect(archive.isDue('task-1', due)).toBe(true)
    database.prepare('DELETE FROM execution_state WHERE run_id = ?').run('run-task-1')
    expect(archive.due(due)).toEqual([])
    expect(archive.isDue('task-1', due)).toBe(false)
    database.prepare('UPDATE conversations SET archived_at = NULL, deleted_at = ? WHERE id = ?').run(now, 'task-1')
    expect(deletion.commitLegacyRemoved('task-1', now)).toBeNull()
    deletion.commit('task-1', now)
    await expect(purge.purge('task-1')).rejects.toMatchObject({ code: 'CONVERSATION_RESOURCES_BUSY' })
    expect(readFileSync(path, 'utf8')).toBe('private content')
    expect(database.prepare('SELECT id FROM runs WHERE id = ?').get('run-task-1')).toEqual({ id: 'run-task-1' })
  })

  it('upgrades v41 tombstones to v42 without scheduling purge and retains usage after explicit deletion', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lexora-archive-migration-'))
    directories.push(home)
    const path = join(home, 'fixture.sqlite3')
    const previous = new Sqlite(path)
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(item => item.version <= 41)) {
      previous.exec(migration.sql)
      previous.exec(`PRAGMA user_version = ${migration.version}`)
    }
    previous.exec(`
      INSERT INTO conversations(id,created_at,updated_at,deleted_at) VALUES ('task-1','${now}','${now}','${now}');
      INSERT INTO conversation_branches(id,conversation_id,created_at) VALUES ('branch-task-1','task-1','${now}');
      INSERT INTO conversation_members(conversation_id,actor_id,joined_at) SELECT 'task-1',default_buddy_id,'${now}' FROM buddy_catalog;
      INSERT INTO messages(id,conversation_id,branch_id,role,content_json,created_at) VALUES ('input','task-1','branch-task-1','user','{}','${now}');
      INSERT INTO runs(id,conversation_id,branch_id,triggering_message_id,provider,model,purpose,status,started_at)
        VALUES ('run','task-1','branch-task-1','input','fixture','fixture','chat','completed','${now}');
      UPDATE execution_state SET phase = 'closed', cleanup_state = 'clean';
      INSERT INTO task_attention(conversation_id,seen_run_id) VALUES ('task-1','run');
      INSERT INTO usage_records(id,run_id,source_entry_id,provider,model,purpose,input_tokens,output_tokens,
        cache_read_tokens,cache_write_tokens,total_tokens,input_cost,output_cost,cache_read_cost,cache_write_cost,total_cost,created_at)
        VALUES ('usage','run','entry','fixture','fixture','chat',10,20,0,0,30,1,2,0,0,3,'${now}');
    `)
    const { directory } = content(home)
    previous.close()
    const database = openBuddyDatabase({ databasePath: path })
    databases.push(database)
    const deletion = createConversationDeletionRepository(database)
    const archive = createConversationArchiveRepository(database)
    expect(deletion.pending()).toEqual([])
    archive.setPolicy(3)
    expect(archive.due('2027-01-01T00:00:00.000Z')).toEqual([])
    expect(archive.list({ kind: 'removed' }).items).toMatchObject([{ id: 'task-1', deletedAt: now, archivedAt: null }])
    expect(archive.restore('task-1', now)).toBe(true)
    expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(42)
    expect(existsSync(directory)).toBe(true)
    deletion.commit('task-1', now)
    await new ConversationPurgeService({ database, home, storageAuthority: 'legacy_jsonl' }).purge('task-1')
    expect(existsSync(directory)).toBe(false)
    expect(database.prepare('SELECT run_id, detached, total_tokens, total_cost FROM usage_records').get())
      .toEqual({ run_id: null, detached: 1, total_tokens: 30, total_cost: 3 })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('removes task, execution, attachment and session data but preserves detached usage and external workspaces', async () => {
    const { database, home, deletion, purge } = fixture()
    seed(database)
    const { path, directory } = content(home)
    managed(database, path)
    const external = join(home, 'external-workspace')
    mkdirSync(external)
    writeFileSync(join(external, 'keep.txt'), 'user document')
    database.prepare('UPDATE runs SET pi_session_file = ?').run(join(external, 'keep.txt'))
    database.exec(`INSERT INTO usage_records (id,run_id,source_entry_id,provider,model,purpose,input_tokens,output_tokens,
      cache_read_tokens,cache_write_tokens,total_tokens,input_cost,output_cost,cache_read_cost,cache_write_cost,total_cost,created_at)
      VALUES ('usage','run-task-1','entry','fixture','fixture','chat',10,20,0,0,30,1,2,0,0,3,'${now}')`)
    deletion.commit('task-1', now)
    await purge.purge('task-1')
    expect(existsSync(directory)).toBe(false)
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('user document')
    for (const table of ['conversations', 'messages', 'runs', 'execution_state', 'execution_threads', 'attachments', 'managed_files', 'file_references', 'conversation_deletion_jobs', 'conversation_members', 'task_attention'])
      expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, table).toBe(0)
    expect(database.prepare('SELECT run_id, invocation_id, total_tokens, total_cost FROM usage_records').get()).toMatchObject({ run_id: null, invocation_id: null, total_tokens: 30, total_cost: 3 })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    await purge.purge('task-1')
  })

  it('refuses outside references before touching files, and retries after they are released', async () => {
    const { database, home, deletion, purge, archive } = fixture()
    seed(database)
    const { path } = content(home)
    managed(database, path)
    database.exec('INSERT INTO file_references VALUES (\'file-1\',\'export\',\'other-task\',\'export-1\')')
    deletion.commit('task-1', now)
    await expect(purge.purge('task-1')).rejects.toMatchObject({ code: 'CONVERSATION_FILES_REFERENCED' })
    expect(readFileSync(path, 'utf8')).toBe('private content')
    expect(deletion.pending()).toEqual([])
    expect(archive.list({ kind: 'deleting' }).items[0]).toMatchObject({ deletionStatus: 'failed', errorCode: 'CONVERSATION_FILES_REFERENCED' })
    database.exec('DELETE FROM file_references WHERE kind = \'export\'')
    deletion.retry('task-1', now)
    await purge.purge('task-1')
    expect(existsSync(path)).toBe(false)
  })

  it('rejects symlinks including ancestors and does not touch their targets', async () => {
    const { database, home, deletion, purge } = fixture()
    seed(database)
    const outside = join(home, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    mkdirSync(join(home, 'conversations'))
    symlinkSync(outside, join(home, 'conversations', 'task-1'), 'dir')
    deletion.commit('task-1', now)
    await expect(purge.purge('task-1')).rejects.toMatchObject({ code: 'CONVERSATION_FILE_BOUNDARY' })
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(database.prepare('SELECT 1 FROM conversations').get()).toBeTruthy()
    rmSync(join(home, 'conversations', 'task-1'))
    deletion.retry('task-1', now)
    await purge.purge('task-1')
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('persists cleanup truth across a partial filesystem failure and a fresh service retry', async () => {
    const { database, home, deletion, purge } = fixture()
    seed(database)
    const { directory } = content(home)
    const blocked = join(directory, 'blocked')
    mkdirSync(blocked)
    writeFileSync(join(blocked, 'private.txt'), 'private')
    chmodSync(blocked, 0o500)
    deletion.commit('task-1', now)
    try {
      await expect(purge.purge('task-1')).rejects.toMatchObject({ code: 'CONVERSATION_PURGE_FAILED' })
      expect(database.prepare('SELECT manifest_json FROM conversation_deletion_jobs').get()?.manifest_json).toBeTruthy()
      expect(database.prepare('SELECT 1 FROM messages').get()).toBeTruthy()
    }
    finally { chmodSync(blocked, 0o700) }
    deletion.retry('task-1', now)
    await new ConversationPurgeService({ database, home, storageAuthority: 'sqlite' }).purge('task-1')
    expect(existsSync(directory)).toBe(false)
  })

  it('does not purge historical tombstones from old run completion and scopes legacy jobs strictly', async () => {
    const { database, home, deletion, purge, archive } = fixture()
    seed(database)
    const { path } = content(home)
    database.prepare('UPDATE conversations SET deleted_at = ?').run(now)
    deletion.recoverLegacy('task-1', now)
    await purge.purge('task-1')
    expect(existsSync(path)).toBe(true)
    expect(deletion.pending()).toEqual([])
    expect(deletion.commitLegacyRemoved('task-1', now)).not.toBeNull()
    deletion.failed('task-1', 'CONVERSATION_PURGE_FAILED', now)
    expect(archive.list({ kind: 'removed' }).items[0]?.deletionStatus).toBe('failed')
    expect(archive.restore('task-1', now)).toBe(false)
    seed(database, 'active')
    expect(deletion.commitLegacyRemoved('active', now)).toBeNull()
    archive.archive('active', now)
    expect(deletion.commitLegacyRemoved('active', now)).toBeNull()
  })

  it.each([
    ['archived', 'queued'],
    ['deleted', 'running'],
  ] as const)('finishes cancellation of a %s task with a %s run without reopening admission', (state, status) => {
    const { database, archive, deletion } = fixture()
    seed(database)
    database.prepare('UPDATE runs SET status = ?').run(status)
    database.prepare('UPDATE execution_state SET phase = ?, cleanup_state = \'pending\'').run(status === 'queued' ? 'queued' : 'working')
    if (state === 'archived')
      archive.archive('task-1', now)
    else
      deletion.commit('task-1', now)
    expect(() => database.exec('UPDATE runs SET generation = generation + 2')).toThrow('CONVERSATION_NOT_ACTIVE')
    expect(() => database.prepare('UPDATE runs SET status = ?').run(status === 'queued' ? 'running' : 'queued')).toThrow('CONVERSATION_NOT_ACTIVE')
    expect(() => seedSqliteRun(database, 'late', { conversationId: 'task-1' })).toThrow('CONVERSATION_NOT_ACTIVE')
    const executions = createExecutionRepository(database)
    const cancelled = executions.requestCancel('run-task-1', now)[0]!
    expect(cancelled).toMatchObject({ cancelRequestedAt: now, run: { generation: 1, status } })
    const closing = executions.beginClosing(executionFence(cancelled, cancelled), 'cancel')
    expect(closing).toMatchObject({ phase: 'closing', run: { generation: 2, status } })
    expect(executions.finishClosing(executionFence(closing, closing), 'cancelled', now, 'RUN_CANCELLED').run)
      .toMatchObject({ status: 'cancelled', errorCode: 'RUN_CANCELLED' })
    expect(() => database.exec('UPDATE runs SET status = \'queued\', generation = generation + 1')).toThrow('CONVERSATION_NOT_ACTIVE')
  })

  it('allows failure closure of an inactive task but rejects generation changes on a closed execution', () => {
    const { database, deletion } = fixture()
    seed(database)
    database.exec('UPDATE runs SET status = \'running\'')
    deletion.commit('task-1', now)
    expect(() => database.exec('UPDATE runs SET generation = generation + 1')).toThrow('CONVERSATION_NOT_ACTIVE')
    database.exec('UPDATE execution_state SET phase = \'working\', cleanup_state = \'pending\'')
    const executions = createExecutionRepository(database)
    const record = executions.find('run-task-1')!
    const closing = executions.beginClosing(executionFence(record, record), 'failure')
    expect(executions.finishClosing(executionFence(closing, closing), 'failed', now, 'RUNTIME_RESTARTED').run)
      .toMatchObject({ status: 'failed', errorCode: 'RUNTIME_RESTARTED' })
    expect(() => database.exec('UPDATE runs SET status = \'running\'')).toThrow('CONVERSATION_NOT_ACTIVE')
  })

  it('keeps in-flight file preparations and task content intact', async () => {
    const { database, home, deletion, purge } = fixture()
    seed(database)
    const { path } = content(home)
    managed(database, path)
    database.exec(`INSERT INTO file_preparations(id,operation_id,owner_instance,actor_id,data_generation,kind,target_owner_id,state,reserved_bytes,created_at,updated_at)
      SELECT 'file-1','operation','instance',local_actor_id,data_generation,'message','input-run-task-1','published',15,'${now}','${now}' FROM storage_profile`)
    deletion.commit('task-1', now)
    await expect(purge.purge('task-1')).rejects.toMatchObject({ code: 'CONVERSATION_RESOURCES_BUSY' })
    expect(database.prepare('SELECT state FROM file_preparations').get()?.state).toBe('published')
    expect(readFileSync(path, 'utf8')).toBe('private content')
    database.exec('UPDATE file_preparations SET state = \'settled\', reserved_bytes = 0')
    deletion.retry('task-1', now)
    await purge.purge('task-1')
    expect(database.prepare('SELECT * FROM file_preparations').all()).toEqual([])
  })

  it('purges branches, child execution trees, stored events and immutable quote projections', async () => {
    const { database, home, deletion, purge } = fixture()
    seed(database)
    database.prepare('INSERT INTO conversation_branches(id,conversation_id,parent_branch_id,created_at) VALUES (?,?,?,?)').run('fork', 'task-1', 'branch-task-1', now)
    seedSqliteRun(database, 'child', { conversationId: 'task-1' })
    database.exec('UPDATE runs SET parent_run_id = \'run-task-1\', root_run_id = \'run-task-1\', execution_kind = \'npc_child\', branch_id = \'fork\' WHERE id = \'child\'; UPDATE runs SET status = \'completed\'; UPDATE execution_state SET phase = \'closed\', cleanup_state = \'clean\'')
    database.prepare('INSERT INTO run_events(run_id,sequence,event_type,payload_json,created_at) VALUES (?,?,?,?,?)').run('child', 1, 'fixture', '{"text":"secret result"}', now)
    database.exec(`INSERT INTO product_content_references(id,owner_actor_id,data_generation,quote_json,created_at)
      SELECT 'quote',local_actor_id,data_generation,'{"id":"quote","text":"secret quotation","source":{"conversationId":"task-1"}}','${now}' FROM storage_profile`)
    database.exec('INSERT INTO product_content_reference_owners VALUES (\'quote\', \'conversation\', \'task-1\')')
    expect(() => database.exec('DELETE FROM product_content_references')).toThrow('IMMUTABLE')
    const { directory } = content(home)
    mkdirSync(join(directory, 'session', 'fork'), { recursive: true })
    writeFileSync(join(directory, 'session', 'fork', 'child.jsonl'), 'secret session')
    deletion.commit('task-1', now)
    await purge.purge('task-1')
    for (const table of ['conversation_branches', 'runs', 'execution_work_attempts', 'run_events', 'product_content_references'])
      expect(database.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([])
    expect(existsSync(directory)).toBe(false)
  })

  it('backs up detached usage without retaining runs, invocations or their bodies', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lexora-purge-backup-'))
    directories.push(home)
    const path = join(home, 'buddy.sqlite3')
    const database = openBuddySqliteDatabase({ databasePath: path })
    try {
      seed(database)
      database.exec(`INSERT INTO extension_invocations(id,extension_id,action_id,conversation_id,trigger,status,started_at,result_message)
        VALUES ('invocation','extension','action','task-1','manual','completed','${now}','private action result');
        INSERT INTO usage_records (id,invocation_id,source_entry_id,provider,model,purpose,input_tokens,output_tokens,
          cache_read_tokens,cache_write_tokens,total_tokens,input_cost,output_cost,cache_read_cost,cache_write_cost,total_cost,created_at)
        VALUES ('usage','invocation','entry','fixture','fixture','extension.action',1,2,0,0,3,1,2,0,0,3,'${now}')`)
      createConversationDeletionRepository(database).commit('task-1', now)
      await new ConversationPurgeService({ database, home, storageAuthority: 'sqlite' }).purge('task-1')
    }
    finally { database.close() }
    await rewriteIsolatedSnapshotDatabase(path, candidate => selectBackupDatabase(candidate, ['tasks']))
    const backup = openBuddySqliteDatabase({ databasePath: path })
    databases.push(backup)
    expect(backup.prepare('SELECT run_id,invocation_id,detached,total_tokens,total_cost FROM usage_records').get()).toMatchObject({ run_id: null, invocation_id: null, detached: 1, total_tokens: 3, total_cost: 3 })
    expect(backup.prepare('SELECT * FROM extension_invocations').all()).toEqual([])
    expect(backup.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('purges a genuinely prepared and settled attachment with its immutable historical staging path', async () => {
    const { database, home, deletion, purge } = fixture()
    seed(database)
    const { path } = content(home)
    const persistence = createAttachmentPersistenceRepository(database)
    const file = persistence.prepare({ operationId: 'import', ownerInstance: 'fixture', availableBytes: 1000, stagingDirectory: join(home, 'managed-files', 'staging'), kind: 'message', targetOwnerId: 'input-run-task-1', path, sizeBytes: 15 })
    persistence.publish(path, { sizeBytes: 15, sha256: 'a'.repeat(64), durability: 'file-and-directory-sync' })
    database.prepare(`INSERT INTO attachments (id,message_id,draft_id,name,mime_type,size_bytes,stored_path,created_at)
      VALUES ('real-attachment','input-run-task-1',NULL,'fixture','text/plain',15,?,?)`).run(path, now)
    persistence.settle([path], 'commit')
    expect(persistence.get(path)?.temporaryPath).toBe(file.temporaryPath)
    mkdirSync(join(home, 'managed-files', 'staging'), { recursive: true })
    writeFileSync(file.temporaryPath!, 'leftover owned staging')
    const unrelated = join(home, 'managed-files', 'staging', 'unrelated.part')
    writeFileSync(unrelated, 'keep')
    deletion.commit('task-1', now)
    await purge.purge('task-1')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(file.temporaryPath!)).toBe(false)
    expect(readFileSync(unrelated, 'utf8')).toBe('keep')
    expect(database.prepare('SELECT * FROM managed_files').all()).toEqual([])
    expect(database.prepare('SELECT * FROM file_preparations').all()).toEqual([])
  })
})

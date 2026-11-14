import type { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationPurgeService } from '../../conversations/ConversationPurgeService'
import { createConversationArchiveRepository } from '../conversationArchiveRepository'
import { createConversationDeletionRepository } from '../conversationDeletionRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'

const now = '2026-10-01T00:00:00.000Z'
const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'lexora-legacy-purge-'))
  directories.push(home)
  const database = openBuddyDatabase({ databasePath: join(home, 'buddy.sqlite3') })
  databases.push(database)
  expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(42)
  const conversations = createConversationRepository(database)
  const deletion = createConversationDeletionRepository(database)
  const archive = createConversationArchiveRepository(database)
  const purge = new ConversationPurgeService({ database, home, storageAuthority: 'legacy_jsonl' })
  function file(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'private fixture')
    return path
  }
  function seed(id: string) {
    conversations.create({ id, branchId: `branch-${id}`, spaceId: null, title: 'Fixture task', createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    database.prepare(`INSERT INTO messages (id,conversation_id,branch_id,role,content_json,created_at)
      VALUES (?, ?, ?, 'user', '{"text":"private fixture"}', ?)`).run(`input-${id}`, id, `branch-${id}`, now)
    database.prepare(`INSERT INTO runs (id,conversation_id,branch_id,triggering_message_id,provider,model,purpose,status,started_at)
      VALUES (?, ?, ?, ?, 'fixture', 'fixture', 'chat', 'queued', ?)`).run(`run-${id}`, id, `branch-${id}`, `input-${id}`, now)
    database.prepare(`UPDATE runs SET status = 'completed' WHERE conversation_id = ?`).run(id)
    database.prepare(`UPDATE execution_state SET phase = 'closed', cleanup_state = 'clean' WHERE run_id = ?`).run(`run-${id}`)
    database.prepare('INSERT INTO task_attention(conversation_id,seen_run_id) VALUES (?, ?)').run(id, `run-${id}`)
    expect(conversations.listMembers(id)).toHaveLength(1)
    return file(join(home, 'conversations', id, 'events', `run-${id}.jsonl`))
  }
  function draft(id: string, owner: string | null) {
    database.prepare(`INSERT INTO composer_drafts(id,scope_kind,conversation_id,branch_id,content_json,approval_policy,execution_profile,created_at,updated_at)
      VALUES (?, ?, ?, ?, '{}', 'policy', 'workspace_write', ?, ?)`).run(id, owner ? 'conversation_branch' : 'task', owner, owner ? `branch-${owner}` : null, now, now)
    return file(join(home, 'drafts', id, 'attachments', 'private.txt'))
  }
  function lease(status: 'active' | 'hazard' | 'released') {
    database.prepare(`INSERT INTO run_mutation_leases(invocation_id,run_id,segment_id,claims_json,status,created_at,updated_at)
      VALUES ('lease','run-target','segment','[]',?,?,?)`).run(status, now, now)
  }
  return { database, home, conversations, deletion, archive, purge, file, seed, draft, lease }
}

describe('v42 JSONL conversation purge', () => {
  it('removes owned content and all dependent metadata while keeping spaces, outside grants, unrelated drafts and cumulative usage', async () => {
    const f = fixture()
    f.seed('target')
    const ownDraft = f.draft('owned-draft', 'target')
    const unownedDraft = f.draft('unowned-draft', null)
    const workspace = f.file(join(f.home, 'conversations', 'target', 'workspace', 'secret.txt'))
    const session = f.file(join(f.home, 'conversations', 'target', 'session', 'branch-target', 'private.jsonl'))
    const attachment = f.file(join(f.home, 'conversations', 'target', 'inputs', 'input-target', 'private.txt'))
    const spaceFile = f.file(join(f.home, 'spaces', 'space', 'workspace', 'keep.txt'))
    const external = f.file(join(f.home, 'authorized-external', 'keep.txt'))
    f.database.prepare(`INSERT INTO spaces(id,name,memory_scope,created_at,updated_at) VALUES ('space','Fixture','personal_and_space',?,?)`).run(now, now)
    f.database.prepare(`UPDATE conversations SET space_id = 'space' WHERE id = 'target'`).run()
    f.database.prepare(`INSERT INTO conversation_directory_grants(id,conversation_id,root,canonical_root,created_at) VALUES ('grant','target',?,?,?)`).run(dirname(external), dirname(external), now)
    f.database.prepare(`INSERT INTO space_directory_bindings(id,space_id,root,canonical_root,access_granted_at,created_at,updated_at) VALUES ('binding','space',?,?,?,?,?)`).run(dirname(spaceFile), dirname(spaceFile), now, now, now)
    f.database.prepare(`INSERT INTO attachments(id,message_id,name,mime_type,size_bytes,stored_path,created_at) VALUES ('attachment','input-target','Fixture','text/plain',15,?,?)`).run(attachment, now)
    f.database.prepare(`INSERT INTO attachments(id,draft_id,name,mime_type,size_bytes,stored_path,created_at) VALUES ('draft-attachment','owned-draft','Fixture','text/plain',15,?,?)`).run(ownDraft, now)
    f.database.prepare(`INSERT INTO composer_resources(id,draft_id,name,mime_type,size_bytes,state,attachment_id,content_hash,created_at,updated_at)
      VALUES ('resource','owned-draft','Fixture','text/plain',15,'ready','draft-attachment','hash',?,?)`).run(now, now)
    f.database.prepare(`INSERT INTO conversation_pi_trees(conversation_id,session_file,root_entry_id) VALUES ('target',?,'root')`).run(session)
    f.database.prepare(`INSERT INTO extension_invocations(id,extension_id,action_id,conversation_id,trigger,status,started_at) VALUES ('invocation','extension','action','target','fixture','completed',?)`).run(now)
    for (const [id, runId, invocationId] of [['run-usage', 'run-target', null], ['plugin-usage', null, 'invocation']]) {
      f.database.prepare(`INSERT INTO usage_records(id,run_id,invocation_id,source_entry_id,provider,model,purpose,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,input_cost,output_cost,cache_read_cost,cache_write_cost,total_cost,created_at)
        VALUES (?,?,?,'entry','fixture','fixture','chat',10,20,0,0,30,1,2,0,0,3,?)`).run(id!, runId!, invocationId!, now)
    }
    f.lease('released')
    f.database.prepare(`INSERT INTO run_mutation_processes VALUES ('lease','process','released',?)`).run(now)
    f.database.prepare(`INSERT INTO run_mutation_evidence(invocation_id,kind,outcome,reason,actor,created_at) VALUES ('lease','quiesced','applied','fixture','system',?)`).run(now)
    f.database.prepare(`INSERT INTO run_mutation_executions VALUES ('execution','lease','dispatch','settled',?,?)`).run(now, now)
    f.deletion.commit('target', now)
    await f.purge.purge('target')
    for (const path of [join(f.home, 'conversations', 'target'), dirname(dirname(ownDraft)), session, workspace, attachment]) expect(existsSync(path), path).toBe(false)
    for (const path of [unownedDraft, spaceFile, external]) expect(readFileSync(path, 'utf8')).toBe('private fixture')
    for (const table of ['conversations', 'conversation_members', 'task_attention', 'conversation_branches', 'messages', 'runs', 'run_events', 'run_event_checkpoints', 'run_event_maintenance', 'execution_threads', 'execution_state', 'execution_work_attempts', 'conversation_publications', 'attachments', 'composer_resources', 'extension_invocations', 'run_mutation_leases', 'run_mutation_processes', 'run_mutation_evidence', 'run_mutation_executions', 'conversation_directory_grants', 'conversation_deletion_jobs'])
      expect(f.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, table).toBe(0)
    expect(f.database.prepare('SELECT id FROM composer_drafts').all()).toEqual([{ id: 'unowned-draft' }])
    expect(f.database.prepare('SELECT run_id,invocation_id,total_tokens,total_cost FROM usage_records').all()).toEqual([
      { run_id: null, invocation_id: null, total_tokens: 30, total_cost: 3 },
      { run_id: null, invocation_id: null, total_tokens: 30, total_cost: 3 },
    ])
    expect(f.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    await f.purge.purge('target')
  })

  it.each(['attachment', 'run-session', 'tree-session', 'thread-session', 'artifact', 'grant', 'space', 'before-snapshot', 'after-snapshot'] as const)('preserves cross-task %s paths before touching any file', async (kind) => {
    const f = fixture()
    const path = f.seed('target')
    f.seed('other')
    const db = f.database
    if (kind === 'attachment')
      db.prepare(`INSERT INTO attachments(id,message_id,name,mime_type,size_bytes,stored_path,created_at) VALUES ('shared','input-other','Fixture','text/plain',15,?,?)`).run(path, now)
    if (kind === 'run-session')
      db.prepare(`UPDATE runs SET pi_session_file = ? WHERE id = 'run-other'`).run(path)
    if (kind === 'tree-session')
      db.prepare(`INSERT INTO conversation_pi_trees VALUES ('other',?,'root')`).run(path)
    if (kind === 'thread-session') {
      db.prepare(`INSERT INTO execution_threads(id,conversation_id,actor_id,kind,created_at) SELECT 'thread','other',default_buddy_id,'actor',? FROM buddy_catalog`).run(now)
      db.prepare(`INSERT INTO execution_thread_bindings VALUES ('thread',?,'root')`).run(path)
    }
    if (kind === 'artifact')
      db.prepare(`INSERT INTO artifacts(id,conversation_id,kind,current_path,directory_grant_id,directory_root,relative_path,name,mime_type,size_bytes,created_at,updated_at) VALUES ('artifact','other','file',?,'grant',?,'file','Fixture','text/plain',15,?,?)`).run(path, dirname(path), now, now)
    if (kind === 'grant')
      db.prepare(`INSERT INTO conversation_directory_grants(id,conversation_id,root,canonical_root,created_at) VALUES ('grant','other',?,?,?)`).run(path, path, now)
    if (kind === 'space') {
      db.prepare(`INSERT INTO spaces(id,name,memory_scope,created_at,updated_at) VALUES ('space','Fixture','personal_and_space',?,?)`).run(now, now)
      db.prepare(`INSERT INTO space_directory_bindings(id,space_id,root,canonical_root,access_granted_at,created_at,updated_at) VALUES ('binding','space',?,?,?,?,?)`).run(path, path, now, now, now)
    }
    if (kind === 'before-snapshot' || kind === 'after-snapshot') {
      db.prepare(`INSERT INTO run_change_sets(id,run_id,conversation_id,coverage,status,created_at,updated_at) VALUES ('changes','run-other','other','complete','completed',?,?)`).run(now, now)
      db.prepare(`INSERT INTO run_file_change_captures(id,change_set_id,sequence,tool_call_id,tool_name,relative_path,before_kind,${kind === 'before-snapshot' ? 'before_snapshot_path' : 'after_snapshot_path'},status,created_at)
        VALUES ('capture','changes',1,'tool','write','file','text',?,'completed',?)`).run(path, now)
    }
    f.deletion.commit('target', now)
    await expect(f.purge.purge('target')).rejects.toMatchObject({ code: 'CONVERSATION_FILES_REFERENCED' })
    expect(readFileSync(path, 'utf8')).toBe('private fixture')
    expect(f.archive.list({ kind: 'deleting' }).items[0]).toMatchObject({ deletionStatus: 'failed', errorCode: 'CONVERSATION_FILES_REFERENCED' })
  })

  it.each(['running', 'hazard'] as const)('blocks automatic expiry and physical deletion during %s resources', async (state) => {
    const f = fixture()
    const path = f.seed('target')
    if (state === 'running')
      f.database.prepare('UPDATE runs SET status = ?').run(state)
    else f.lease(state)
    f.archive.archive('target', now)
    f.archive.setPolicy(3)
    expect(f.archive.due('2027-01-01T00:00:00.000Z')).toEqual([])
    f.deletion.commit('target', now)
    await expect(f.purge.purge('target')).rejects.toMatchObject({ code: 'CONVERSATION_RESOURCES_BUSY' })
    expect(readFileSync(path, 'utf8')).toBe('private fixture')
    f.database.exec(`UPDATE runs SET status = 'cancelled'; UPDATE execution_state SET phase = 'closed', cleanup_state = 'clean'; UPDATE run_mutation_leases SET status = 'released'`)
    f.deletion.retry('target', now)
    await f.purge.purge('target')
    expect(existsSync(path)).toBe(false)
  })

  it('keeps a shared draft resource and permits retry after its other owner releases it', async () => {
    const f = fixture()
    f.seed('target')
    const owned = f.draft('owned', 'target')
    f.draft('other', null)
    f.database.prepare(`INSERT INTO attachments(id,draft_id,name,mime_type,size_bytes,stored_path,created_at) VALUES ('shared','owned','Fixture','text/plain',15,?,?)`).run(owned, now)
    f.database.prepare(`INSERT INTO composer_resources(id,draft_id,name,mime_type,size_bytes,state,attachment_id,content_hash,created_at,updated_at) VALUES ('resource','other','Fixture','text/plain',15,'ready','shared','hash',?,?)`).run(now, now)
    f.deletion.commit('target', now)
    await expect(f.purge.purge('target')).rejects.toMatchObject({ code: 'CONVERSATION_FILES_REFERENCED' })
    expect(existsSync(owned)).toBe(true)
    f.database.exec('DELETE FROM composer_resources')
    f.deletion.retry('target', now)
    await f.purge.purge('target')
    expect(existsSync(owned)).toBe(false)
  })

  it('cleans queue-owned drafts but refuses a queue ID shared by an unrelated composer draft', async () => {
    const f = fixture()
    f.seed('target')
    const draft = f.draft('queue', null)
    f.database.prepare(`INSERT INTO chat_queue(id,conversation_id,branch_id,request_id,request_fingerprint,prepared_json,state,created_at)
      VALUES ('queue','target','branch-target','request','fingerprint','{}','cancelled',?)`).run(now)
    f.database.prepare(`INSERT INTO attachments(id,draft_id,name,mime_type,size_bytes,stored_path,created_at)
      VALUES ('queued-attachment','queue','Fixture','text/plain',15,?,?)`).run(draft, now)
    f.deletion.commit('target', now)
    await expect(f.purge.purge('target')).rejects.toMatchObject({ code: 'CONVERSATION_FILES_REFERENCED' })
    expect(readFileSync(draft, 'utf8')).toBe('private fixture')
    f.database.exec(`DELETE FROM composer_drafts WHERE id = 'queue'`)
    f.deletion.retry('target', now)
    await f.purge.purge('target')
    expect(existsSync(dirname(dirname(draft)))).toBe(false)
    expect(f.database.prepare('SELECT * FROM chat_queue').all()).toEqual([])
    expect(f.database.prepare('SELECT * FROM attachments').all()).toEqual([])
  })

  it('never follows a symlink and retries after a persisted partial filesystem failure across reopening', async () => {
    const f = fixture()
    f.seed('target')
    const outside = f.file(join(f.home, 'outside', 'keep.txt'))
    const link = join(f.home, 'conversations', 'target', 'outside')
    symlinkSync(dirname(outside), link, 'dir')
    f.deletion.commit('target', now)
    await expect(f.purge.purge('target')).rejects.toMatchObject({ code: 'CONVERSATION_FILE_BOUNDARY' })
    expect(readFileSync(outside, 'utf8')).toBe('private fixture')
    rmSync(link)
    const blockedFile = f.file(join(f.home, 'conversations', 'target', 'blocked', 'private.txt'))
    const blocked = dirname(blockedFile)
    chmodSync(blocked, 0o500)
    f.deletion.retry('target', now)
    try {
      await expect(f.purge.purge('target')).rejects.toMatchObject({ code: 'CONVERSATION_PURGE_FAILED' })
      expect(f.database.prepare('SELECT status,manifest_json FROM conversation_deletion_jobs').get()).toMatchObject({ status: 'failed', manifest_json: expect.any(String) })
    }
    finally { chmodSync(blocked, 0o700) }
    f.database.close()
    databases.splice(databases.indexOf(f.database), 1)
    const database = openBuddyDatabase({ databasePath: join(f.home, 'buddy.sqlite3') })
    databases.push(database)
    expect(createConversationDeletionRepository(database).pending()).toEqual([])
    createConversationDeletionRepository(database).retry('target', now)
    await new ConversationPurgeService({ database, home: f.home, storageAuthority: 'legacy_jsonl' }).purge('target')
    expect(existsSync(join(f.home, 'conversations', 'target'))).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('private fixture')
  })
})

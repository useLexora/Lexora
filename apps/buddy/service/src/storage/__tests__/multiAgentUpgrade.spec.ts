import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import type { PrepareTurnRequestInput } from '../turnRequestRepository'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { approvalReviewPayloadSchema } from '../../../../shared/permissions/approvalReviewPayload'
import { createRunEventLog } from '../../events/createRunEventLog'
import { RUN_EVENT_PROJECTION_VERSION } from '../../events/RunEventRecovery'
import { createBuddyRepository } from '../buddyRepository'
import { createChatQueueRepository } from '../chatQueueRepository'
import { createConversationPublicationRepository } from '../conversationPublicationRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { BUDDY_SCHEMA_MIGRATIONS, BUDDY_SCHEMA_VERSION } from '../schema'
import { createTurnRequestRepository } from '../turnRequestRepository'
import { MIGRATION_TEST_TIMEOUT, openMigrationFixtureDatabase } from './migrationFixture'

const now = '2026-10-10T00:00:00.000Z'
const model = { providerId: 'fixture', modelId: 'model', reasoning: 'high', serviceTier: null }

it('preserves v25 historical authors and facts across upgrade, forced replay and old queue dispatch after a leader switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-multi-agent-upgrade-'))
  const path = join(root, 'buddy.sqlite3')
  const previous = openMigrationFixtureDatabase(path)
  const target = 'default'
  const queue: Omit<PrepareTurnRequestInput, 'buddyId'> = {
    queuedMessageId: 'queue',
    conversationId: 'conversation',
    branchId: 'branch',
    spaceId: null,
    approvalPolicy: 'policy',
    executionProfile: 'workspace_write',
    createdAt: now,
    attachmentBindings: [],
    draft: { draftId: 'draft', expectedRevision: 0 },
    provider: 'fixture',
    model: 'model',
    requestId: 'queue-request',
    requestFingerprint: 'fingerprint',
    runId: 'queued-run',
    title: 'Historical task',
    userMessageId: 'queued-question',
    userMessageContent: { userContent: createBuddyUserContent('Historical queued input'), resourceSnapshots: [] },
    runInput: { attachmentIds: [], contextItems: [], prompt: 'Historical queued input', reasoning: 'high', serviceTier: null },
  }
  const answerContent = { text: 'Retained answer', attachmentIds: ['attachment'] }
  const approvalPayload = { card: 'paths', access: 'read', grant: null, toolName: 'read', targets: [{ path: '/fixture/source.txt', zone: 'workspace' }] }
  const events: BuddyRunEvent[] = [
    { runId: 'old-run', sequence: 1, createdAt: now, type: 'message.completed', payload: { messageId: 'answer', role: 'assistant', content: answerContent, stopReason: 'completed' } },
    { runId: 'old-run', sequence: 2, createdAt: now, type: 'approval.requested', payload: { id: 'approval', runId: 'old-run', toolCallId: 'read-call', kind: 'read', status: 'pending', summary: 'Read fixture', createdAt: now, resolvedAt: null, payload: approvalPayload } },
    { runId: 'old-run', sequence: 3, createdAt: now, type: 'approval.resolved', payload: { id: 'approval', status: 'approved', resolvedAt: now } },
    { runId: 'old-run', sequence: 4, createdAt: now, type: 'output.produced', payload: { artifactIds: ['artifact'], sourceToolCallId: 'write-call', sourceToolName: 'write' } },
    { runId: 'old-run', sequence: 5, createdAt: now, type: 'run.completed', payload: {} },
  ]
  const legacyTables = ['attachments', 'artifacts', 'conversation_directory_grants', 'conversation_pi_trees', 'run_tree_sources']
  let retained: unknown[] = []
  try {
    previous.exec('PRAGMA foreign_keys = OFF')
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(value => value.version <= 25))
      previous.exec(migration.sql)
    previous.prepare('INSERT INTO conversations (id,title,active_branch_id,created_at,updated_at,model_selection_json) VALUES (?, ?, ?, ?, ?, ?)').run('conversation', 'Historical task', 'branch', now, now, JSON.stringify(model))
    previous.prepare('INSERT INTO conversation_branches (id,conversation_id,created_at) VALUES (?, ?, ?)').run('branch', 'conversation', now)
    previous.prepare('INSERT INTO messages (id,conversation_id,branch_id,role,content_json,created_at) VALUES (?, ?, ?, ?, ?, ?)').run('question', 'conversation', 'branch', 'user', '{"text":"Historical question"}', now)
    previous.prepare('INSERT INTO runs (id,conversation_id,branch_id,triggering_message_id,provider,model,purpose,status,started_at,completed_at,pi_session_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old-run', 'conversation', 'branch', 'question', 'fixture', 'model', 'chat', 'completed', now, now, '/fixture/original.jsonl')
    previous.prepare('INSERT INTO messages (id,conversation_id,branch_id,run_id,role,content_json,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('answer', 'conversation', 'branch', 'old-run', 'assistant', JSON.stringify(answerContent), now)
    previous.prepare('INSERT INTO attachments (id,message_id,stored_path,name,mime_type,size_bytes,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('attachment', 'answer', '/fixture/attachment.txt', 'Attachment', 'text/plain', 12, now)
    previous.prepare('INSERT INTO conversation_directory_grants (id,conversation_id,root,canonical_root,created_at) VALUES (?, ?, ?, ?, ?)').run('grant', 'conversation', '/fixture', '/fixture', now)
    previous.prepare('INSERT INTO artifacts (id,conversation_id,current_path,directory_grant_id,directory_root,relative_path,kind,name,mime_type,size_bytes,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('artifact', 'conversation', '/fixture/output.txt', 'grant', '/fixture', 'output.txt', 'file', 'Output', 'text/plain', 8, now, now)
    previous.prepare('INSERT INTO approvals (id,run_id,tool_call_id,kind,status,summary,payload_json,created_at,resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('approval', 'old-run', 'read-call', 'read', 'approved', 'Read fixture', JSON.stringify(approvalPayload), now, now)
    previous.exec(`INSERT INTO runs (id,conversation_id,branch_id,triggering_message_id,provider,model,purpose,status,started_at,completed_at,pi_session_file)
      SELECT 'prior-run',conversation_id,branch_id,triggering_message_id,provider,model,purpose,status,started_at,completed_at,pi_session_file FROM runs WHERE id = 'old-run'`)
    previous.prepare('INSERT INTO conversation_pi_trees VALUES (?, ?, ?)').run('conversation', '/fixture/original.jsonl', 'original-root')
    previous.prepare('INSERT INTO run_tree_sources VALUES (?, ?, ?)').run('old-run', 'prior-run', 'before')
    previous.prepare('INSERT INTO composer_drafts (id,scope_kind,conversation_id,branch_id,revision,content_json,approval_policy,execution_profile,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('draft', 'conversation_branch', 'conversation', 'branch', 1, JSON.stringify(createBuddyUserContent('')), 'policy', 'workspace_write', now, now)
    previous.prepare('INSERT INTO chat_queue (id,conversation_id,branch_id,request_id,request_fingerprint,prepared_json,state,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('queue', 'conversation', 'branch', queue.requestId, queue.requestFingerprint, JSON.stringify(queue), 'waiting', now)
    for (const event of events)
      previous.prepare('INSERT INTO run_events (run_id,sequence,event_type,payload_json,created_at) VALUES (?, ?, ?, ?, ?)').run(event.runId, event.sequence, event.type, JSON.stringify(event.payload), event.createdAt)
    retained = legacyTables.map(table => previous.prepare(`SELECT * FROM ${table}`).all())
    previous.exec('PRAGMA user_version = 25')
  }
  finally {
    previous.close()
  }
  const directory = join(root, 'conversations', 'conversation', 'events')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'old-run.jsonl'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`)
  let database = openBuddyDatabase({ databasePath: path })
  const log = createRunEventLog({ database, conversationsDirectory: join(root, 'conversations') })
  try {
    expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(BUDDY_SCHEMA_VERSION)
    expect(legacyTables.map(table => database.prepare(`SELECT * FROM ${table}`).all())).toEqual(retained)
    expect(database.prepare('SELECT model_selection_source,model_selection_json FROM conversation_members WHERE conversation_id = ? AND actor_id = ?').get('conversation', target)).toEqual({ model_selection_source: 'legacy', model_selection_json: JSON.stringify(model) })
    const approval = database.prepare('SELECT * FROM approvals WHERE id = ?').get('approval')
    const publicationRepository = createConversationPublicationRepository(database)
    const beforePublic = publicationRepository.listPublications('conversation', 'branch')
    const beforeSequence = publicationRepository.getPublicSequence('conversation')
    const migratedQueue = JSON.parse(String(database.prepare('SELECT prepared_json FROM chat_queue WHERE id = ?').get('queue')!.prepared_json))
    expect(migratedQueue).toEqual({ ...queue, buddyId: target, queueRouting: { mode: 'actor', actorId: target } })
    await expect(log.recoverAll({ force: true })).resolves.toMatchObject({ rebuilt: 1, failed: 0 })
    expect(database.prepare('SELECT projection_version FROM run_event_checkpoints WHERE run_id = ?').get('old-run')).toEqual({ projection_version: RUN_EVENT_PROJECTION_VERSION })
    expect(legacyTables.map(table => database.prepare(`SELECT * FROM ${table}`).all())).toEqual(retained)
    expect(database.prepare('SELECT * FROM approvals WHERE id = ?').get('approval')).toEqual({ ...approval, payload_json: JSON.stringify(approvalReviewPayloadSchema.parse(approvalPayload)) })
    const publications = publicationRepository.listPublications('conversation', 'branch')
    expect(publications).toEqual(beforePublic)
    expect(publicationRepository.getPublicSequence('conversation')).toBe(beforeSequence)
    await log.recoverAll({ force: true })
    expect(publicationRepository.listPublications('conversation', 'branch')).toEqual(beforePublic)
    expect(publicationRepository.getPublicSequence('conversation')).toBe(beforeSequence)
    expect(publications).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', messageId: 'answer', actorId: target, text: 'Retained answer' }),
      expect.objectContaining({ kind: 'output', actorId: target, artifacts: [{ artifactId: 'artifact', name: 'Output', kind: 'file' }] }),
    ]))
    const buddies = createBuddyRepository(database)
    const next = buddies.create({ name: 'New leader' })
    createConversationRepository(database).addMember({ id: 'conversation', buddyId: next.id, updatedAt: now })
    createConversationRepository(database).setBuddy({ id: 'conversation', buddyId: next.id, updatedAt: now })
    const pending = createChatQueueRepository(database).pending({ id: 'queue', conversationId: 'conversation', branchId: 'branch' })!
    expect(pending.buddyId).toBe(target)
    createTurnRequestRepository(database).prepare(pending)
    expect(database.prepare('SELECT buddy_id FROM runs ORDER BY id').all()).toEqual([{ buddy_id: target }, { buddy_id: target }, { buddy_id: target }])
    expect(database.prepare('SELECT buddy_id FROM conversations').get()).toEqual({ buddy_id: next.id })
    expect(database.prepare('SELECT state FROM chat_queue WHERE id = ?').get('queue')).toEqual({ state: 'sent' })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    await log.close()
    database.close()
    database = openBuddyDatabase({ databasePath: path })
    expect(JSON.parse(String(database.prepare('SELECT prepared_json FROM chat_queue WHERE id = ?').get('queue')!.prepared_json))).toEqual(migratedQueue)
    expect(database.prepare('SELECT buddy_id FROM runs ORDER BY id').all()).toEqual([{ buddy_id: target }, { buddy_id: target }, { buddy_id: target }])
  }
  finally {
    await log.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}, MIGRATION_TEST_TIMEOUT)

it('rolls back the entire v25 upgrade on interruption and retries without duplicate definitions or rewritten history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-buddies-migration-retry-'))
  const databasePath = join(root, 'buddy.sqlite3')
  let database = openMigrationFixtureDatabase(databasePath)
  try {
    database.exec('PRAGMA foreign_keys = OFF')
    for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(value => value.version <= 25))
      database.exec(migration.sql)
    database.prepare('INSERT INTO conversations (id, model_selection_json, created_at, updated_at) VALUES (?, ?, ?, ?)').run('conversation', JSON.stringify(model), now, now)
    database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('branch', 'conversation', now)
    const prepared = { runInput: { prompt: 'Retained input' } }
    database.prepare('INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('queue', 'conversation', 'branch', 'request', 'fingerprint', JSON.stringify(prepared), 'paused', now)
    database.exec(`
      PRAGMA user_version = 25;
      CREATE TRIGGER interrupt_upgrade BEFORE UPDATE OF prepared_json ON chat_queue
      BEGIN SELECT RAISE(ABORT, 'fixture migration interruption'); END;
    `)
    const schema = 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'
    const originalSchema = database.prepare(schema).all()
    const originalConversation = database.prepare('SELECT * FROM conversations').get()
    const originalQueue = database.prepare('SELECT * FROM chat_queue').get()
    database.close()

    expect(() => openBuddyDatabase({ databasePath })).toThrow('fixture migration interruption')
    database = openMigrationFixtureDatabase(databasePath)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 25 })
    expect(database.prepare(schema).all()).toEqual(originalSchema)
    expect(database.prepare('SELECT * FROM conversations').get()).toEqual(originalConversation)
    expect(database.prepare('SELECT * FROM chat_queue').get()).toEqual(originalQueue)
    database.exec('DROP TRIGGER interrupt_upgrade')
    database.close()

    database = openBuddyDatabase({ databasePath })
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(database.prepare('SELECT * FROM chat_queue').get()).toEqual({
      ...originalQueue,
      prepared_json: JSON.stringify({ ...prepared, buddyId: 'default', queueRouting: { mode: 'actor', actorId: 'default' } }),
    })
    expect(database.prepare('SELECT model_selection_json, model_selection_source FROM conversation_members').get()).toEqual({ model_selection_json: JSON.stringify(model), model_selection_source: 'legacy' })
    const catalog = createBuddyRepository(database).list()
    expect(catalog.buddies.filter(buddy => buddy.kind === 'actor').map(buddy => buddy.id)).toEqual(['default'])
    expect(catalog.buddies.filter(buddy => buddy.kind === 'npc')).toHaveLength(4)
    database.close()
    database = openBuddyDatabase({ databasePath })
    expect(createBuddyRepository(database).list()).toEqual(catalog)
  }
  finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}, MIGRATION_TEST_TIMEOUT)

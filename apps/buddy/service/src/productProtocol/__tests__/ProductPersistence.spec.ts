import type { DatabaseSync } from 'node:sqlite'
import type { BuddyUserContentV1 } from '../../../../shared/conversation/buddyUserContent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { restoreProductContent } from '../../../../shared/productProtocol/content'
import { PRODUCT_QUERY_METHODS, productDraftSchema, productPageSchema } from '../../../../shared/productProtocol/queries'
import { publicRunEventSchema } from '../../../../shared/runs/publicRunEvent'
import { ComposerDraftCommandService } from '../../chat/ComposerDraftCommandService'
import { ComposerDraftService } from '../../chat/ComposerDraftService'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { ConversationPurgeService } from '../../conversations/ConversationPurgeService'
import { TaskMarkService } from '../../conversations/TaskMarkService'
import { SqliteRunEventWriter } from '../../events/SqliteRunEventWriter'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createConversationDeletionRepository } from '../../storage/conversationDeletionRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { createTaskMarkRepository } from '../../storage/taskMarkRepository'
import { withTransaction } from '../../storage/transaction'
import { createProductCommandHandlers } from '../createProductCommandHandlers'
import { createProductSynchronization } from '../createProductSynchronization'
import { ProductContentReferences } from '../ProductContentReferences'
import { ProductQueries } from '../ProductQueries'
import { ProductReadViews } from '../ProductReadViews'
import { ProductSyncPublisher } from '../ProductSyncPublisher'
import { projectCommandReceipt } from '../projectCommandReceipt'

const directories: string[] = []
const databases = new Set<DatabaseSync>()
afterEach(() => {
  for (const database of databases) database.close()
  databases.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-product-persistence-'))
  directories.push(directory)
  const path = join(directory, 'buddy.sqlite3')
  const database = openBuddyMigrationCandidate({ databasePath: path })
  databases.add(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  return { path, database }
}
const quoted: BuddyUserContentV1 = {
  ...createBuddyUserContent('你好😀'),
  resourceQuotes: [{ id: 'quote-1', text: '正文', textOffset: 4, source: { kind: 'artifact', title: '报告', artifactId: 'artifact', conversationId: 'conversation', runId: 'run', path: '/fixture/private/report.md', format: 'markdown', updatedAt: '2026-01-01T00:00:00.000Z' } }],
}

function createDraftCommands(db: DatabaseSync, instance: string) {
  const admission = new CommandAdmissionService({ database: db, principal: createLocalCommandPrincipal(db), sourceInstanceId: instance })
  const drafts = new ComposerDraftService(createComposerDraftRepository(db), async () => {})
  const commands = new ComposerDraftCommandService({ database: db, actorId: 'desktop-local', admission, drafts, prepareAttachments: async () => {
    throw new Error('Unexpected attachment copy')
  }, releaseResources: async () => {}, onCleanupError: (error) => {
    throw error
  } })
  const refs = new ProductContentReferences(db, 'desktop-local')
  const handlers = createProductCommandHandlers({ commands: { admission, drafts: commands } as never, assertOwner: () => {}, allowedActions: new Set(), resolveQuote: id => refs.resolve(id) })
  return { handlers, commands, admission }
}

describe('product persistence projections', () => {
  it('projects bounded task-wide previews and result targets without private child or reasoning content', () => {
    const { database } = fixture()
    const conversations = createConversationRepository(database)
    seedSqliteRun(database, 'summary-root')
    seedSqliteRun(database, 'summary-private')
    seedSqliteRun(database, 'summary-compaction')
    seedSqliteRun(database, 'summary-other')
    database.prepare(`UPDATE runs SET status = 'completed', completed_at = '2026-10-01T00:00:00.000Z' WHERE id = 'summary-root'`).run()
    database.prepare(`UPDATE runs SET execution_kind = 'npc_child', status = 'failed' WHERE id = 'summary-private'`).run()
    database.prepare(`UPDATE runs SET purpose = 'conversation.compaction', status = 'completed' WHERE id = 'summary-compaction'`).run()
    const prefix = '中'.repeat(239)
    const visible = conversations.createMessage({ id: 'summary-visible', conversationId: 'task-1', branchId: 'branch-task-1', runId: 'summary-root', role: 'assistant', content: { text: `${prefix}😀继续`, truncated: false }, createdAt: '2026-10-01T00:00:00.000Z' })
    conversations.createBranch({ id: 'summary-other-branch', conversationId: 'task-1', parentBranchId: 'branch-task-1', forkedFromMessageId: visible.id, activate: false, createdAt: '2026-10-02T00:00:00.000Z' })
    database.prepare(`UPDATE runs SET branch_id = 'summary-other-branch', status = 'failed', completed_at = '2026-10-03T00:00:00.000Z' WHERE id = 'summary-other'`).run()
    conversations.createMessage({ id: 'summary-other-message', conversationId: 'task-1', branchId: 'summary-other-branch', runId: 'summary-other', role: 'assistant', content: '另一分支正文', createdAt: '2026-10-03T00:00:00.000Z' })
    const insert = database.prepare('INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at) VALUES (?, \'task-1\', \'branch-task-1\', ?, ?, ?, \'2026-10-04T00:00:00.000Z\')')
    insert.run('private-summary', 'summary-private', 'assistant', JSON.stringify({ text: 'private child result' }))
    insert.run('reasoning-summary', 'summary-root', 'assistant', JSON.stringify({ text: 'private reasoning', kind: 'reasoning' }))
    insert.run('tool-summary', 'summary-root', 'tool', JSON.stringify({ text: 'tool output' }))
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const before = database.prepare('SELECT total_changes() AS value').get()!.value
    expect(queries.task('task-1', true)).toMatchObject({ unread: true, previewText: '另一分支正文', previewBranchId: 'summary-other-branch', resultBranchId: 'summary-other-branch', resultRunId: 'summary-other', lastRunStatus: 'failed' })
    expect(database.prepare('SELECT total_changes() AS value').get()!.value).toBe(before)
    for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled']) {
      database.prepare('UPDATE runs SET status = ?, started_at = \'2026-10-05T00:00:00.000Z\', completed_at = CASE WHEN ? IN (\'queued\', \'running\') THEN NULL ELSE \'2026-10-05T00:00:00.000Z\' END WHERE id = \'summary-root\'').run(status, status)
      expect(queries.task('task-1', true)).toMatchObject({ lastRunStatus: status })
    }
    database.prepare(`UPDATE conversations SET active_branch_id = 'summary-other-branch' WHERE id = 'task-1'`).run()
    expect(queries.task('task-1', true)).toMatchObject({ previewText: '另一分支正文', lastRunStatus: 'cancelled', resultBranchId: 'summary-other-branch', resultRunId: 'summary-other' })
    database.prepare(`UPDATE conversations SET active_branch_id = 'branch-task-1' WHERE id = 'task-1'`).run()
    expect(queries.task('task-1', true)).toMatchObject({ previewText: '另一分支正文', previewBranchId: 'summary-other-branch', lastRunStatus: 'cancelled' })
    expect(conversations.findById('task-1')?.activeBranchId).toBe('branch-task-1')
    database.prepare('DELETE FROM messages WHERE id = ?').run('summary-other-message')
    expect(queries.task('task-1', true)).toMatchObject({ previewText: prefix, previewBranchId: 'branch-task-1' })
    conversations.markDeleted('task-1', '2026-10-05T00:00:00.000Z')
    expect(queries.task('task-1', true)).toBeNull()
    expect(queries.read('conversations.list', { limit: 100, cursor: null })).toEqual({ items: [], nextCursor: null })
  })

  it('isolates query revisions from unrelated writes and rollbacks while observing other connections', () => {
    const { database, path } = fixture()
    const conversations = createConversationRepository(database)
    for (const id of ['first', 'second'])
      conversations.create({ id, branchId: `branch-${id}`, title: id, spaceId: null, createdAt: '2026-01-01T00:00:00.000Z', approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const read = (cursor: string | null) => PRODUCT_QUERY_METHODS['conversations.list'].output.parse(queries.read('conversations.list', { limit: 1, cursor })) as { items: unknown[], nextCursor: string | null }
    const first = read(null)
    expect(first.nextCursor).toEqual(expect.any(String))
    const writer = openBuddyMigrationCandidate({ databasePath: path })
    databases.add(writer)
    writer.prepare('UPDATE private_network_state SET last_observed_ms = last_observed_ms + 1').run()
    expect(() => withTransaction(writer, () => {
      writer.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('rolled back', 'second')
      throw new Error('ROLLBACK_FIXTURE')
    })).toThrow('ROLLBACK_FIXTURE')
    expect(read(first.nextCursor)).toMatchObject({ items: [{ id: 'second', title: 'second' }] })
    writer.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('changed', 'second')
    expect(() => read(first.nextCursor)).toThrow('CURSOR_EXPIRED')
  })

  it('publishes committed unread and completed-preview changes without streaming every token into the task index', () => {
    const { database } = fixture()
    seedSqliteRun(database, 'index-root')
    const errors: unknown[] = []
    const writer = new SqliteRunEventWriter(database, error => errors.push(error))
    const repository = createTaskMarkRepository(database)
    const marks = new TaskMarkService(repository, error => errors.push(error), database)
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const idle = { onDidCommit: () => ({ dispose() {} }) }
    const sync = createProductSynchronization({ database, queries, drafts: idle, metadata: idle, lifecycle: idle, marks, events: writer })
    const frames: any[] = []
    const disconnect = sync.publisher.connect('phone-index', { send: (frame) => {
      frames.push(JSON.parse(frame))
      return true
    }, close() {} })
    try {
      const subscription = sync.publisher.subscribe('phone-index', { subscriptionId: 'index', topic: 'taskIndex' })
      subscription.activate()
      sync.publisher.ack('phone-index', { subscriptionId: 'index', ...subscription.snapshot.cursor })
      expect(subscription.snapshot).toMatchObject({ items: [{ unread: false, lastRunStatus: 'queued' }] })
      writer.append({ runId: 'index-root', type: 'message.started', payload: { messageId: 'index-reply', role: 'assistant' } })
      writer.append({ runId: 'index-root', type: 'message.delta', payload: { messageId: 'index-reply', delta: '完成的公开回复😀' } })
      expect(frames).toEqual([])
      writer.append({ runId: 'index-root', type: 'message.completed', payload: { messageId: 'index-reply', role: 'assistant', content: { text: '完成的公开回复😀' }, stopReason: 'completed' } })
      expect(frames.at(-1)?.params.changes).toMatchObject([{ kind: 'upsert', value: { previewText: '完成的公开回复😀', lastRunStatus: 'queued' } }])
      writer.append({ runId: 'index-root', type: 'run.completed', payload: {} })
      expect(frames.at(-1)?.params.changes).toMatchObject([{ kind: 'upsert', value: { unread: true, lastRunStatus: 'completed' } }])
      const state = repository.getState('task-1')
      marks.setRead({ conversationId: 'task-1', read: true, resultRunId: state.resultRunId, readRevision: state.readRevision })
      expect(frames.at(-1)?.params.changes).toMatchObject([{ kind: 'upsert', value: { unread: false, lastRunStatus: 'completed' } }])
      expect(errors).toEqual([])
    }
    finally {
      disconnect()
      sync.dispose()
      writer.dispose()
      marks.dispose()
    }
  })

  it('exports public tool detail from the matching run without leaking raw event fields', () => {
    const { database } = fixture()
    seedSqliteRun(database, 'tool-root')
    const conversations = createConversationRepository(database)
    const message = conversations.createMessage({ id: 'tool-message', conversationId: 'task-1', branchId: 'branch-task-1', runId: 'tool-root', role: 'tool', content: { toolName: 'bash', toolCallId: 'call-one', isError: true }, createdAt: '2026-01-01T00:00:00.000Z' })
    const views = new ProductReadViews(database, 'desktop-local', new ProductContentReferences(database, 'desktop-local'))
    const payload = { toolCallId: 'call-one', toolName: 'bash', secret: 'raw-secret-must-not-leak', reasoning: 'private-reasoning', presentation: { card: 'terminal', command: 'printf hello', cwd: '.', exitCode: 1, signal: null, description: '检查工作目录', output: '可读取的结果😀', truncated: false } }
    database.prepare(`INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, 1, 'tool.completed', ?, '2026-01-01T00:00:00.000Z')`).run('tool-root', JSON.stringify(payload))
    expect(views.message(message)).toMatchObject({ tool: { name: 'bash', isError: true }, body: { kind: 'resource', resourceId: 'message:tool-message', previewText: '检查工作目录' } })
    const document = views.document('message:tool-message')!
    expect(document.bytes.toString()).toContain('printf hello')
    expect(document.bytes.toString()).toContain('可读取的结果😀')
    expect(document.bytes.toString()).toContain('执行失败')
    expect(document.bytes.toString()).not.toContain('raw-secret')
    expect(document.bytes.toString()).not.toContain('private-reasoning')
    expect(views.resource('message:tool-message')).toMatchObject({ availability: 'ready', sizeBytes: String(document.bytes.byteLength), revision: document.revision })
    seedSqliteRun(database, 'private-tool')
    database.prepare('UPDATE runs SET execution_kind = \'npc_child\' WHERE id = ?').run('private-tool')
    database.prepare(`INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at) VALUES ('private-tool-message','task-1','branch-task-1','private-tool','tool',?, '2026-01-01T00:00:00.000Z')`).run(JSON.stringify({ toolName: 'bash', toolCallId: 'call-one', isError: false }))
    expect(views.document('message:private-tool-message')).toBeNull()
    database.prepare('UPDATE conversations SET deleted_at = \'2026-01-02T00:00:00.000Z\' WHERE id = \'task-1\'').run()
    expect(views.document('message:tool-message')).toBeNull()
  })

  it('pages desktop transcript payloads while excluding private runs and raw credentials', () => {
    const { database } = fixture()
    seedSqliteRun(database, 'transcript-root')
    seedSqliteRun(database, 'transcript-private')
    database.prepare('UPDATE runs SET execution_kind = \'npc_child\' WHERE id = \'transcript-private\'').run()
    const insert = database.prepare('INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, \'2026-01-01T00:00:00.000Z\')')
    insert.run('transcript-root', 1, 'message.block.completed', JSON.stringify({ messageId: 'reason', kind: 'reasoning', contentIndex: 0, content: 'Checking file layout', rawProviderResponse: 'never-expose' }))
    insert.run('transcript-root', 2, 'tool.completed', JSON.stringify({ toolCallId: 'shell', toolName: 'bash', isError: true, secret: 'never-expose', presentation: { card: 'terminal', command: 'uname -s', cwd: '.', exitCode: 1, signal: null, description: '环境检查', output: 'Authorization: Bearer fixture-private-token', truncated: false } }))
    insert.run('transcript-root', 3, 'context.compaction.completed', JSON.stringify({ tokensBefore: 257111, estimatedTokensAfter: 45832 }))
    insert.run('transcript-private', 1, 'message.block.completed', JSON.stringify({ messageId: 'private', kind: 'reasoning', contentIndex: 0, content: 'private child reasoning' }))
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const input = { runId: 'transcript-root', afterSequence: '0', throughSequence: '3', limit: 2, cursor: null }
    const read = (params: Record<string, unknown>) => productPageSchema(publicRunEventSchema).parse(queries.read('runs.listTranscriptEvents', params))
    const page = read(input)
    expect(page.items).toMatchObject([{ sequence: 1, payload: { kind: 'reasoning', content: 'Checking file layout' } }, { sequence: 2, payload: { toolCallId: 'shell', isError: true, presentation: { card: 'terminal', command: 'uname -s' } } }])
    expect(JSON.stringify(page)).not.toMatch(/never-expose|fixture-private-token/)
    expect(page.nextCursor).not.toBeNull()
    insert.run('transcript-root', 4, 'run.completed', '{}')
    expect(read({ ...input, cursor: page.nextCursor }).items).toMatchObject([{ sequence: 3, payload: { tokensBefore: 257111, estimatedTokensAfter: 45832 } }])
    expect(read({ ...input, afterSequence: '2' }).items.map(event => event.sequence)).toEqual([3])
    expect(read({ ...input, runId: 'transcript-private' })).toEqual({ items: [], nextCursor: null })
    database.prepare('UPDATE conversations SET deleted_at = \'2026-01-02T00:00:00.000Z\' WHERE id = \'task-1\'').run()
    expect(read(input)).toEqual({ items: [], nextCursor: null })
  })

  it('reports execution resources separately from terminal run status and hides deleted tasks', async () => {
    const { database } = fixture()
    seedSqliteRun(database, 'run-execution')
    database.prepare('UPDATE runs SET status = \'cancelled\' WHERE id = ?').run('run-execution')
    const query = new ProductQueries(database, 'desktop-local', 'instance').handlers()['runs.getExecutionState']!
    const read = async () => PRODUCT_QUERY_METHODS['runs.getExecutionState'].output.parse(await query.handle({ runId: 'run-execution' }, {} as never, { supportedContentKinds: [], supportedReviewKinds: [] }))
    for (const [phase, cleanup, resources] of [['closing', 'pending', 'occupied'], ['closed', 'pending', 'occupied'], ['closed', 'degraded', 'unknown'], ['closed', 'clean', 'released']]) {
      database.prepare('UPDATE execution_state SET phase = ?, cleanup_state = ?, cancel_requested_at = ? WHERE run_id = ?').run(phase!, cleanup!, '2026-11-08T00:00:00.000Z', 'run-execution')
      expect(await read()).toEqual({ runId: 'run-execution', generation: '0', phase, cancelRequested: true, resources })
    }
    seedSqliteRun(database, 'child-execution')
    database.prepare('UPDATE runs SET parent_run_id = ?, root_run_id = ? WHERE id = ?').run('run-execution', 'run-execution', 'child-execution')
    expect(await read()).toMatchObject({ phase: 'closed', resources: 'occupied' })
    database.prepare('UPDATE execution_state SET phase = \'closed\', cleanup_state = \'degraded\' WHERE run_id = ?').run('child-execution')
    expect(await read()).toMatchObject({ phase: 'closed', resources: 'unknown' })
    database.prepare('UPDATE execution_state SET cleanup_state = \'clean\' WHERE run_id = ?').run('child-execution')
    expect(await read()).toMatchObject({ phase: 'closed', resources: 'occupied' })
    database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run('child-execution')
    expect(await read()).toMatchObject({ phase: 'closed', resources: 'released' })
    database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run('2026-11-08T00:01:00.000Z', 'task-1')
    expect(await read()).toBeNull()
  })

  it('restores the exact reference after reopening and rejects mutation or cross-owner adoption', () => {
    const { database, path } = fixture()
    const references = new ProductContentReferences(database, 'desktop-local')
    const portable = references.project(quoted)
    expect(JSON.stringify(portable)).not.toContain('/fixture/private')
    const id = portable.resourceQuotes![0]!.resourceId
    expect(references.project(quoted)).toEqual(portable)
    expect(() => database.prepare('UPDATE product_content_references SET quote_json = ? WHERE id = ?').run('{}', id)).toThrow('CONTENT_REFERENCE_IMMUTABLE')
    expect(() => database.prepare('DELETE FROM product_content_references WHERE id = ?').run(id)).toThrow('CONTENT_REFERENCE_IMMUTABLE')
    database.close()
    databases.delete(database)
    const reopened = openBuddyMigrationCandidate({ databasePath: path })
    databases.add(reopened)
    const restored = new ProductContentReferences(reopened, 'desktop-local')
    expect(restoreProductContent(portable, id => restored.resolve(id))).toEqual(quoted)
    expect(() => new ProductContentReferences(reopened, 'other-owner').resolve(id)).toThrow('RESOURCE_UNAVAILABLE')
  })

  it.each([1, 2])('replays a version %s portable command after reopening before checking editor capabilities', async (version) => {
    const { database, path } = fixture()
    const references = new ProductContentReferences(database, 'desktop-local')
    const portable = references.project(quoted)
    const { handlers, commands } = createDraftCommands(database, 'first-instance')
    const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
    const input = { dataGeneration, commandId: 'open-original', expectedServiceInstanceId: 'first-instance', intent: { draftId: 'original-draft', scope: { kind: 'global' }, initialContent: portable, initialModelSelection: null, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, expectedSlotRevision: '0' } }
    const first = version === 1
      ? { receipt: projectCommandReceipt((await commands.execute('composerDrafts.open', { ...input, intent: { ...input.intent, expectedSlotRevision: 0, initialContent: quoted } })).receipt) }
      : await handlers['composerDrafts.open']!.handle(input, {} as never, { supportedContentKinds: ['buddy-user-content-v1'], supportedReviewKinds: [] })
    expect(database.prepare('SELECT fingerprint_version AS version FROM command_receipts').get()!.version).toBe(version)
    database.close()
    databases.delete(database)
    const reopened = openBuddyMigrationCandidate({ databasePath: path })
    databases.add(reopened)
    const second = await createDraftCommands(reopened, 'second-instance').handlers['composerDrafts.open']!.handle(input, {} as never, { supportedContentKinds: [], supportedReviewKinds: [] })
    expect(second).toEqual(first)
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()!.count).toBe(1)
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM composer_drafts').get()!.count).toBe(1)
  })

  it.each(['accepted', 'rejected'])('replays a %s save after task purge and restart without restoring private quotes', async (decision) => {
    const { database, path } = fixture()
    const now = '2026-11-01T00:00:00.000Z'
    const executionConfig = { approvalPolicy: 'policy', executionProfile: 'workspace_write' } as const
    createConversationRepository(database).create({ id: 'task', branchId: 'branch-task', spaceId: null, title: 'task', createdAt: now, ...executionConfig })
    const drafts = createComposerDraftRepository(database)
    drafts.open({ draftId: 'draft', scope: { kind: 'conversation_branch', conversationId: 'task', branchId: 'branch-task' }, initialContent: createBuddyUserContent(), initialExecutionConfig: executionConfig, initialModelSelection: null, now })
    const references = new ProductContentReferences(database, 'desktop-local')
    const content = references.project(quoted, { kind: 'conversation', id: 'task' })
    const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
    const input = { dataGeneration, commandId: 'save-original', expectedServiceInstanceId: 'first-instance', intent: { draftId: 'draft', expectedRevision: decision === 'accepted' ? '0' : '999', content, modelSelection: null, executionConfig } }
    const client = { supportedContentKinds: ['buddy-user-content-v1'], supportedReviewKinds: [] }
    const first = await createDraftCommands(database, 'first-instance').handlers['composerDrafts.save']!.handle(input, {} as never, client)
    expect(first).toMatchObject({ receipt: { decision } })
    createConversationDeletionRepository(database).commit('task', now)
    await new ConversationPurgeService({ database, home: join(path, '..'), storageAuthority: 'sqlite' }).purge('task')
    expect(() => references.resolve(content.resourceQuotes![0]!.resourceId)).toThrow('RESOURCE_UNAVAILABLE')
    database.close()
    databases.delete(database)
    const reopened = openBuddyMigrationCandidate({ databasePath: path })
    databases.add(reopened)
    const { handlers } = createDraftCommands(reopened, 'second-instance')
    expect(await handlers['composerDrafts.save']!.handle(input, {} as never, client)).toEqual(first)
    expect(await handlers['commands.get']!.handle({ dataGeneration, commandId: input.commandId }, {} as never, client)).toEqual({ lookup: 'decided', ...(first as object) })
    for (const intent of [
      { ...input.intent, expectedRevision: '1' },
      { ...input.intent, draftId: 'another-draft' },
      { ...input.intent, content: { ...content, body: createBuddyUserContent('changed').body } },
      { ...input.intent, content: { ...content, resourceQuotes: content.resourceQuotes!.map(quote => ({ ...quote, resourceId: 'another-resource' })) } },
    ]) {
      await expect(handlers['composerDrafts.save']!.handle({ ...input, intent }, {} as never, client)).rejects.toMatchObject({ code: 'COMMAND_ID_REUSED' })
    }
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()!.count).toBe(1)
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM product_content_references').get()!.count).toBe(0)
  })

  it('continues one frozen SQLite snapshot across pages while later commits wait behind its barrier', () => {
    const { database } = fixture()
    const drafts = createComposerDraftRepository(database)
    for (let index = 0; index < 101; index++) {
      drafts.open({ draftId: `draft-${index}`, scope: { kind: 'task', draftId: `draft-${index}`, spaceId: null }, initialContent: createBuddyUserContent('before'), initialModelSelection: null, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, now: '2026-01-01T00:00:00.000Z' })
    }
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const publisher = new ProductSyncPublisher()
    const frames: any[] = []
    const disconnect = publisher.connect('connection', { send: (frame) => {
      frames.push(JSON.parse(frame))
      return true
    }, close: () => {} })
    publisher.register('draftIndex', { item: productDraftSchema, change: z.object({ draftId: z.string(), revision: z.string() }).strict(), readSnapshot: () => {
      throw new Error('Frozen reader required')
    }, openSnapshot: () => {
      const reader = queries.openSnapshot('draftIndex')
      return { close: reader.close, read: (cursor) => {
        const page = reader.read(cursor)
        return { ...page, items: page.items.map(item => productDraftSchema.parse(item)) }
      } }
    } })
    const first = publisher.subscribe('connection', { subscriptionId: 'drafts', topic: 'draftIndex' })
    first.activate()
    expect(first.snapshot).toMatchObject({ complete: false })
    expect(() => publisher.ack('connection', { subscriptionId: 'drafts', ...first.snapshot.cursor })).toThrow('SYNC_INVALID')
    const draft = drafts.findById('draft-100')!
    drafts.save({ ...draft, content: createBuddyUserContent('after'), expectedRevision: draft.revision, now: '2026-01-02T00:00:00.000Z' })
    publisher.publishCommitted('draftIndex', () => [{ draftId: 'draft-100', revision: '1' }])
    expect(frames).toHaveLength(0)
    if (first.snapshot.mode !== 'snapshot' || !first.snapshot.nextCursor)
      throw new Error('Expected a continuation cursor')
    const last = publisher.snapshotPage('connection', { subscriptionId: 'drafts', cursor: first.snapshot.nextCursor })
    expect(last.snapshot).toMatchObject({ complete: true, cursor: first.snapshot.cursor, items: [{ draftId: 'draft-100', revision: '0' }] })
    expect(publisher.snapshotPage('connection', { subscriptionId: 'drafts', cursor: first.snapshot.nextCursor }).snapshot).toEqual(last.snapshot)
    last.activate()
    expect(frames).toHaveLength(1)
    expect(frames[0]?.params).toMatchObject({ fromSeq: '0', toSeq: '1', changes: [{ draftId: 'draft-100', revision: '1' }] })
    publisher.ack('connection', { subscriptionId: 'drafts', syncEpoch: first.snapshot.cursor.syncEpoch, seq: '1' })
    disconnect()
    expect(database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
  })

  it('projects public history and status events without exposing private child text or native handles', () => {
    const { database } = fixture()
    seedSqliteRun(database, 'root')
    seedSqliteRun(database, 'private')
    database.prepare('UPDATE runs SET execution_kind = \'npc_child\' WHERE id = ?').run('private')
    database.prepare(`INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at) VALUES ('private-output','task-1','branch-task-1','private','assistant','{"text":"private reasoning"}','2026-01-01T00:00:00.000Z')`).run()
    database.prepare(`INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, 1, 'message.delta', ?, '2026-01-01T00:00:00.000Z')`).run('private', JSON.stringify({ messageId: 'private-output', delta: 'private reasoning', secret: 'must-not-leak' }))
    database.prepare(`INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, 1, 'message.delta', ?, '2026-01-01T00:00:00.000Z')`).run('root', JSON.stringify({ messageId: 'public-output', delta: '你好😀', nativePath: '/fixture/private/key' }))
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const history = PRODUCT_QUERY_METHODS['conversations.listMessages'].output.parse(queries.read('conversations.listMessages', { conversationId: 'task-1', branchId: 'branch-task-1', limit: 100, cursor: null }))
    expect(JSON.stringify(history)).not.toContain('private reasoning')
    const privateEvents = PRODUCT_QUERY_METHODS['runs.listEvents'].output.parse(queries.read('runs.listEvents', { runId: 'private', limit: 100, cursor: null, throughSequence: '1' }))
    expect(privateEvents).toEqual({ items: [], nextCursor: null })
    expect(JSON.stringify(privateEvents)).not.toMatch(/private reasoning|must-not-leak|private-output/)
    const publicEvents = PRODUCT_QUERY_METHODS['runs.listEvents'].output.parse(queries.read('runs.listEvents', { runId: 'root', limit: 100, cursor: null }))
    expect(publicEvents).toMatchObject({ items: [{ type: 'message.delta', detail: { kind: 'text_delta', delta: '你好😀' } }] })
    expect(JSON.stringify(publicEvents)).not.toContain('/fixture/private')
  })

  it('keeps a dynamic conversation snapshot pinned across entity phases and message pages', () => {
    const { database } = fixture()
    seedSqliteRun(database, 'root')
    const conversations = createConversationRepository(database)
    for (let index = 0; index < 105; index++) conversations.createMessage({ id: `message-${String(index).padStart(3, '0')}`, conversationId: 'task-1', branchId: 'branch-task-1', runId: 'root', role: 'assistant', content: { text: `before-${index}` }, createdAt: '2026-10-01T00:00:00.000Z' })
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const reader = queries.openSnapshot('conversation:task-1:branch-task-1')
    try {
      let page = reader.read(null)
      expect(page.items).toMatchObject([{ entity: 'task', value: { id: 'task-1' } }])
      database.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run('{"text":"after"}', 'message-001')
      const items = [...page.items]
      while (page.nextCursor) {
        page = reader.read(page.nextCursor)
        items.push(...page.items)
      }
      expect(items.filter(item => (item as any).entity === 'message')).toHaveLength(106)
      expect(items.find(item => (item as any).value.id === 'message-001')).toMatchObject({ value: { body: { text: 'before-1' } } })
      expect(items.find(item => (item as any).entity === 'run')).toMatchObject({ value: { lastEventSequence: '0', generation: '0' } })
    }
    finally { reader.close() }
    expect(database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
  })
  it('restores an unfinished public reply from the same frozen snapshot without exposing reasoning or private runs', () => {
    const { database } = fixture()
    seedSqliteRun(database, 'stream-root')
    seedSqliteRun(database, 'stream-private')
    database.prepare('UPDATE runs SET execution_kind = \'npc_child\', root_run_id = \'stream-root\', parent_run_id = \'stream-root\' WHERE id = \'stream-private\'').run()
    const writer = new SqliteRunEventWriter(database)
    const append = (runId: string, type: string, payload: unknown) => writer.append({ runId, type, payload })
    append('stream-root', 'message.started', { messageId: 'live', role: 'assistant' })
    append('stream-root', 'message.block.delta', { messageId: 'live', kind: 'reasoning', contentIndex: 0, delta: 'private reasoning' })
    append('stream-root', 'message.delta', { messageId: 'live', delta: '开头😀' })
    append('stream-private', 'message.started', { messageId: 'private', role: 'assistant' })
    append('stream-private', 'message.delta', { messageId: 'private', delta: 'private subagent' })
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const reader = queries.openSnapshot('conversation:task-1:branch-task-1')
    try {
      let page = reader.read(null)
      append('stream-root', 'message.delta', { messageId: 'live', delta: '后来内容' })
      const items = [...page.items] as any[]
      while (page.nextCursor) {
        page = reader.read(page.nextCursor)
        items.push(...page.items)
      }
      expect(items.find(item => item.value.id === 'live')).toMatchObject({ entity: 'message', value: { role: 'assistant', runId: 'stream-root', body: { kind: 'text', text: '开头😀', interrupted: false, truncated: false } } })
      expect(JSON.stringify(items)).not.toContain('private reasoning')
      expect(JSON.stringify(items)).not.toContain('private subagent')
    }
    finally { reader.close() }
    expect(queries.streaming.page('task-1', 'branch-task-1', null).items[0]?.body).toMatchObject({ text: '开头😀后来内容' })
    expect(queries.views.event('stream-root', '2')?.detail.kind).toBe('status')
    append('stream-root', 'message.completed', { messageId: 'live', role: 'assistant', content: { text: '最终正文' }, stopReason: 'completed' })
    expect(queries.streaming.page('task-1', 'branch-task-1', null).items).toEqual([])
    writer.dispose()
  })

  it('publishes a message before its live deltas and replaces it with one final message', () => {
    const { database } = fixture()
    seedSqliteRun(database, 'live-root')
    const writer = new SqliteRunEventWriter(database)
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const idle = { onDidCommit: () => ({ dispose() {} }) }
    const sync = createProductSynchronization({ database, queries, drafts: idle, metadata: idle, lifecycle: idle, events: writer })
    const topic = 'conversation:task-1:branch-task-1'
    sync.authorizeTopic(topic)
    const frames: any[] = []
    const disconnect = sync.publisher.connect('phone', { send: (frame) => {
      frames.push(JSON.parse(frame))
      return true
    }, close() {} })
    try {
      let result = sync.publisher.subscribe('phone', { subscriptionId: 'live', topic })
      result.activate()
      while (result.snapshot.mode === 'snapshot' && result.snapshot.nextCursor) {
        result = sync.publisher.snapshotPage('phone', { subscriptionId: 'live', cursor: result.snapshot.nextCursor })
        result.activate()
      }
      sync.publisher.ack('phone', { subscriptionId: 'live', ...result.snapshot.cursor })
      writer.append({ runId: 'live-root', type: 'message.started', payload: { messageId: 'reply', role: 'assistant' } })
      writer.append({ runId: 'live-root', type: 'message.delta', payload: { messageId: 'reply', delta: '现在可以看见😀' } })
      writer.append({ runId: 'live-root', type: 'message.block.delta', payload: { messageId: 'reply', kind: 'reasoning', contentIndex: 0, delta: 'private reasoning' } })
      writer.append({ runId: 'live-root', type: 'message.completed', payload: { messageId: 'reply', role: 'assistant', content: { text: '现在可以看见😀' }, stopReason: 'completed' } })
      const changes = frames.flatMap(frame => frame.params.changes ?? [])
      const messages = changes.filter(change => change.kind === 'upsert' && change.item.entity === 'message')
      expect(messages.map(change => change.item.value.body.text)).toEqual(['', '现在可以看见😀'])
      expect(messages.map(change => change.item.value.id)).toEqual(['reply', 'reply'])
      expect(changes.filter(change => change.event?.detail.kind === 'text_delta').map(change => change.event.detail.delta)).toEqual(['现在可以看见😀'])
      expect(JSON.stringify(frames)).not.toContain('private reasoning')
      expect(changes.indexOf(messages[0])).toBeLessThan(changes.findIndex(change => change.event?.detail.kind === 'text_delta'))
    }
    finally {
      disconnect()
      sync.dispose()
      writer.dispose()
    }
  })

  it('bounds unfinished text without cutting an emoji or losing pagination', () => {
    const { database } = fixture()
    seedSqliteRun(database, 'bounded-root')
    const writer = new SqliteRunEventWriter(database)
    const prefix = '中'.repeat(131071)
    writer.append({ runId: 'bounded-root', type: 'message.started', payload: { messageId: 'large', role: 'assistant' } })
    for (const delta of [prefix, '😀不能出现半个字符']) writer.append({ runId: 'bounded-root', type: 'message.delta', payload: { messageId: 'large', delta } })
    writer.append({ runId: 'bounded-root', type: 'message.started', payload: { messageId: 'large-next', role: 'assistant' } })
    writer.append({ runId: 'bounded-root', type: 'message.delta', payload: { messageId: 'large-next', delta: prefix } })
    const queries = new ProductQueries(database, 'desktop-local', 'instance')
    const page = queries.streaming.page('task-1', 'branch-task-1', null)
    expect(page.items[0]?.body).toEqual({ kind: 'text', text: prefix, interrupted: false, truncated: true })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
    const next = queries.streaming.page('task-1', 'branch-task-1', page.nextCursor)
    expect(next.items.map(item => item.id)).toEqual(['large-next'])
    expect(next.nextCursor).toBeNull()
    writer.dispose()
  })
})

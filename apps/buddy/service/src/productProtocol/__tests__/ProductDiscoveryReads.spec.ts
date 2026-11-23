import type { DatabaseSync } from 'node:sqlite'
import type { ProductSearchPage } from '../../../../shared/productProtocol/queries'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { PRODUCT_QUERY_METHODS, productBuddyPageSchema, productMemberPageSchema, productMessageWindowSchema, productSearchPageSchema } from '../../../../shared/productProtocol/queries'
import { PRODUCT_TOPIC_SCHEMAS } from '../../../../shared/productProtocol/topics'
import { productActivityStepsPageSchema } from '../../../../shared/productProtocol/turns'
import { SqliteRunEventWriter } from '../../events/SqliteRunEventWriter'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { ConversationCommandRepository } from '../../storage/ConversationCommandRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { createProductSynchronization } from '../createProductSynchronization'
import { ProductConnection } from '../ProductConnection'
import { ProductQueries } from '../ProductQueries'

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const now = '2026-11-01T00:00:00.000Z'
function fixture(file = false) {
  const directory = file ? mkdtempSync(join(tmpdir(), 'lexora-discovery-')) : null
  if (directory)
    directories.push(directory)
  const database = openBuddyMigrationCandidate({ databasePath: directory ? join(directory, 'buddy.sqlite3') : ':memory:' })
  databases.push(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  seedSqliteRun(database, 'root', { conversationId: 'task' })
  const queries = new ProductQueries(database, 'desktop-local', 'instance')
  const conversations = createConversationRepository(database)
  const read = (method: keyof typeof PRODUCT_QUERY_METHODS, input: unknown) => queries.read(method, PRODUCT_QUERY_METHODS[method].input.parse(input) as Record<string, unknown>)
  const message = (id: string, content: unknown, branchId = 'branch-task', runId: string | null = null) => conversations.createMessage({ id, conversationId: 'task', branchId, runId, role: 'assistant', content, createdAt: now })
  const search = (query: string, extra: Record<string, unknown> = {}): ProductSearchPage => productSearchPageSchema.parse(read('conversations.search', { query, ...extra }))
  return { database, queries, conversations, read, message, search }
}

describe('product discovery read contracts', () => {
  it('finds old full public text and opens its exact branch/message without activating it', () => {
    const f = fixture()
    f.message('early', { text: `${'old text '.repeat(100)}buried-needle` })
    f.message('later', 'latest preview')
    f.conversations.createBranch({ id: 'fork', conversationId: 'task', parentBranchId: 'branch-task', forkedFromMessageId: 'early', createdAt: now, activate: false })
    f.message('fork-hit', 'buried-needle in fork', 'fork')
    const hits = f.search('buried-needle')
    expect(hits).toMatchObject({ partial: false, nextCursor: null, skippedOversized: 0 })
    expect(hits.items).toMatchObject([{ kind: 'message', messageId: 'early', branchId: 'branch-task', snippet: expect.stringContaining('buried-needle') }, { kind: 'message', messageId: 'fork-hit', branchId: 'fork' }])
    const window = productMessageWindowSchema.parse(f.read('conversations.getMessageWindow', { conversationId: 'task', branchId: 'branch-task', messageId: 'early', limit: 2 }))
    expect(window.items.map(item => item.id)).toEqual(['input-root', 'early'])
    expect(window).toMatchObject({ anchorMessageId: 'early', hasLater: true })
    expect(f.conversations.findById('task')?.activeBranchId).toBe('branch-task')
    expect(() => f.read('conversations.getMessageWindow', { conversationId: 'task', branchId: 'fork', messageId: 'later' })).toThrow('OBJECT_DELETED')
    const fork = productMessageWindowSchema.parse(f.read('conversations.getMessageWindow', { conversationId: 'task', branchId: 'fork', messageId: 'fork-hit', limit: 2 }))
    expect(fork.items.map(item => item.id)).toEqual(['early', 'fork-hit'])
    expect(fork.nextCursor).not.toBeNull()
    const older = f.read('conversations.listMessages', { conversationId: 'task', branchId: 'fork', cursor: fork.nextCursor }) as { items: { id: string }[] }
    expect(older.items.map(item => item.id)).toEqual(['input-root'])
  })

  it('never discovers private child, reasoning, credential, local path or deleted content', () => {
    const f = fixture()
    seedSqliteRun(f.database, 'private', { conversationId: 'task' })
    f.database.prepare('UPDATE runs SET execution_kind = \'npc_child\' WHERE id = \'private\'').run()
    f.database.prepare('INSERT INTO messages (id,conversation_id,branch_id,run_id,role,content_json,created_at) VALUES (\'private-message\',\'task\',\'branch-task\',\'private\',\'assistant\',?,?)').run(JSON.stringify({ text: 'private-needle' }), now)
    f.message('reasoning', { text: 'reasoning-needle', kind: 'reasoning' })
    f.message('credentials', 'token=credential-needle /home/private/path-needle visible-word')
    f.message('rich-user', { userContent: createBuddyUserContent('rich-public-needle'), resourceSnapshots: [] })
    f.database.prepare('UPDATE messages SET role = \'user\' WHERE id = \'rich-user\'').run()
    for (const query of ['private-needle', 'reasoning-needle', 'credential-needle', 'path-needle']) expect(f.search(query).items).toEqual([])
    expect(f.search('rich-public-needle').items).toMatchObject([{ messageId: 'rich-user' }])
    expect(f.search('visible-word').items).toMatchObject([{ snippet: 'token=[redacted] [path] visible-word' }])
    expect(() => f.read('conversations.getMessageWindow', { conversationId: 'task', branchId: 'branch-task', messageId: 'private-message' })).toThrow('OBJECT_DELETED')
    f.database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = \'task\'').run(now)
    expect(f.search('visible-word').items).toEqual([])
    expect(() => f.read('conversations.getMessageWindow', { conversationId: 'task', branchId: 'branch-task', messageId: 'credentials' })).toThrow('OBJECT_DELETED')
  })

  it('makes candidate pagination and oversized omissions explicit and binds cursors to scope', () => {
    const f = fixture()
    f.message('oversized', 'omitted-needle'.repeat(30_000))
    f.message('small', 'final-needle')
    const first = f.search('final-needle', { limit: 1 })
    expect(first).toMatchObject({ items: [], partial: true, skippedOversized: 0 })
    expect(first.nextCursor).not.toBeNull()
    expect(() => f.search('different', { limit: 1, cursor: first.nextCursor })).toThrow('CURSOR_EXPIRED')
    expect(() => f.search('final-needle', { scope: 'archived', cursor: first.nextCursor })).toThrow('CURSOR_EXPIRED')
    let page = first
    const items = [...page.items]
    let skipped = 0
    for (let count = 0; page.nextCursor && count < 10; count++) {
      page = f.search('final-needle', { limit: 1, cursor: page.nextCursor })
      items.push(...page.items)
      skipped += page.skippedOversized
    }
    expect(items).toMatchObject([{ messageId: 'small' }])
    expect(skipped).toBe(1)
    expect(page.nextCursor).toBeNull()
    f.message('changed', 'change')
    expect(() => f.search('final-needle', { cursor: first.nextCursor })).toThrow('CURSOR_EXPIRED')
  })

  it('enforces archived search permission through the real wire handler', async () => {
    const f = fixture()
    f.message('archived', 'archive-needle')
    f.database.prepare('UPDATE conversations SET archived_at = ? WHERE id = \'task\'').run(now)
    for (const role of ['reader', 'owner'] as const) {
      const frames: Array<{ result?: unknown, error?: { code: string } }> = []
      const connection = new ProductConnection({ context: { serviceId: 'service', profileId: 'profile', dataGeneration: 'generation', serviceInstanceId: 'instance', connectionId: role, clientSessionId: 'session', deviceId: 'device', ownerPrincipalId: 'owner', credentialId: 'credential', grantGeneration: '1', role }, assertCurrent: () => {}, phase: () => 'ready', handlers: f.queries.handlers(), send: (frame) => {
        frames.push(JSON.parse(frame))
        return true
      }, close: () => {} })
      await connection.receive(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocol: { major: 1, minMinor: 1, maxMinor: 1 }, client: { kind: 'mobile', version: '1' }, supportedContentKinds: [], supportedReviewKinds: [] } }))
      await connection.receive(JSON.stringify({ jsonrpc: '2.0', id: 'search', method: 'conversations.search', params: { query: 'archive-needle', scope: 'archived' } }))
      if (role === 'reader')
        expect(frames.at(-1)?.error?.code).toBe('NOT_AUTHORIZED')
      else
        expect(frames.at(-1)?.result).toMatchObject({ items: [{ messageId: 'archived' }] })
      connection.close()
    }
    expect(f.search('archive-needle').items).toEqual([])
    expect(f.read('conversations.get', { conversationId: 'task' })).toMatchObject({ activeBranchId: 'branch-task' })
  })

  it('returns current actor identities and member CAS revisions without execution settings or NPCs', () => {
    const f = fixture()
    const buddies = createBuddyRepository(f.database)
    const first = buddies.create({ kind: 'actor', name: 'Same name', description: 'public description' })
    const second = buddies.create({ kind: 'actor', name: 'Same name' })
    buddies.create({ kind: 'npc', name: 'Private worker' })
    f.conversations.addMember({ id: 'task', buddyId: first.id, updatedAt: now })
    f.conversations.addMember({ id: 'task', buddyId: second.id, updatedAt: now })
    f.conversations.setBuddy({ id: 'task', buddyId: first.id, updatedAt: now })
    const before = f.database.prepare('SELECT buddy_id FROM runs WHERE id = \'root\'').get()
    buddies.update({ buddyId: second.id, expectedRevision: second.revision, enabled: false })
    const catalog = productBuddyPageSchema.parse(f.read('buddies.list', {}))
    expect(catalog.items.filter(item => item.name === 'Same name').map(item => item.id)).toEqual([first.id, second.id])
    expect(JSON.stringify(catalog)).not.toMatch(/Private worker|settings|instructions|avatar|provider/)
    const page = productMemberPageSchema.parse(f.read('conversations.listMembers', { conversationId: 'task' }))
    expect(page).toMatchObject({ buddyId: first.id, revision: String(new ConversationCommandRepository(f.database).conversationRevision('task')) })
    expect(page.items.find(item => item.actorId === second.id)?.profile).toMatchObject({ enabled: false, deleted: false })
    f.conversations.removeMember({ id: 'task', buddyId: second.id, updatedAt: now })
    const updated = productMemberPageSchema.parse(f.read('conversations.listMembers', { conversationId: 'task' }))
    expect(updated.items.some(item => item.actorId === second.id)).toBe(false)
    expect(updated.revision).not.toBe(page.revision)
    expect(f.database.prepare('SELECT buddy_id FROM runs WHERE id = \'root\'').get()).toEqual(before)
  })

  it('continues live public message and run updates after the bounded snapshot completes', () => {
    const f = fixture(true)
    const errors: unknown[] = []
    const writer = new SqliteRunEventWriter(f.database, error => errors.push(error))
    const idle = { onDidCommit: () => ({ dispose() {} }) }
    const sync = createProductSynchronization({ database: f.database, queries: f.queries, drafts: idle, metadata: idle, lifecycle: idle, events: writer })
    const frames: Array<{ method: string, params: { changes: unknown[] } }> = []
    const disconnect = sync.publisher.connect('window', { send: (frame) => {
      frames.push(JSON.parse(frame))
      return true
    }, close() {} })
    try {
      sync.authorizeTopic('conversationWindow:task:branch-task')
      let response = sync.publisher.subscribe('window', { subscriptionId: 'live', topic: 'conversationWindow:task:branch-task' })
      response.activate()
      while (response.snapshot.mode === 'snapshot' && response.snapshot.nextCursor) {
        response = sync.publisher.snapshotPage('window', { subscriptionId: 'live', cursor: response.snapshot.nextCursor })
        response.activate()
      }
      sync.publisher.ack('window', { subscriptionId: 'live', ...response.snapshot.cursor })
      writer.append({ runId: 'root', type: 'message.started', payload: { messageId: 'live-reply', role: 'assistant' } })
      writer.append({ runId: 'root', type: 'message.completed', payload: { messageId: 'live-reply', role: 'assistant', content: { text: 'new public reply' }, stopReason: 'completed' } })
      writer.append({ runId: 'root', type: 'run.completed', payload: {} })
      const changes = frames.filter(frame => frame.method === 'sync.delta').flatMap(frame => frame.params.changes).map(change => PRODUCT_TOPIC_SCHEMAS.conversationWindow.change.parse(change))
      expect(changes).toContainEqual(expect.objectContaining({ kind: 'upsert', item: expect.objectContaining({ entity: 'message', value: expect.objectContaining({ id: 'live-reply', body: expect.objectContaining({ text: 'new public reply' }) }) }) }))
      expect(changes).toContainEqual(expect.objectContaining({ kind: 'upsert', item: expect.objectContaining({ entity: 'run', value: expect.objectContaining({ id: 'root', status: 'completed' }) }) }))
      expect(errors).toEqual([])
    }
    finally {
      disconnect()
      sync.dispose()
      writer.dispose()
    }
  })

  it('keeps a running conversation readable without sending collapsed tool payloads on open or resume', () => {
    const f = fixture(true)
    const errors: unknown[] = []
    const writer = new SqliteRunEventWriter(f.database, error => errors.push(error))
    const idle = { onDidCommit: () => ({ dispose() {} }) }
    const sync = createProductSynchronization({ database: f.database, queries: f.queries, drafts: idle, metadata: idle, lifecycle: idle, events: writer })
    const topic = 'conversationTurns:task:branch-task'
    const scope = { conversationId: 'task', branchId: 'branch-task' }
    const log = `UNOPENED_LOG:${'x'.repeat(12_000)}`
    const frames: string[] = []
    const transport = { send: (frame: string) => {
      frames.push(frame)
      return true
    }, close() {} }
    const call = (index: number) => {
      const toolCallId = `call-${index}`
      const content = { toolCallId, toolName: 'bash', isError: index === 73 }
      writer.appendBatch([
        { runId: 'root', type: 'tool.started', payload: { toolCallId, toolName: 'bash', args: { command: `UNOPENED_COMMAND:${index}` } } },
        { runId: 'root', type: 'tool.completed', payload: { ...content, result: { content: [{ type: 'text', text: log }] } } },
        { runId: 'root', type: 'message.tool_result', payload: { role: 'tool', messageId: `result-${index}`, content } },
      ])
    }
    function openSnapshot() {
      const reader = f.queries.openSnapshot(topic)
      try {
        const page = reader.read(null)
        expect(page.nextCursor).toBeNull()
        return page.items.map(item => PRODUCT_TOPIC_SCHEMAS.conversationTurns.item.parse(item))
      }
      finally { reader.close() }
    }
    let disconnect: (() => void) | undefined
    try {
      call(1)
      call(2)
      const short = openSnapshot()
      for (let index = 3; index <= 200; index++) call(index)
      const large = openSnapshot()
      expect(large.filter(item => item.entity === 'activityGroup').map(item => item.value)).toMatchObject([{ toolCount: 200, failedCount: 1 }])
      expect(large.filter(item => item.entity === 'message').map(item => item.value.id)).toEqual(['input-root'])
      expect(JSON.stringify(large)).not.toMatch(/UNOPENED_|call-73|result-73/)
      expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(Buffer.byteLength(JSON.stringify(short)) + 256)
      const group = large.find(item => item.entity === 'activityGroup')!
      const steps = productActivityStepsPageSchema.parse(f.read('conversations.listActivitySteps', { ...scope, groupId: group.value.id, runId: 'root', limit: 100 }))
      expect(steps.items).toContainEqual(expect.objectContaining({ status: 'failed', messageId: 'result-73' }))
      expect(JSON.stringify(steps)).not.toMatch(/UNOPENED_/)

      sync.authorizeTopic(topic)
      disconnect = sync.publisher.connect('phone', transport)
      const start = sync.publisher.subscribe('phone', { subscriptionId: 'before', topic })
      start.activate()
      disconnect()
      writer.append({ runId: 'root', type: 'message.completed', payload: { role: 'assistant', messageId: 'explanation', stopReason: 'completed', content: { text: 'Step 73 failed; retrying packaging.' } } })
      call(201)
      createArtifactRepository(f.database).save({ id: 'apk', conversationId: 'task', currentPath: '/fixture/build.apk', directoryRoot: '/fixture', directoryGrantId: 'task', relativePath: 'build.apk', kind: 'file', name: 'build.apk', mimeType: 'application/vnd.android.package-archive', sizeBytes: 120, sourceArtifactId: null, createdAt: now, updatedAt: now })
      writer.append({ runId: 'root', type: 'output.produced', payload: { artifactIds: ['apk'], sourceToolCallId: 'call-201', sourceToolName: 'lexora_output_present' } })
      writer.append({ runId: 'root', type: 'message.completed', payload: { role: 'assistant', messageId: 'done', stopReason: 'completed', content: { text: 'The build has recovered.' } } })
      writer.append({ runId: 'root', type: 'run.completed', payload: {} })
      disconnect = sync.publisher.connect('phone', transport)
      const resume = sync.publisher.subscribe('phone', { subscriptionId: 'after', topic, base: start.snapshot.cursor })
      resume.activate()
      expect(resume.snapshot.mode).toBe('resume')
      expect(frames.join('\n')).toContain('The build has recovered.')
      expect(frames.join('\n')).toContain('output.produced')
      expect(frames.join('\n')).not.toMatch(/UNOPENED_|result-73|call-73/)
      const after = openSnapshot()
      expect(after.filter(item => item.entity === 'message').map(item => item.value.id)).toEqual(['input-root', 'explanation', 'done'])
      expect(after.filter(item => item.entity === 'activityGroup').map(item => item.value)).toMatchObject([{ afterMessageId: 'input-root', failedCount: 1, toolCount: 200 }, { afterMessageId: 'explanation', failedCount: 0, toolCount: 1 }])
      expect(f.read('runs.listOutputs', { runId: 'root', branchId: scope.branchId })).toMatchObject({ items: [{ resourceId: 'artifact:apk', name: 'build.apk' }] })
      expect(errors).toEqual([])
    }
    finally {
      disconnect?.()
      sync.dispose()
      writer.dispose()
    }
  })

  it('bounds the new live snapshot to recent history while retaining the old complete topic', () => {
    const f = fixture(true)
    for (let index = 0; index < 130; index++) f.message(`message-${String(index).padStart(3, '0')}`, `body ${index}`)
    const collect = (name: string) => {
      const reader = f.queries.openSnapshot(name)
      const items: unknown[] = []
      let cursor: string | null = null
      try {
        do {
          const page = reader.read(cursor)
          items.push(...page.items)
          cursor = page.nextCursor
        } while (cursor)
      }
      finally { reader.close() }
      return items
    }
    const recent = collect('conversationWindow:task:branch-task').map(item => PRODUCT_TOPIC_SCHEMAS.conversationWindow.item.parse(item))
    const messages = recent.filter(item => item.entity === 'message')
    expect(messages).toHaveLength(50)
    expect(messages[0]).toMatchObject({ value: { id: 'message-080' } })
    const metadata = recent.find(item => item.entity === 'historyWindow')
    expect(metadata).toMatchObject({ value: { hasMore: true, nextCursor: expect.any(String) } })
    if (metadata?.entity !== 'historyWindow')
      throw new Error('Missing history window')
    const older = f.read('conversations.listMessages', { conversationId: 'task', branchId: 'branch-task', cursor: metadata.value.nextCursor }) as { items: unknown[] }
    expect(older.items).toHaveLength(81)
    const old = collect('conversation:task:branch-task').map(item => PRODUCT_TOPIC_SCHEMAS.conversation.item.parse(item))
    expect(old.filter(item => item.entity === 'message')).toHaveLength(131)
  })
})

import type { BuddyResourceQuote } from '../../../shared/conversation/buddyUserContent'
import type { BuddyComposerDraft } from '../../../shared/conversation/composerDraft'
import type { ProductMethod } from '../../../shared/productProtocol/methods'
import type { ProductTopic } from '../../../shared/productProtocol/topics'
import type { ProductRequestHandler } from './ProductConnection'
import { createHash } from 'node:crypto'
import { hostname, platform } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { productErrorCodeSchema, ProductProtocolError } from '../../../shared/productProtocol/errors'
import { PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { PRODUCT_QUERY_METHODS, productRunSchema } from '../../../shared/productProtocol/queries'
import { decodeProductCursor, encodeProductCursor, encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { parseProductTopic } from '../../../shared/productProtocol/topics'
import { toPublicRun } from '../runs/publicRun'
import { ConversationCommandRepository } from '../storage/ConversationCommandRepository'
import { createConversationRepository } from '../storage/conversationRepository'
import { createRunInputRepository } from '../storage/runInputRepository'
import { createRunRepository } from '../storage/runRepository'
import { createTaskMarkRepository } from '../storage/taskMarkRepository'
import { assertCommittedRead, withTransaction } from '../storage/transaction'
import { ProductBuddyAvatars } from './ProductBuddyAvatars'
import { ProductContentReferences } from './ProductContentReferences'
import { ProductDraftReadModel } from './ProductDraftReadModel'
import { ProductPageReader } from './ProductPageReader'
import { productQueryRevision } from './ProductQueryRevisions'
import { ProductReadViews } from './ProductReadViews'
import { ProductStreamingMessages } from './ProductStreamingMessages'
import { ProductTaskReadModel } from './ProductTaskReadModel'

export class ProductQueries {
  readonly #database: DatabaseSync
  readonly #actorId: string
  readonly #instance: string
  readonly #references: ProductContentReferences
  readonly #hasReview: (approvalId: string, version: string) => boolean
  readonly views: ProductReadViews
  readonly streaming: ProductStreamingMessages
  readonly #tasks: ProductTaskReadModel
  readonly #pages: ProductPageReader
  readonly #drafts: ProductDraftReadModel

  constructor(database: DatabaseSync, actorId: string, serviceInstanceId: string, references?: ProductContentReferences, hasReview: (approvalId: string, version: string) => boolean = () => false) {
    this.#database = database
    this.#actorId = actorId
    this.#hasReview = hasReview
    this.#instance = serviceInstanceId
    this.#references = references ?? new ProductContentReferences(database, actorId)
    this.views = new ProductReadViews(database, actorId, this.#references, hasReview)
    this.streaming = new ProductStreamingMessages(database)
    this.#tasks = new ProductTaskReadModel(database, message => this.views.messagePreview(message))
    this.#pages = new ProductPageReader(database, serviceInstanceId)
    this.#drafts = new ProductDraftReadModel(database, actorId, this.#references, id => this.views.resource(id))
  }

  resolveQuote(resourceId: string): BuddyResourceQuote {
    return this.#references.resolve(resourceId)
  }

  draft(id: string) {
    return this.#drafts.get(id)
  }

  task(id: string, summary = false) {
    return summary ? this.#tasks.summaries([id]).get(id) ?? null : this.#tasks.get(id)
  }

  openSnapshot(name: string) {
    const topic = parseProductTopic(name)
    assertCommittedRead(this.#database)
    const file = this.#database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
    if (typeof file !== 'string' || !file)
      throw new ProductProtocolError('RESYNC_REQUIRED')
    const database = new DatabaseSync(file, { readOnly: true })
    let closed = false
    const close = () => {
      if (closed)
        return
      closed = true
      try {
        database.exec('ROLLBACK')
      }
      finally { database.close() }
    }
    try {
      database.exec('PRAGMA query_only = ON')
      database.exec('BEGIN')
      database.prepare('SELECT data_generation FROM storage_profile WHERE id = 1').get()
      const queries = new ProductQueries(database, this.#actorId, this.#instance, this.#references, this.#hasReview)
      return { close, read: (cursor: string | null) => {
        if (closed)
          throw new ProductProtocolError('CURSOR_EXPIRED')
        const page = queries.#topicPage(topic, cursor)
        return { ...page, complete: page.nextCursor === null }
      } }
    }
    catch (error) {
      close()
      throw error
    }
  }

  snapshot(name: string) {
    const topic = parseProductTopic(name)
    assertCommittedRead(this.#database)
    return withTransaction(this.#database, () => {
      const page = this.#topicPage(topic, null)
      return { ...page, complete: page.nextCursor === null }
    })
  }

  read(method: keyof typeof PRODUCT_QUERY_METHODS, input: Record<string, unknown>): unknown {
    assertCommittedRead(this.#database)
    return withTransaction(this.#database, () => this.#read(method, input))
  }

  assertTopic(topic: ProductTopic): void {
    if (topic.kind === 'draft' && !this.draft(topic.draftId))
      throw new ProductProtocolError('OBJECT_DELETED')
    if ((topic.kind === 'conversation' || topic.kind === 'questions') && (!this.task(topic.conversationId) || !this.#database.prepare('SELECT 1 FROM conversation_branches WHERE id = ? AND conversation_id = ?').get(topic.branchId, topic.conversationId)))
      throw new ProductProtocolError('OBJECT_DELETED')
  }

  #topicPage(topic: ProductTopic, cursor: string | null): { items: unknown[], nextCursor: string | null } {
    if (topic.kind === 'draft') {
      const draft = this.draft(topic.draftId)
      return { items: draft ? [draft] : [], nextCursor: null }
    }
    if (topic.kind === 'serviceState')
      return { items: [{ phase: 'ready' }], nextCursor: null }
    if (topic.kind === 'questions')
      return this.#read('questions.list', { conversationId: topic.conversationId, branchId: topic.branchId, limit: PRODUCT_LIMITS.pageItems, cursor }) as { items: unknown[], nextCursor: string | null }
    if (topic.kind !== 'conversation') {
      const method = topic.kind === 'taskIndex' ? 'conversations.list' : topic.kind === 'draftIndex' ? 'composerDrafts.list' : 'approvals.list'
      return this.#read(method, { limit: PRODUCT_LIMITS.pageItems, cursor, ...(topic.kind === 'approvalInbox' ? { status: 'pending' } : {}) }) as { items: unknown[], nextCursor: string | null }
    }
    let phase = 0
    let nested: string | null = null
    if (cursor) {
      const match = /^([0-5])\.(.*)$/.exec(cursor)
      if (!match)
        throw new ProductProtocolError('CURSOR_EXPIRED')
      phase = Number(match[1])
      nested = match[2] ? decodeURIComponent(match[2]) : null
    }
    const stages = ['task', 'run', 'queue', 'approval', 'message', 'message'] as const
    const input = { conversationId: topic.conversationId, branchId: topic.branchId, limit: PRODUCT_LIMITS.pageItems, cursor: nested }
    const entity = stages[phase]!
    const page = phase === 0
      ? { items: [this.task(topic.conversationId)].filter(Boolean), nextCursor: null }
      : phase === 5
        ? this.streaming.page(topic.conversationId, topic.branchId, nested)
        : this.#read(phase === 1 ? 'runs.list' : phase === 2 ? 'chat.queue.list' : phase === 3 ? 'approvals.list' : 'conversations.listMessages', input) as { items: unknown[], nextCursor: string | null }
    return { items: page.items.map(value => ({ entity, value })), nextCursor: page.nextCursor ? `${phase}.${encodeURIComponent(page.nextCursor)}` : phase < 5 ? `${phase + 1}.` : null }
  }

  handlers(): Partial<Record<ProductMethod, ProductRequestHandler>> {
    const handlers: Partial<Record<ProductMethod, ProductRequestHandler>> = {}
    for (const method of Object.keys(PRODUCT_QUERY_METHODS).filter(method => !method.startsWith('providers.') && method !== 'conversations.listArchived' && method !== 'conversations.getArchivePolicy') as (keyof typeof PRODUCT_QUERY_METHODS)[]) {
      handlers[method] = { handle: (input) => {
        assertCommittedRead(this.#database)
        return withTransaction(this.#database, () => this.#read(method, input as Record<string, unknown>))
      } }
    }
    return handlers
  }

  #read(method: keyof typeof PRODUCT_QUERY_METHODS, input: Record<string, unknown>): unknown {
    switch (method) {
      case 'service.host': return { platform: ['darwin', 'win32', 'linux'].includes(platform()) ? platform() : 'other' }
      case 'service.info': return { name: hostname() || 'Lexora' }
      case 'buddies.getAvatars': return new ProductBuddyAvatars(this.#database).metadata(input.buddyIds as string[])
      case 'questions.list': return this.#pages.read(`${method}:${input.conversationId}:${input.branchId}`, input, 'user_questions', 'EXISTS (SELECT 1 FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = user_questions.run_id AND r.conversation_id = ? AND r.branch_id = ? AND c.deleted_at IS NULL)', [String(input.conversationId), String(input.branchId)], id => this.views.question(id))
      case 'spaces.list': return this.#pages.read(method, input, 'spaces', 'revoked_at IS NULL', [], id => this.#database.prepare('SELECT id, name, memory_scope AS memoryScope FROM spaces WHERE id = ?').get(id))
      case 'conversations.listMessages': return this.#messagePage(input)
      case 'runs.listTranscriptEvents': return this.#run(String(input.runId))?.executionKind === 'root'
        ? this.#pages.read(`${method}:${input.runId}`, input, '(SELECT rowid, CAST(sequence AS TEXT) AS id, run_id, sequence FROM run_events)', 'run_id = ? AND sequence > ? AND sequence <= ?', [String(input.runId), BigInt(String(input.afterSequence)), BigInt(String(input.throughSequence))], sequence => this.views.transcriptEvent(String(input.runId), sequence), String(input.throughSequence))
        : { items: [], nextCursor: null }
      case 'runs.listEvents': return this.#run(String(input.runId)) ? this.#pages.read(`${method}:${input.runId}`, input, `(SELECT rowid, CAST(sequence AS TEXT) AS id, run_id, sequence FROM run_events)`, 'run_id = ? AND (? IS NULL OR sequence <= ?)', [String(input.runId), input.throughSequence ? BigInt(String(input.throughSequence)) : null, input.throughSequence ? BigInt(String(input.throughSequence)) : null], sequence => this.views.event(String(input.runId), sequence)) : { items: [], nextCursor: null }
      case 'chat.queue.list': return this.#pages.read(`${method}:${input.conversationId}:${input.branchId}`, input, 'chat_queue', 'conversation_id = ? AND branch_id = ? AND state IN (\'waiting\',\'paused\')', [String(input.conversationId), String(input.branchId)], id => this.views.queue(id))
      case 'approvals.getDecision': return this.views.approvalDecision(String(input.approvalId))
      case 'approvals.get': return this.views.approval(String(input.approvalId))
      case 'approvals.list': return this.#pages.read(method, input, 'approvals', '(? IS NULL OR run_id = ?) AND (? IS NULL OR status = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM runs WHERE runs.id = approvals.run_id AND runs.conversation_id = ?)) AND (? IS NULL OR EXISTS (SELECT 1 FROM runs WHERE runs.id = approvals.run_id AND runs.branch_id = ?))', [input.runId as string ?? null, input.runId as string ?? null, input.status as string ?? null, input.status as string ?? null, input.conversationId as string ?? null, input.conversationId as string ?? null, input.branchId as string ?? null, input.branchId as string ?? null], id => this.views.approval(id))
      case 'resources.get': return this.views.resource(String(input.resourceId))
      case 'resources.list': return this.#pages.read(method, input, `(SELECT a.rowid * 2 AS rowid, 'attachment:' || a.id AS id, m.conversation_id FROM attachments a JOIN messages m ON m.id = a.message_id UNION ALL SELECT rowid * 2 + 1 AS rowid, 'artifact:' || id AS id, conversation_id FROM artifacts)`, 'conversation_id = ?', [String(input.conversationId)], id => this.views.resource(id))
      case 'taskMarks.list': return this.#pages.read(method, input, 'task_marks', '1', [], (id) => {
        const mark = createTaskMarkRepository(this.#database).list().find(mark => mark.id === id)!
        return { ...mark, revision: encodeProductRevision(new ConversationCommandRepository(this.#database).markRevision(id)) }
      })
      case 'taskMarks.states': return (input.conversationIds as string[]).map((id) => {
        const state = createTaskMarkRepository(this.#database).getState(id)
        return { ...state, readRevision: encodeProductRevision(state.readRevision), assignmentRevision: encodeProductRevision(new ConversationCommandRepository(this.#database).assignmentRevision(id)) }
      })
      case 'conversations.get': return this.task(String(input.conversationId))
      case 'composerDrafts.get': return this.draft(String(input.draftId))
      case 'composerDrafts.find': return this.#drafts.find(input.scope as BuddyComposerDraft['scope'])
      case 'runs.get': return this.#run(String(input.runId))
      case 'runs.getExecutionState': return this.views.runExecution(String(input.runId))
      case 'conversations.list': return this.#pages.read(method, input, 'conversations', 'deleted_at IS NULL AND archived_at IS NULL AND (? IS NULL OR space_id = ?)', [input.spaceId as string ?? null, input.spaceId as string ?? null], { batch: ids => this.#tasks.summaries(ids) })
      case 'composerDrafts.list': return this.#pages.read(method, input, 'composer_drafts', '1', [], id => this.draft(id))
      case 'runs.list': return this.#pages.read(`${method}:${input.conversationId}:${input.branchId}`, input, 'runs', 'conversation_id = ? AND branch_id = ? AND execution_kind IN (\'root\', \'actor_child\', \'maintenance\') AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = runs.conversation_id AND c.deleted_at IS NULL)', [String(input.conversationId), String(input.branchId)], id => this.#run(id))
      case 'conversations.listBranches': return this.#pages.read(`${method}:${input.conversationId}`, input, 'conversation_branches', 'conversation_id = ? AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_branches.conversation_id AND c.deleted_at IS NULL)', [String(input.conversationId)], (id) => {
        const branch = this.#database.prepare('SELECT * FROM conversation_branches WHERE id = ?').get(id)!
        const counts = this.#database.prepare(`SELECT
          (SELECT COUNT(*) FROM user_questions q JOIN runs r ON r.id = q.run_id WHERE r.conversation_id = ? AND r.branch_id = ? AND json_extract(q.request_json, '$.status') = 'pending') AS pendingQuestionCount,
          (SELECT COUNT(*) FROM approvals a JOIN runs r ON r.id = a.run_id WHERE r.conversation_id = ? AND r.branch_id = ? AND a.status = 'pending') AS pendingApprovalCount,
          (SELECT COUNT(*) FROM runs WHERE conversation_id = ? AND branch_id = ? AND execution_kind IN ('root', 'actor_child') AND status IN ('queued', 'running')) AS runningCount,
          (SELECT COUNT(*) FROM chat_queue WHERE conversation_id = ? AND branch_id = ? AND state IN ('waiting', 'paused')) AS queuedCount`).get(...Array.from({ length: 4 }, () => [String(branch.conversation_id), id]).flat())!
        return { id: branch.id, conversationId: branch.conversation_id, parentBranchId: branch.parent_branch_id, forkedFromMessageId: branch.forked_from_message_id, createdAt: branch.created_at, ...Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, Number(count)])) }
      })
    }
  }

  #run(id: string) {
    const run = createRunRepository(this.#database).findById(id)
    if (!run || run.executionKind === 'npc_child' || !this.task(run.conversationId))
      return null
    const input = createRunInputRepository(this.#database).findByRunId(id)
    const code = productErrorCodeSchema.safeParse(run.errorCode)
    return productRunSchema.parse({ ...toPublicRun(run, input?.reasoning ?? null), executionKind: run.executionKind, generation: encodeProductRevision(run.generation), lastEventSequence: encodeProductRevision(Number(this.#database.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get(id)?.next_event_sequence ?? 1) - 1), errorCode: run.errorCode ? code.success ? code.data : 'INTERNAL_ERROR' : null })
  }

  #messagePage(input: Record<string, unknown>) {
    const conversationId = String(input.conversationId)
    const branchId = String(input.branchId)
    const conversations = createConversationRepository(this.#database)
    if (!this.task(conversationId))
      throw new ProductProtocolError('OBJECT_DELETED')
    const revision = productQueryRevision(this.#database, 'conversations.listMessages', input)
    const scope = digestScope(['messages', this.#instance, conversationId, branchId])
    let upperBound = encodeProductRevision(Number(this.#database.prepare('SELECT COUNT(*) AS value FROM messages').get()!.value))
    let position = 0n
    let beforeMessageId: string | undefined
    if (input.cursor) {
      try {
        const cursor = decodeProductCursor(String(input.cursor), { scope, branchId, revision })
        beforeMessageId = cursor.anchorId
        position = BigInt(cursor.position)
        upperBound = cursor.upperBound
      }
      catch { throw new ProductProtocolError('CURSOR_EXPIRED') }
    }
    const source = conversations.listMessagePage(conversationId, branchId, { limit: Number(input.limit), beforeMessageId })
    const items: ReturnType<ProductReadViews['message']>[] = []
    for (const message of [...source.items].reverse()) {
      const item = this.views.message(message)
      if (productByteLength(JSON.stringify([...items, item])) > PRODUCT_LIMITS.pageBytes - 4096)
        break
      items.push(item)
    }
    if (source.items.length && !items.length)
      throw new ProductProtocolError('PAGE_TOO_LARGE')
    items.reverse()
    position += BigInt(items.length)
    const more = items.length < source.items.length || source.nextBeforeMessageId !== null
    return { items, nextCursor: more ? encodeProductCursor({ version: 1, scope, branchId, revision, upperBound, position: encodeProductRevision(position), anchorId: items[0]?.id }) : null }
  }
}

function digestScope(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

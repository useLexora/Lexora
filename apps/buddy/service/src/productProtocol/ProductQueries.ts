import type { BuddyResourceQuote } from '../../../shared/conversation/buddyUserContent'
import type { BuddyComposerDraft } from '../../../shared/conversation/composerDraft'
import type { ProductMethod } from '../../../shared/productProtocol/methods'
import type { ProductTopic } from '../../../shared/productProtocol/topics'
import type { MessageRecord } from '../storage/conversationHistoryRepository'
import type { ProductRequestHandler } from './ProductConnection'
import { createHash } from 'node:crypto'
import { hostname, platform } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { productReadActivityStepDetailInputSchema } from '../../../shared/productProtocol/activityStepDetail'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { productReadLiveTextInputSchema, productReadSavedTextInputSchema } from '../../../shared/productProtocol/messageText'
import { PRODUCT_QUERY_METHODS } from '../../../shared/productProtocol/queries'
import { decodeProductCursor, encodeProductCursor, encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { parseProductTopic } from '../../../shared/productProtocol/topics'
import { productActivityStepsInputSchema, productTurnWindowInputSchema } from '../../../shared/productProtocol/turns'
import { ConversationCommandRepository } from '../storage/ConversationCommandRepository'
import { createConversationRepository } from '../storage/conversationRepository'
import { createTaskMarkRepository } from '../storage/taskMarkRepository'
import { assertCommittedRead, withTransaction } from '../storage/transaction'
import { readActivityStepDetail } from './ProductActivityStepDetail'
import { ProductBuddyAvatars } from './ProductBuddyAvatars'
import { ProductBuddyDirectory } from './ProductBuddyDirectory'
import { ProductContentReferences } from './ProductContentReferences'
import { ProductDraftReadModel } from './ProductDraftReadModel'
import { ProductHistorySearch } from './ProductHistorySearch'
import { ProductPageReader } from './ProductPageReader'
import { productQueryRevision } from './ProductQueryRevisions'
import { ProductReadViews } from './ProductReadViews'
import { ProductRunOutputs } from './ProductRunOutputs'
import { ProductStreamingMessages } from './ProductStreamingMessages'
import { ProductTaskReadModel } from './ProductTaskReadModel'
import { createProductTurnSnapshot } from './ProductTurnSnapshot'
import { ProductTurnWindow } from './ProductTurnWindow'
import { readProductRun } from './readProductRun'

export class ProductQueries {
  readonly #database: DatabaseSync
  readonly #actorId: string
  readonly #instance: string
  readonly #references: ProductContentReferences
  readonly #hasReview: (approvalId: string, version: string) => boolean
  readonly views: ProductReadViews
  readonly streaming: ProductStreamingMessages
  readonly turns: ProductTurnWindow
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
    this.turns = new ProductTurnWindow(database, serviceInstanceId, this.views)
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
      const read = topic.kind === 'conversationTurns'
        ? createProductTurnSnapshot(queries.#turnSnapshotItems(topic.conversationId, topic.branchId))
        : (cursor: string | null) => queries.#topicPage(topic, cursor)
      return { close, read: (cursor: string | null) => {
        if (closed)
          throw new ProductProtocolError('CURSOR_EXPIRED')
        const page = read(cursor)
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
    if ((topic.kind === 'conversation' || topic.kind === 'conversationWindow' || topic.kind === 'conversationTurns' || topic.kind === 'questions') && (!this.task(topic.conversationId) || !this.#database.prepare('SELECT 1 FROM conversation_branches WHERE id = ? AND conversation_id = ?').get(topic.branchId, topic.conversationId)))
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
    if (topic.kind === 'conversationTurns')
      return createProductTurnSnapshot(this.#turnSnapshotItems(topic.conversationId, topic.branchId))(cursor)
    if (topic.kind === 'conversationWindow')
      return this.#windowTopicPage(topic.conversationId, topic.branchId, cursor)
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
    for (const method of Object.keys(PRODUCT_QUERY_METHODS).filter(method => !method.startsWith('providers.') && method !== 'conversations.listArchived' && method !== 'conversations.getArchivePolicy' && method !== 'conversations.getQueueControls') as (keyof typeof PRODUCT_QUERY_METHODS)[]) {
      handlers[method] = { handle: (input, context) => {
        if (method === 'conversations.search' && (input as { scope: string }).scope === 'archived' && context.role !== 'owner')
          throw new ProductProtocolError('NOT_AUTHORIZED')
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
      case 'buddies.list': return new ProductBuddyDirectory(this.#database, this.#instance).list(input)
      case 'conversations.listMembers': return new ProductBuddyDirectory(this.#database, this.#instance).members(input)
      case 'conversations.search': return new ProductHistorySearch(this.#database, this.#instance, this.views).search(input)
      case 'conversations.readActivityStepDetail': return readActivityStepDetail(this.#database, this.turns, productReadActivityStepDetailInputSchema.parse(input))
      case 'conversations.getReplyTarget': return this.turns.replyTarget({ conversationId: String(input.conversationId), branchId: String(input.branchId), messageId: String(input.messageId) })
      case 'conversations.getTurnWindow': return this.turns.page(productTurnWindowInputSchema.parse(input))
      case 'conversations.listActivitySteps': return this.turns.steps(productActivityStepsInputSchema.parse(input))
      case 'conversations.readSavedText': return this.turns.readSavedText(productReadSavedTextInputSchema.parse(input))
      case 'conversations.readLiveText': return this.streaming.readBefore(productReadLiveTextInputSchema.parse(input))
      case 'conversations.getMessageWindow': return this.#messageWindow(input)
      case 'conversations.getRecentWindow': return this.#recentWindow(input)
      case 'buddies.getAvatars': return new ProductBuddyAvatars(this.#database).metadata(input.buddyIds as string[])
      case 'questions.list': return this.#pages.read(`${method}:${input.conversationId}:${input.branchId}`, input, 'user_questions', 'EXISTS (SELECT 1 FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = user_questions.run_id AND r.conversation_id = ? AND r.branch_id = ? AND c.deleted_at IS NULL)', [String(input.conversationId), String(input.branchId)], id => this.views.question(id))
      case 'spaces.list': return this.#pages.read(method, input, 'spaces', 'revoked_at IS NULL', [], id => this.#database.prepare('SELECT id, name, memory_scope AS memoryScope FROM spaces WHERE id = ?').get(id))
      case 'conversations.listMessages': return this.#messagePage(input)
      case 'runs.listTranscriptEvents': return this.readRun(String(input.runId))?.executionKind === 'root'
        ? this.#pages.read(`${method}:${input.runId}`, input, '(SELECT rowid, CAST(sequence AS TEXT) AS id, run_id, sequence FROM run_events)', 'run_id = ? AND sequence > ? AND sequence <= ?', [String(input.runId), BigInt(String(input.afterSequence)), BigInt(String(input.throughSequence))], sequence => this.views.transcriptEvent(String(input.runId), sequence), String(input.throughSequence))
        : { items: [], nextCursor: null }
      case 'runs.listOutputs': return new ProductRunOutputs(this.#database, this.#pages, this.views).read(input)
      case 'runs.listEvents': return this.readRun(String(input.runId)) ? this.#pages.read(`${method}:${input.runId}`, input, `(SELECT rowid, CAST(sequence AS TEXT) AS id, run_id, sequence FROM run_events)`, 'run_id = ? AND (? IS NULL OR sequence <= ?)', [String(input.runId), input.throughSequence ? BigInt(String(input.throughSequence)) : null, input.throughSequence ? BigInt(String(input.throughSequence)) : null], sequence => this.views.event(String(input.runId), sequence)) : { items: [], nextCursor: null }
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
      case 'runs.get': return this.readRun(String(input.runId))
      case 'runs.getExecutionState': return this.views.runExecution(String(input.runId))
      case 'conversations.list': return this.#pages.read(method, input, 'conversations', 'deleted_at IS NULL AND archived_at IS NULL AND (? IS NULL OR space_id = ?)', [input.spaceId as string ?? null, input.spaceId as string ?? null], { batch: ids => this.#tasks.summaries(ids) })
      case 'composerDrafts.list': return this.#pages.read(method, input, 'composer_drafts', '1', [], id => this.draft(id))
      case 'runs.list': return this.#pages.read(`${method}:${input.conversationId}:${input.branchId}`, input, 'runs', 'conversation_id = ? AND branch_id = ? AND execution_kind IN (\'root\', \'actor_child\', \'maintenance\') AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = runs.conversation_id AND c.deleted_at IS NULL)', [String(input.conversationId), String(input.branchId)], id => this.readRun(id))
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

  * #turnSnapshotItems(conversationId: string, branchId: string) {
    this.assertTopic({ kind: 'conversationTurns', conversationId, branchId })
    yield { entity: 'task', value: this.task(conversationId) }
    const window = this.turns.page({ conversationId, branchId, cursor: null })
    const loaded = new Set(window.runs.map(run => run.id))
    const runIds = new Set(window.items.flatMap(message => message.runId ? [message.runId] : []))
    for (const value of window.runs) yield { entity: 'run', value }
    const messageIds = new Set(window.items.map(message => message.id))
    const runs = this.#database.prepare(`SELECT id FROM runs WHERE conversation_id = ? AND branch_id = ?
      AND execution_kind IN ('root', 'actor_child', 'maintenance') AND (status IN ('queued', 'running')
        OR id IN (SELECT value FROM json_each(?)))
      ORDER BY started_at, id`).all(conversationId, branchId, JSON.stringify([...runIds]))
    for (const row of runs) {
      if (loaded.has(String(row.id)))
        continue
      const run = this.readRun(String(row.id))
      if (!run)
        continue
      yield { entity: 'run', value: run }
      if (run.executionKind === 'root' && ['queued', 'running'].includes(run.status) && !messageIds.has(run.triggeringMessageId)) {
        const message = this.turnMessage(conversationId, branchId, run.triggeringMessageId, run.id)
        if (message?.role === 'user') {
          messageIds.add(message.id)
          yield { entity: 'message', value: message }
        }
      }
    }
    yield { entity: 'historyWindow', value: { conversationId, branchId, hasMore: window.nextCursor !== null, nextCursor: window.nextCursor } }
    for (const value of window.items) yield { entity: 'message', value }
    for (const value of window.groups) yield { entity: 'activityGroup', value }
    const approvals = this.#database.prepare(`SELECT a.id FROM approvals a JOIN runs r ON r.id = a.run_id
      WHERE r.conversation_id = ? AND r.branch_id = ? AND a.status = 'pending' ORDER BY a.created_at, a.id`).all(conversationId, branchId)
    for (const approval of approvals) {
      const value = this.views.approvalHeader(String(approval.id))
      if (value)
        yield { entity: 'approval', value }
    }
    let cursor: string | null = null
    do {
      const page = this.#read('chat.queue.list', { conversationId, branchId, cursor, limit: PRODUCT_LIMITS.pageItems }) as { items: unknown[], nextCursor: string | null }
      for (const value of page.items) yield { entity: 'queue', value }
      cursor = page.nextCursor
    } while (cursor !== null)
    do {
      const page = this.streaming.turnPage(conversationId, branchId, cursor)
      for (const message of page.items) yield { entity: 'message', value: { ...message, ...this.turns.binding({ conversationId, branchId, runId: message.runId, messageId: message.id }) } }
      cursor = page.nextCursor
    } while (cursor !== null)
  }

  turnMessage(conversationId: string, branchId: string, id: string, runId?: string) {
    const message = createConversationRepository(this.#database).findMessageById(id)
    if (!message || message.conversationId !== conversationId || (message.role !== 'user' && message.role !== 'assistant'))
      return null
    const binding = this.turns.binding({ conversationId, branchId, runId: message.runId ?? runId, messageId: message.id })
    if (message.branchId !== branchId && !(message.role === 'user' && binding.turnInputId === id))
      return null
    return { ...this.views.turnMessage(message), ...binding }
  }

  #windowTopicPage(conversationId: string, branchId: string, cursor: string | null): { items: unknown[], nextCursor: string | null } {
    const match = cursor === null ? null : /^([0-6])\.(.*)$/.exec(cursor)
    if (cursor !== null && !match)
      throw new ProductProtocolError('CURSOR_EXPIRED')
    const phase = match ? Number(match[1]) : 0
    const nested = match?.[2] ? decodeURIComponent(match[2]) : null
    const input = { conversationId, branchId, limit: PRODUCT_LIMITS.pageItems, cursor: nested }
    const entities = ['task', 'run', 'queue', 'approval', 'message', 'historyWindow', 'message'] as const
    let page: { items: unknown[], nextCursor: string | null }
    if (phase === 0) {
      this.assertTopic({ kind: 'conversationWindow', conversationId, branchId })
      page = { items: [this.task(conversationId)], nextCursor: null }
    }
    else if (phase === 1) {
      const active = this.#database.prepare('SELECT COUNT(*) AS count FROM runs WHERE conversation_id = ? AND branch_id = ? AND execution_kind IN (\'root\',\'actor_child\',\'maintenance\') AND status IN (\'queued\',\'running\')').get(conversationId, branchId)!
      if (Number(active.count) > PRODUCT_LIMITS.pageItems)
        throw new ProductProtocolError('PAGE_TOO_LARGE')
      const table = `(SELECT rowid, id FROM runs WHERE conversation_id = ? AND branch_id = ? AND execution_kind IN ('root','actor_child','maintenance') ORDER BY (status IN ('queued','running')) DESC, rowid DESC LIMIT ${PRODUCT_LIMITS.pageItems})`
      const rows = this.#database.prepare(`SELECT id FROM ${table}`).all(conversationId, branchId)
      page = this.#pages.read(`runs.list:recent:${conversationId}:${branchId}`, input, 'runs', 'id IN (SELECT value FROM json_each(?))', [JSON.stringify(rows.map(row => row.id))], id => this.readRun(id))
    }
    else if (phase === 2 || phase === 3) {
      const method = phase === 2 ? 'chat.queue.list' : 'approvals.list'
      page = this.#read(method, { ...input, ...(phase === 3 ? { status: 'pending' } : {}) }) as typeof page
      if (page.nextCursor)
        throw new ProductProtocolError('PAGE_TOO_LARGE')
    }
    else if (phase === 4 || phase === 5) {
      const { items, ...window } = this.#recentWindow(input)
      page = { items: phase === 4 ? items : [window], nextCursor: null }
    }
    else {
      page = this.streaming.page(conversationId, branchId, null)
      if (page.nextCursor)
        throw new ProductProtocolError('PAGE_TOO_LARGE')
    }
    return { items: page.items.map(value => ({ entity: entities[phase]!, value })), nextCursor: page.nextCursor ? `${phase}.${encodeURIComponent(page.nextCursor)}` : phase < 6 ? `${phase + 1}.` : null }
  }

  readRun(id: string) {
    return readProductRun(this.#database, id)
  }

  #recentWindow(input: Record<string, unknown>) {
    const page = this.#messagePage({ ...input, limit: 50, cursor: null })
    return { ...page, conversationId: String(input.conversationId), branchId: String(input.branchId), hasMore: page.nextCursor !== null }
  }

  #messageWindow(input: Record<string, unknown>) {
    const conversationId = String(input.conversationId)
    const branchId = String(input.branchId)
    const messageId = String(input.messageId)
    const conversations = createConversationRepository(this.#database)
    const message = conversations.findMessageById(messageId)
    if (!message || message.conversationId !== conversationId || (message.runId && !this.readRun(message.runId)))
      throw new ProductProtocolError('OBJECT_DELETED')
    let page
    try {
      page = this.#messagePage({ ...input, cursor: null }, message)
    }
    catch (error) {
      if (error instanceof ProductProtocolError)
        throw error
      throw new ProductProtocolError('OBJECT_DELETED')
    }
    const latest = conversations.listMessagePage(conversationId, branchId, { limit: 1 })
    return { ...page, conversationId, branchId, anchorMessageId: messageId, hasLater: latest.items[0]?.id !== messageId }
  }

  #messagePage(input: Record<string, unknown>, anchor?: MessageRecord) {
    const conversationId = String(input.conversationId)
    const branchId = String(input.branchId)
    const conversations = createConversationRepository(this.#database)
    if (!this.task(conversationId) || !this.#database.prepare('SELECT 1 FROM conversation_branches WHERE id = ? AND conversation_id = ?').get(branchId, conversationId))
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
    const source = conversations.listMessagePage(conversationId, branchId, { limit: Number(input.limit) - (anchor ? 1 : 0), beforeMessageId: anchor?.id ?? beforeMessageId })
    if (anchor)
      source.items.push(anchor)
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

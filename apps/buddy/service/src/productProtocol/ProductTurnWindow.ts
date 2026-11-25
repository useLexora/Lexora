import type { DatabaseSync } from 'node:sqlite'
import type { ProductReadSavedTextInput } from '../../../shared/productProtocol/messageText'
import type { ProductActivityGroup, ProductTurnWindowPage } from '../../../shared/productProtocol/turns'
import type { VisibleConversationBranchSegment } from '../storage/conversationHistoryRepository'
import type { ProductReadViews } from './ProductReadViews'
import type { ActivityIndex, TurnRun } from './ProductTurnActivities'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '../../../shared/conversation/buddyMessageContent'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { decodeProductCursor, encodeProductCursor } from '../../../shared/productProtocol/scalars'
import { createConversationHistoryStore } from '../storage/conversationHistoryRepository'
import { savedTextTail } from './ProductSavedText'
import { ProductTurnActivities, turnKey, visibleNarration } from './ProductTurnActivities'
import { readProductRun } from './readProductRun'

type Message = ProductTurnWindowPage['items'][number]
type WindowRun = ProductTurnWindowPage['runs'][number]
interface Scope { conversationId: string, branchId: string }
interface RunScope extends Scope { runId: string }
interface Header {
  id: string
  branchId: string
  runId: string | null
  rootId: string | null
  triggerId: string | null
  role: 'user' | 'assistant'
  createdAt: string
  position: number
}
const softBytes = 96 * 1024
const hardBytes = PRODUCT_LIMITS.pageBytes - 4096
const maxRows = PRODUCT_LIMITS.topicItems - 2
const publicMessage = `m.role IN ('user','assistant') AND (m.run_id IS NULL OR r.execution_kind = 'root' OR (r.execution_kind = 'actor_child' AND m.role = 'assistant'))
  AND (m.role <> 'assistant' OR ${visibleNarration})`
const selectHeader = `SELECT m.id,m.branch_id AS branchId,m.run_id AS runId,m.rowid AS position,m.role,m.created_at AS createdAt,
  root.id AS rootId,root.triggering_message_id AS triggerId FROM messages m
  LEFT JOIN runs r ON r.id = m.run_id AND r.conversation_id = m.conversation_id AND r.branch_id = m.branch_id
  LEFT JOIN runs root ON root.id = CASE WHEN r.execution_kind = 'actor_child' THEN r.root_run_id ELSE r.id END
    AND root.execution_kind = 'root' AND root.conversation_id = r.conversation_id AND root.branch_id = r.branch_id`

export class ProductTurnWindow {
  readonly #activities: ProductTurnActivities
  #history?: ReturnType<typeof createConversationHistoryStore>
  private readonly database: DatabaseSync
  private readonly instance: string
  private readonly views: ProductReadViews
  constructor(database: DatabaseSync, instance: string, views: ProductReadViews) {
    this.database = database
    this.instance = instance
    this.views = views
    this.#activities = new ProductTurnActivities(database)
  }

  #segments(scope: Scope) {
    if (!this.database.prepare(`SELECT 1 FROM conversations c JOIN conversation_branches b ON b.conversation_id = c.id
      WHERE c.id = ? AND b.id = ? AND c.deleted_at IS NULL`).get(scope.conversationId, scope.branchId)) {
      throw new ProductProtocolError('OBJECT_DELETED')
    }
    this.#history ??= createConversationHistoryStore(this.database)
    return this.#history.lineage.listVisibleSegments(scope.conversationId, scope.branchId)
  }

  #header(conversationId: string, id: string) {
    return this.database.prepare(`${selectHeader} WHERE m.conversation_id = ? AND m.id = ? AND ${publicMessage}`).get(conversationId, id) as unknown as Header | undefined
  }

  #visible(row: Header, segments: VisibleConversationBranchSegment[]) {
    return segments.some(s => s.branchId === row.branchId && (!s.throughMessage || row.createdAt < s.throughMessage.createdAt
      || (row.createdAt === s.throughMessage.createdAt && row.id <= s.throughMessage.id)))
  }

  #record(scope: Scope, row: Header) {
    const source = this.database.prepare('SELECT content_json FROM messages WHERE id = ?').get(row.id)!
    return { id: row.id, role: row.role, conversationId: scope.conversationId, runId: row.runId, branchId: row.branchId, createdAt: row.createdAt, content: JSON.parse(String(source.content_json)) as unknown }
  }

  replyTarget(scope: Scope & { messageId: string }) {
    const segments = this.#segments(scope)
    const row = this.#header(scope.conversationId, scope.messageId)
    if (!row?.runId || row.role !== 'assistant' || row.rootId !== row.runId || !this.#visible(row, segments))
      return { resultRunId: null }
    const final = this.database.prepare(`SELECT id FROM messages WHERE run_id = ? AND role = 'assistant'
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(row.runId)
    if (final?.id !== row.id)
      return { resultRunId: null }
    const source = this.database.prepare(`SELECT e.event_type AS type, json_extract(e.payload_json,'$.phase') AS phase,
      json_extract(e.payload_json,'$.stopReason') AS stop FROM conversation_publications p
      JOIN messages m ON m.id = p.message_id AND (length(trim(json_extract(m.content_json,'$.text'))) > 0
        OR json_array_length(m.content_json,'$.attachmentIds') > 0 OR json_extract(m.content_json,'$.state') = 'interrupted')
      JOIN run_events e ON e.run_id = p.run_id AND e.sequence = p.source_sequence
      WHERE p.message_id = ? AND p.kind = 'message' AND p.run_id = ? AND p.branch_id = ? AND p.conversation_id = ?
        AND json_extract(e.payload_json,'$.messageId') = p.message_id`).get(row.id, row.runId, row.branchId, scope.conversationId)
    const reply = source?.type === 'message.interrupted' || (source?.type === 'message.completed'
      && (source.phase === 'final_answer' || (!source.phase && ['completed', 'length', 'failed'].includes(String(source.stop)))))
    return { resultRunId: reply ? row.runId : null }
  }

  readSavedText(input: ProductReadSavedTextInput) {
    const segments = this.#segments(input)
    const row = this.#header(input.conversationId, input.messageId)
    if (!row || row.role !== 'assistant' || !this.#visible(row, segments))
      throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
    const size = this.database.prepare('SELECT octet_length(content_json) AS n FROM messages WHERE id = ?').get(row.id)
    if (!size || Number(size.n) > MAX_BUDDY_MESSAGE_TEXT_LENGTH * 6 + 65_536)
      throw new ProductProtocolError('CONTENT_UNSUPPORTED')
    return this.views.readSavedText(this.#record(input, row), input)
  }

  #project(scope: Scope, row: Header): Message {
    const { tool: _, ...message } = this.views.turnMessage(this.#record(scope, row))
    return { ...message, role: row.role, ...(row.rootId && row.triggerId ? { turnRootId: row.rootId, turnInputId: row.triggerId } : {}) }
  }

  page(input: Scope & { cursor?: string | null }): ProductTurnWindowPage {
    const segments = this.#segments(input)
    const scope = turnKey(['turns', this.instance, input.conversationId, input.branchId, segments])
    let upperBound = String(this.database.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').get()!.n)
    let before: Header | undefined
    if (input.cursor) {
      try {
        const cursor = decodeProductCursor(input.cursor, { scope, revision: '0', branchId: input.branchId })
        before = this.#header(input.conversationId, cursor.anchorId ?? '')
        if (!before || !this.#visible(before, segments) || String(before.position) !== cursor.position)
          throw new Error('cursor')
        upperBound = cursor.upperBound
      }
      catch { throw new ProductProtocolError('CURSOR_EXPIRED') }
    }
    const desc: Header[] = []
    for (let i = before ? segments.findIndex(s => s.branchId === before.branchId) : segments.length - 1; i >= 0 && desc.length <= maxRows; i--) {
      const seg = segments[i]!
      const bound = seg.branchId === before?.branchId ? before : seg.throughMessage
      const condition = bound ? `AND (m.created_at,m.id) ${bound === before ? '<' : '<='} (?,?)` : ''
      const rows = this.database.prepare(`${selectHeader} WHERE m.conversation_id = ? AND m.branch_id = ? AND m.rowid <= ? AND ${publicMessage}
        ${condition} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`).all(input.conversationId, seg.branchId, BigInt(upperBound), ...(bound ? [bound.createdAt, bound.id] : []), maxRows + 1 - desc.length) as unknown as Header[]
      desc.push(...rows)
    }
    if (!desc.length)
      return { items: [], groups: [], runs: [], nextCursor: null }
    this.#bindSteers(input.conversationId, desc)
    const validInputs = new Map<string, boolean>()
    const visibleUsers = new Set(desc.filter(h => h.role === 'user').map(h => h.id))
    for (const h of desc) {
      if (!h.triggerId || visibleUsers.has(h.triggerId))
        continue
      if (!validInputs.has(h.triggerId)) {
        const trigger = this.#header(input.conversationId, h.triggerId)
        validInputs.set(h.triggerId, !!trigger && trigger.role === 'user' && this.#visible(trigger, segments))
      }
      if (!validInputs.get(h.triggerId)) {
        h.triggerId = null
        h.rootId = null
      }
    }
    const active = new Set<string>()
    if (!before) {
      const rows = this.database.prepare(`SELECT DISTINCT triggering_message_id AS id FROM runs WHERE conversation_id = ? AND branch_id = ? AND execution_kind = 'root' AND status IN ('queued','running') LIMIT ?`).all(input.conversationId, input.branchId, maxRows)
      for (const r of rows) active.add(String(r.id))
    }
    const groupsFor = this.#groupsByAnchor(input, segments, desc, active)
    const ids = new Set(desc.map(h => h.id))
    const items: Message[] = []
    const runs = new Map<string, WindowRun>()
    const addedRuns = (row: Header | null, groups: ProductActivityGroup[], block?: Map<string, WindowRun>) => {
      return groupsFor.represented(row, groups).filter(id => !runs.has(id) && !block?.has(id)).flatMap(id => readProductRun(this.database, id) ?? [])
    }
    let summaries: ProductActivityGroup[] = []
    const chunks: Header[][] = []
    let current: Header[] = []
    let missing = new Set([...active].filter(id => ids.has(id)))
    for (const h of desc.slice(0, maxRows)) {
      current.push(h)
      if (h.triggerId && h.triggerId !== h.id && ids.has(h.triggerId))
        missing.add(h.triggerId)
      missing.delete(h.id)
      if (!missing.size) {
        chunks.push(current)
        current = []
      }
    }
    if (current.length)
      chunks.push(current)
    let consumed = 0
    let used = 0
    for (const chunk of chunks) {
      const block: Message[] = []
      const blockGroups: ProductActivityGroup[] = []
      let bytes = 0
      const blockRuns = new Map<string, WindowRun>()
      for (const h of chunk) {
        let msg = this.#project(input, h)
        const rows = groupsFor.after(h)
        const additional = addedRuns(h, rows, blockRuns)
        const runCost = additional.reduce((n, r) => n + productByteLength(JSON.stringify(r)) + 1, 0)
        let size = byteCost(msg, rows) + runCost
        if (!consumed && (bytes + size > softBytes)) {
          msg = compact(msg)
          size = byteCost(msg, rows) + runCost
        }
        const reserve = !consumed && h.role !== 'user' && (active.size || h.triggerId) ? hardBytes / 3 : 0
        if (used + bytes + size > hardBytes - reserve || blockGroups.length + summaries.length + rows.length > PRODUCT_LIMITS.topicItems)
          break
        if (runs.size + blockRuns.size + additional.length > PRODUCT_LIMITS.topicItems)
          break
        for (const r of additional) blockRuns.set(r.id, r)
        bytes += size
        block.push(msg)
        blockGroups.push(...rows)
        if (consumed && used + bytes > softBytes)
          break
      }
      if (consumed && (used + bytes > softBytes || block.length < chunk.length))
        break
      if (!block.length)
        throw new ProductProtocolError('PAGE_TOO_LARGE')
      for (const r of blockRuns.values()) runs.set(r.id, r)
      items.push(...block)
      summaries.push(...blockGroups)
      consumed += block.length
      used += bytes
      if (block.length < chunk.length || used >= softBytes || groupsFor.work() >= 8192)
        break
    }
    items.reverse()
    // A pathological single turn may itself exceed the page. Keep the real trigger
    // alongside the continued page, but page by the oldest consumed row, not the repeat.
    const selected = new Set(items.map(x => x.id))
    missing = new Set([...active, ...desc.slice(0, consumed).map(h => h.triggerId).filter((id): id is string => !!id)].filter(id => !selected.has(id)))
    for (const id of missing) {
      const h = this.#header(input.conversationId, id)
      if (!h || h.role !== 'user' || !this.#visible(h, segments))
        continue
      const msg = compact(this.#project(input, h))
      const additional = addedRuns(h, [])
      const size = byteCost(msg, []) + additional.reduce((n, r) => n + productByteLength(JSON.stringify(r)) + 1, 0)
      if (used + size > hardBytes || items.length >= PRODUCT_LIMITS.topicItems || runs.size + additional.length > PRODUCT_LIMITS.topicItems)
        break
      for (const r of additional) runs.set(r.id, r)
      items.unshift(msg)
      selected.add(id)
      used += size
    }
    const groupIds = new Set(summaries.map(g => g.id))
    for (const group of groupsFor.active(selected)) {
      if (groupIds.has(group.id) || !group.afterMessageId || summaries.length >= PRODUCT_LIMITS.topicItems)
        continue
      const anchor = this.#header(input.conversationId, group.afterMessageId)
      if (!anchor || !this.#visible(anchor, segments))
        continue
      const row = selected.has(anchor.id) ? null : compact(this.#project(input, anchor))
      const additional = addedRuns(anchor, [group])
      const size = productByteLength(JSON.stringify(group)) + (row ? byteCost(row, []) : 0) + 1 + additional.reduce((n, r) => n + productByteLength(JSON.stringify(r)) + 1, 0)
      if (used + size > hardBytes || (row && items.length >= PRODUCT_LIMITS.topicItems) || runs.size + additional.length > PRODUCT_LIMITS.topicItems)
        continue
      if (row) {
        items.push(row)
        selected.add(row.id)
      }
      for (const r of additional) runs.set(r.id, r)
      summaries.push(group)
      groupIds.add(group.id)
      used += size
    }
    const branchOrder = new Map(segments.map((s, i) => [s.branchId, i]))
    items.sort((a, b) => branchOrder.get(a.branchId)! - branchOrder.get(b.branchId)! || a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : Number(a.id !== b.id)))
    summaries = summaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const anchor = desc[consumed - 1]!
    return { items, groups: summaries, runs: [...runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)), nextCursor: consumed < desc.length ? encodeProductCursor({ version: 1, scope, branchId: input.branchId, revision: '0', upperBound, position: String(anchor.position), anchorId: anchor.id }) : null }
  }

  #bindSteers(conversationId: string, rows: Header[]) {
    const userRows = new Map(rows.filter(h => h.role === 'user' && !h.triggerId).map(h => [h.id, h]))
    if (!userRows.size)
      return
    const bindings = this.database.prepare(`SELECT json_extract(q.prepared_json,'$.userMessageId') AS id, r.branch_id AS branchId,
      root.id AS rootId, root.triggering_message_id AS triggerId FROM chat_queue q JOIN runs r ON r.id = q.run_id AND r.conversation_id = q.conversation_id AND r.branch_id = q.branch_id
      JOIN runs root ON root.id = CASE WHEN r.execution_kind = 'actor_child' THEN r.root_run_id ELSE r.id END AND root.execution_kind = 'root' AND root.conversation_id = r.conversation_id AND root.branch_id = r.branch_id
      WHERE q.conversation_id = ? AND q.state = 'sent' AND r.execution_kind IN ('root','actor_child') AND json_extract(q.prepared_json,'$.userMessageId') IN (SELECT value FROM json_each(?))`)
    for (const b of bindings.iterate(conversationId, JSON.stringify([...userRows.keys()]))) {
      const row = userRows.get(String(b.id))!
      if (row.branchId !== b.branchId)
        continue
      row.rootId = String(b.rootId)
      row.triggerId = String(b.triggerId)
    }
  }

  #groupsByAnchor(scope: Scope, segments: VisibleConversationBranchSegment[], rows: Header[], active: Set<string>) {
    const roots = rows.flatMap(h => h.rootId ? [h.rootId] : [])
    const users = rows.filter(h => h.role === 'user').map(h => h.id)
    const mentioned = JSON.stringify([...new Set(roots)])
    const runs = this.database.prepare(`WITH candidates AS (SELECT id,branch_id AS branchId,triggering_message_id AS triggerId,status,
      ROW_NUMBER() OVER (PARTITION BY branch_id,triggering_message_id ORDER BY started_at DESC,rowid DESC) AS attempt,
      EXISTS(SELECT 1 FROM conversation_publications p WHERE p.run_id = runs.id AND p.kind = 'output') AS hasOutput
      FROM runs WHERE conversation_id = ? AND branch_id IN (SELECT value FROM json_each(?)) AND execution_kind = 'root'
        AND (id IN (SELECT value FROM json_each(?)) OR triggering_message_id IN (SELECT value FROM json_each(?))))
      SELECT * FROM candidates c WHERE attempt = 1 OR hasOutput OR status IN ('running','queued') OR id IN (SELECT value FROM json_each(?))
        OR EXISTS(SELECT 1 FROM run_events e WHERE e.run_id = c.id AND e.event_type IN ('tool.started','tool.preparing','tool.completed','tool.failed','tool.denied','message.block.started','message.block.completed'))
        OR EXISTS(SELECT 1 FROM messages m WHERE m.run_id = c.id AND m.role = 'tool') LIMIT ?`)
      .all(scope.conversationId, JSON.stringify(segments.map(s => s.branchId)), mentioned, JSON.stringify([...new Set([...users, ...active])]), mentioned, maxRows * 8 + 1) as unknown as Array<TurnRun & { attempt: number, hasOutput: number }>
    if (runs.length > maxRows * 8)
      throw new ProductProtocolError('PAGE_TOO_LARGE')
    const owners = new Map(runs.map(run => [run.id, run]))
    const triggers = new Map<string, typeof runs>()
    for (const run of runs) {
      const siblings = triggers.get(run.triggerId) ?? []
      siblings.push(run)
      triggers.set(run.triggerId, siblings)
    }
    const loaded = new Map<string, ActivityIndex>()
    let work = 0
    const read = (run: TurnRun) => {
      let index = loaded.get(run.id)
      if (!index) {
        const segment = segments.find(s => s.branchId === run.branchId)!
        index = this.#activities.read(run, scope.conversationId, segment)
        work += index.work
        loaded.set(run.id, index)
        if (loaded.size > 8)
          loaded.delete(loaded.keys().next().value!)
      }
      return index
    }
    return {
      work: () => work,
      represented(row: Header | null, groups: ProductActivityGroup[]) {
        const ids = new Set(groups.map(g => g.runId))
        if (row?.rootId)
          ids.add(row.rootId)
        if (row?.role === 'user') {
          for (const r of triggers.get(row.id) ?? []) {
            if (r.attempt === 1 || r.hasOutput || r.status === 'running' || r.status === 'queued')
              ids.add(r.id)
          }
        }
        return [...ids].filter(id => owners.get(id)?.branchId === scope.branchId)
      },
      after(row: Header) {
        const owner = row.rootId ? owners.get(row.rootId) : undefined
        const candidates = new Set([...(triggers.get(row.id) ?? []), ...(owner ? [owner] : [])])
        return [...candidates].flatMap(run => read(run).after(row.id) ?? [])
      },
      active(selected: ReadonlySet<string>) {
        return runs.flatMap(run => active.has(run.triggerId) && selected.has(run.triggerId) && run.branchId === scope.branchId && (run.status === 'queued' || run.status === 'running') ? read(run).latest() ?? [] : [])
      },
    }
  }

  binding(scope: Scope & { runId?: string | null, messageId?: string }): { turnRootId?: string, turnInputId?: string } {
    const segments = this.#segments(scope)
    const message = scope.messageId ? this.#header(scope.conversationId, scope.messageId) : undefined
    if (message && !this.#visible(message, segments))
      return {}
    if (message?.role === 'user')
      this.#bindSteers(scope.conversationId, [message])
    const id = message?.rootId ?? message?.runId ?? scope.runId
    if (!id)
      return {}
    const root = this.database.prepare(`SELECT root.id,root.triggering_message_id AS input FROM runs r JOIN runs root ON root.id = CASE WHEN r.execution_kind = 'actor_child' THEN r.root_run_id ELSE r.id END
      AND root.conversation_id = r.conversation_id AND root.branch_id = r.branch_id AND root.execution_kind = 'root'
      WHERE r.id = ? AND r.conversation_id = ? AND r.execution_kind IN ('actor_child','root') AND r.branch_id IN (SELECT value FROM json_each(?))`).get(id, scope.conversationId, JSON.stringify(segments.map(s => s.branchId)))
    if (!root || (message?.role === 'user' && !message.rootId && root.input !== message.id))
      return {}
    const trigger = this.#header(scope.conversationId, String(root.input))
    return trigger?.role === 'user' && this.#visible(trigger, segments) ? { turnRootId: String(root.id), turnInputId: trigger.id } : {}
  }

  #activity(scope: RunScope) {
    const segments = this.#segments(scope)
    const run = this.database.prepare(`SELECT id,branch_id AS branchId,triggering_message_id AS triggerId,status FROM runs
      WHERE id = ? AND conversation_id = ? AND execution_kind = 'root'`).get(scope.runId, scope.conversationId) as unknown as TurnRun | undefined
    const segment = segments.find(s => s.branchId === run?.branchId)
    if (!run || !segment)
      return null
    const input = this.#header(scope.conversationId, run.triggerId)
    if (!input || input.role !== 'user' || !this.#visible(input, segments))
      return null
    const index = this.#activities.read(run, scope.conversationId, segment)
    return { index, live: index.live }
  }

  groupForCall(input: RunScope & { toolCallId: string }) {
    return this.#activity(input)?.index.groupForCall(input.toolCallId) ?? null
  }

  groupForReasoning(input: RunScope & { messageId: string, contentIndex: number }) {
    return this.#activity(input)?.index.groupForReasoning(input.messageId, input.contentIndex) ?? null
  }

  reasoningGroupsForMessage(input: RunScope & { messageId: string }) {
    return this.#activity(input)?.index.settled(input.messageId) ?? []
  }

  interruptedGroups(input: RunScope) {
    return this.#activity(input)?.index.summaries().filter(group => group.interruptedCount || group.interruptedReasoningCount) ?? []
  }

  resolveStep(input: RunScope & { groupId: string, stepId: string }) {
    return this.#activity(input)?.index.resolveStep(input.groupId, input.stepId) ?? null
  }

  steps(input: RunScope & { groupId: string, cursor?: string | null, limit?: number }, format: 'legacy' | 'ordered' = 'legacy') {
    const activity = this.#activity(input)
    const steps = activity?.index.steps(input.groupId, format)
    if (!steps || !activity)
      throw new ProductProtocolError('OBJECT_DELETED')
    const scope = turnKey([format === 'ordered' ? 'orderedSteps' : 'steps', this.instance, input.conversationId, input.branchId, input.runId, input.groupId])
    let start = 0
    let upperBound = steps.length
    if (input.cursor) {
      try {
        const cursor = decodeProductCursor(input.cursor, { scope, revision: '0', branchId: input.branchId })
        start = Number(cursor.position)
        upperBound = Number(cursor.upperBound)
        if (upperBound > steps.length || steps[start - 1]?.id !== cursor.anchorId)
          throw new Error('cursor')
      }
      catch { throw new ProductProtocolError('CURSOR_EXPIRED') }
    }
    const end = Math.min(upperBound, start + Math.max(1, Math.min(PRODUCT_LIMITS.pageItems, input.limit ?? 32)))
    const page = steps.slice(start, end)
    const items = (format === 'ordered' ? activity.index.withSummaries(page) : page).map(s => ({ ...s, status: !activity.live && s.status === 'running' ? 'interrupted' as const : s.status }))
    return { items, nextCursor: end < upperBound ? encodeProductCursor({ version: 1, scope, revision: '0', branchId: input.branchId, upperBound: String(upperBound), position: String(end), anchorId: steps[end - 1]!.id }) : null }
  }
}

function byteCost(msg: Message, groups: ProductActivityGroup[]) {
  return productByteLength(JSON.stringify(msg)) + productByteLength(JSON.stringify(groups)) + 2
}
function compact(msg: Message): Message {
  if (msg.body.kind === 'text' && msg.body.text.length > 1024) {
    const { text, interrupted, truncated } = msg.body
    const page = msg.role === 'assistant' ? savedTextTail(text, 1024) : null
    return { ...msg, ...(page ? { textRange: page.range } : {}), body: { kind: 'resource', resourceId: `message:${msg.id}`, previewText: page?.text ?? text.slice(0, 1024).replace(/[\uD800-\uDBFF]$/, ''), readOnly: true, interrupted, truncated } }
  }
  return msg
}

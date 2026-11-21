import type { DatabaseSync } from 'node:sqlite'
import type { ProductActivityGroup, ProductActivityStep } from '../../../shared/productProtocol/turns'
import type { VisibleConversationBranchSegment } from '../storage/conversationHistoryRepository'
import { createHash } from 'node:crypto'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { hasProductTurnCommentarySql } from './ProductTurnCommentary'

export interface TurnRun { id: string, branchId: string, triggerId: string, status: string }
interface Fact {
  at: string
  seq: number
  type: string
  key: string | null
  name: string | null
  failed: number | null
  messageId: string | null
}
interface Bucket { summary: ProductActivityGroup, steps: ProductActivityStep[], active: Map<string, string>, openReasoning: Set<string> }
interface IndexedStep { bucket: Bucket, step: ProductActivityStep, occurrence: number, toolCallId: string, fromSequence: number | null, toSequence: number | null }
interface RunIndex {
  sequence: number
  revision: number
  rowid: number
  messageRevision: number
  queueRevision: number
  participantRevision: number
  after: string
  size: number
  lastGroup?: Bucket
  groups: Map<string, Bucket>
  latest: Map<string, IndexedStep>
  byStepId: Map<string, IndexedStep>
  reasoning: Map<string, Map<number, Bucket>>
  settled: Map<string, Set<Bucket>>
}
export interface ActivityIndex {
  work: number
  live: boolean
  summaries: () => ProductActivityGroup[]
  after: (messageId: string) => ProductActivityGroup | null
  latest: () => ProductActivityGroup | null
  groupForCall: (key: string) => ProductActivityGroup | null
  groupForReasoning: (messageId: string, contentIndex: number) => ProductActivityGroup | null
  settled: (messageId: string) => ProductActivityGroup[]
  steps: (groupId: string) => readonly ProductActivityStep[] | null
  resolveStep: (groupId: string, stepId: string) => { step: ProductActivityStep, toolCallId: string, fromSequence: number, toSequence: number | null } | null
}
export const visibleNarration = `(json_type(m.content_json) = 'text' AND length(trim(json_extract(m.content_json,'$'))) > 0
  OR coalesce(length(trim(json_extract(m.content_json,'$.text'))),0) > 0
  OR coalesce(json_array_length(m.content_json,'$.attachmentIds'),0) > 0
  OR json_extract(m.content_json,'$.state') = 'interrupted' OR json_extract(m.content_json,'$.truncated') = 1 OR ${hasProductTurnCommentarySql})`
const maxCalls = 32_768
export function turnKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
function safeName(name: unknown): string {
  return typeof name === 'string' && /^[\w.:-]{1,256}$/.test(name) ? name : 'tool'
}
function category(name: string): ProductActivityGroup['counts'][number]['category'] {
  if (['bash', 'powershell', 'lexora_shell', 'lexora_host_shell'].includes(name))
    return 'command'
  if (name === 'read' || name === 'lexora_session_read')
    return 'read'
  if (name === 'edit')
    return 'edit'
  if (name === 'write')
    return 'create'
  return 'other'
}
function bucketFor(run: TurnRun, ix: RunIndex, f: Fact) {
  const id = turnKey(['activity', run.id, ix.after])
  let bucket = ix.groups.get(id)
  if (!bucket) {
    bucket = { summary: { id, runId: run.id, afterMessageId: ix.after, createdAt: f.at, toolCount: 0, failedCount: 0, interruptedCount: 0, runningCount: 0, activeToolName: null, counts: [], reasoningCount: 0, runningReasoningCount: 0, interruptedReasoningCount: 0 }, steps: [], active: new Map(), openReasoning: new Set() }
    ix.groups.set(id, bucket)
    ix.lastGroup = bucket
  }
  return bucket
}
function apply(run: TurnRun, ix: RunIndex, f: Fact) {
  if (f.type === 'message.block.started' || f.type === 'message.block.completed') {
    if (!f.messageId || f.messageId.length > 256 || f.key === null || !Number.isSafeInteger(Number(f.key)) || Number(f.key) < 0)
      return
    const blocks = ix.reasoning.get(f.messageId) ?? new Map<number, Bucket>()
    const key = JSON.stringify([f.messageId, Number(f.key)])
    let group = blocks.get(Number(f.key))
    if (!group) {
      if (ix.size >= maxCalls)
        throw new ProductProtocolError('PAGE_TOO_LARGE')
      group = bucketFor(run, ix, f)
      blocks.set(Number(f.key), group)
      ix.reasoning.set(f.messageId, blocks)
      group.summary.reasoningCount++
      ix.size++
      if (f.type === 'message.block.started')
        group.openReasoning.add(key)
    }
    if (f.type === 'message.block.completed')
      group.openReasoning.delete(key)
    return
  }
  if (f.type === 'message.completed' || f.type === 'message.interrupted') {
    if (!f.messageId)
      return
    for (const [index, group] of ix.reasoning.get(f.messageId) ?? []) {
      if (!group.openReasoning.delete(JSON.stringify([f.messageId, index])))
        continue
      if (f.failed)
        group.summary.interruptedReasoningCount++
      const settled = ix.settled.get(f.messageId) ?? new Set<Bucket>()
      settled.add(group)
      ix.settled.set(f.messageId, settled)
    }
    return
  }
  if (f.type === 'boundary') {
    ix.after = f.messageId!
    return
  }
  if (!f.key || f.key.length > 256)
    return
  let entry = ix.latest.get(f.key)
  const begin = f.type === 'tool.started' || f.type === 'tool.preparing'
  if (!entry || (begin && entry.step.status !== 'running') || (f.type === 'result' && entry.step.messageId !== null && entry.step.messageId !== f.messageId)) {
    if (ix.size >= maxCalls)
      throw new ProductProtocolError('PAGE_TOO_LARGE')
    const bucket = bucketFor(run, ix, f)
    const occurrence = (entry?.occurrence ?? 0) + 1
    const step: ProductActivityStep = { id: turnKey([run.id, f.key, occurrence]), toolName: safeName(f.name), status: 'running', messageId: null }
    if (entry && entry.toSequence === null && f.seq > 0)
      entry.toSequence = f.seq - 1
    entry = { bucket, step, occurrence, toolCallId: f.key, fromSequence: f.type.startsWith('tool.') ? f.seq : null, toSequence: null }
    ix.byStepId.set(step.id, entry)
    ix.latest.set(f.key, entry)
    bucket.steps.push(step)
    bucket.active.set(step.id, step.toolName)
    bucket.summary.toolCount++
    const kind = category(step.toolName)
    const tally = bucket.summary.counts.find(x => x.category === kind)
    if (tally)
      tally.count++
    else bucket.summary.counts.push({ category: kind, count: 1 })
    ix.size++
  }
  const { bucket, step } = entry
  if (begin)
    return
  if (f.seq > 0)
    entry.toSequence = f.seq
  bucket.active.delete(step.id)
  if (f.messageId)
    step.messageId = f.messageId
  if (step.status === 'failed')
    return
  if (f.failed === 1 || f.type === 'tool.failed' || f.type === 'tool.denied') {
    step.status = 'failed'
    bucket.summary.failedCount++
  }
  else {
    step.status = 'completed'
  }
}

export class ProductTurnActivities {
  readonly #database: DatabaseSync
  readonly #cache = new Map<string, RunIndex>()
  #cachedCalls = 0
  constructor(database: DatabaseSync) {
    this.#database = database
  }

  read(run: TurnRun, conversationId: string, segment: VisibleConversationBranchSegment): ActivityIndex {
    const fork = segment.throughMessage
    const db = this.#database
    const forkEvent = fork && db.prepare(`SELECT e.sequence FROM conversation_publications p
      JOIN messages m ON m.id = p.message_id AND m.run_id = p.run_id AND m.role = 'assistant'
      JOIN run_events e ON e.run_id = p.run_id AND e.sequence = p.source_sequence
      WHERE p.kind = 'message' AND p.message_id = ? AND p.run_id = ? AND p.conversation_id = ? AND p.branch_id = ?
        AND e.event_type IN ('message.completed','message.interrupted') AND json_extract(e.payload_json,'$.messageId') = m.id`).get(fork.id, run.id, conversationId, run.branchId)
    const cutoff = Number(forkEvent?.sequence ?? 0)
    const key = JSON.stringify([run.id, run.triggerId, fork, cutoff])
    const head = fork ? cutoff : Number(db.prepare('SELECT MAX(sequence) AS n FROM run_events WHERE run_id = ?').get(run.id)?.n ?? 0)
    const rev = db.prepare('SELECT revision FROM product_query_revisions WHERE table_name = ? AND scope = ?')
    const branch = JSON.stringify(['branch', conversationId, run.branchId])
    const revision = fork && !cutoff ? 0 : Number(rev.get('run_events', JSON.stringify(['run', run.id]))?.revision ?? 0)
    const messageRevision = Number(rev.get('messages', branch)?.revision ?? 0)
    const queueRevision = Number(rev.get('chat_queue', branch)?.revision ?? 0)
    const participantRevision = Number(rev.get('run_history', branch)?.revision ?? 0)
    const rowid = Number(db.prepare('SELECT MAX(rowid) AS n FROM messages').get()?.n ?? 0)
    let ix = this.#cache.get(key)
    if (ix) {
      this.#cache.delete(key)
      this.#cachedCalls -= ix.size
      if (head < ix.sequence || revision - ix.revision !== head - ix.sequence || rowid < ix.rowid || queueRevision !== ix.queueRevision || participantRevision !== ix.participantRevision
        || (messageRevision !== ix.messageRevision && messageRevision - ix.messageRevision !== Number(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE rowid > ? AND conversation_id = ? AND branch_id = ?`).get(ix.rowid, conversationId, run.branchId)?.n))) {
        ix = undefined
      }
    }
    const cold = !ix
    ix ??= { sequence: 0, revision: 0, rowid: 0, messageRevision: 0, queueRevision: 0, participantRevision: 0, after: run.triggerId, size: 0, groups: new Map(), latest: new Map(), byStepId: new Map(), reasoning: new Map(), settled: new Map() }
    const eventSpan = head - ix.sequence
    const facts: Fact[] = []
    const resultSequences = new Map<string, number>()
    if (head > ix.sequence) {
      const events = db.prepare(`SELECT sequence AS seq, event_type AS type, created_at AS at,
        CASE WHEN event_type LIKE 'tool.%' THEN substr(json_extract(payload_json,'$.toolCallId'),1,257)
          WHEN event_type LIKE 'message.block.%' THEN json_extract(payload_json,'$.contentIndex') END AS key,
        CASE WHEN event_type LIKE 'tool.%' THEN substr(json_extract(payload_json,'$.toolName'),1,257) END AS name,
        CASE WHEN event_type = 'tool.completed' THEN json_extract(payload_json,'$.isError') WHEN event_type = 'message.interrupted' THEN 1
          WHEN event_type = 'message.completed' THEN json_extract(payload_json,'$.stopReason') IN ('failed','length') END AS failed,
        CASE WHEN event_type LIKE 'message.%' THEN substr(json_extract(payload_json,'$.messageId'),1,257) END AS messageId
        FROM run_events WHERE run_id = ? AND sequence > ? AND sequence <= ? AND (event_type IN ('tool.preparing','tool.started','tool.completed','tool.failed','tool.denied','message.tool_result','message.completed','message.interrupted')
          OR (event_type IN ('message.block.started','message.block.completed') AND json_extract(payload_json,'$.kind') = 'reasoning'))
        ORDER BY sequence LIMIT ?`)
      let visited = 0
      for (const row of events.iterate(run.id, ix.sequence, head, maxCalls * 6 + 1)) {
        if (++visited > maxCalls * 6)
          throw new ProductProtocolError('PAGE_TOO_LARGE')
        if (row.type === 'message.tool_result')
          resultSequences.set(String(row.messageId), Number(row.seq))
        else facts.push(row as unknown as Fact)
      }
    }
    if (cold || messageRevision !== ix.messageRevision) {
      const limit = fork ? 'AND (m.created_at,m.id) <= (?,?)' : ''
      const saved = db.prepare(`SELECT m.id AS messageId, m.created_at AS at, CASE WHEN m.role = 'tool' THEN 'result' ELSE 'boundary' END AS type,
        CASE WHEN m.role = 'tool' THEN substr(json_extract(m.content_json,'$.toolCallId'),1,257) END AS key,
        CASE WHEN m.role = 'tool' THEN substr(json_extract(m.content_json,'$.toolName'),1,257) END AS name,
        CASE WHEN m.role = 'tool' THEN json_extract(m.content_json,'$.isError') END AS failed,coalesce(p.source_sequence,0) AS seq
        FROM messages m LEFT JOIN conversation_publications p ON p.message_id = m.id AND p.run_id = m.run_id
        WHERE m.run_id IN (SELECT id FROM runs WHERE root_run_id = ? AND execution_kind IN ('root','actor_child') AND conversation_id = ? AND branch_id = ? UNION SELECT ?)
          AND m.rowid > ? AND m.conversation_id = ? AND m.branch_id = ? ${limit} AND (m.run_id = ? OR m.role = 'assistant')
          AND (m.role <> 'assistant' OR ${visibleNarration}) LIMIT ?`)
      let n = 0
      for (const row of saved.iterate(run.id, conversationId, run.branchId, run.id, ix.rowid, conversationId, run.branchId, ...(fork ? [fork.createdAt, fork.id] : []), run.id, maxCalls + 1)) {
        if (++n > maxCalls)
          throw new ProductProtocolError('PAGE_TOO_LARGE')
        const fact = row as unknown as Fact
        if (fact.type === 'result' && fact.messageId) {
          const sequence = resultSequences.get(fact.messageId)
          if (cutoff && sequence === undefined)
            continue
          fact.seq = sequence ?? fact.seq
        }
        facts.push(fact)
      }
      if (cold) {
        const steers = db.prepare(`SELECT m.id AS messageId,m.created_at AS at FROM chat_queue q JOIN messages m ON m.id = json_extract(q.prepared_json,'$.userMessageId')
          AND m.conversation_id = q.conversation_id AND m.branch_id = q.branch_id AND m.role = 'user'
          WHERE q.run_id = ? AND q.state = 'sent' AND q.conversation_id = ? AND q.branch_id = ? AND m.id <> ? ${limit} LIMIT ?`)
        let count = 0
        for (const s of steers.iterate(run.id, conversationId, run.branchId, run.triggerId, ...(fork ? [fork.createdAt, fork.id] : []), maxCalls + 1)) {
          if (++count > maxCalls)
            throw new ProductProtocolError('PAGE_TOO_LARGE')
          facts.push({ type: 'boundary', at: String(s.at), seq: 0, messageId: String(s.messageId), failed: null, key: null, name: null })
        }
      }
    }
    // A persisted tool message carries no publication sequence. At equal times it
    // follows the tool lifecycle; narration with a real source sequence keeps it.
    const order = (f: Fact) => f.seq || (f.type === 'result' ? Number.MAX_SAFE_INTEGER : 0)
    facts.sort((a, b) => a.at.localeCompare(b.at) || order(a) - order(b) || (a.messageId ?? '').localeCompare(b.messageId ?? ''))
    for (const f of facts) apply(run, ix, f)
    Object.assign(ix, { sequence: head, revision, rowid, messageRevision, queueRevision, participantRevision })
    this.#cache.set(key, ix)
    this.#cachedCalls += ix.size
    while (this.#cache.size > 128 || this.#cachedCalls > 65_536) {
      const first = this.#cache.keys().next().value!
      this.#cachedCalls -= this.#cache.get(first)!.size
      this.#cache.delete(first)
    }
    const live = fork ? cutoff > 0 && !db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND sequence <= ? AND event_type IN ('run.completed','run.failed','run.cancelled') LIMIT 1`).get(run.id, cutoff) : (run.status === 'queued' || run.status === 'running')
    const summary = (b: Bucket): ProductActivityGroup => ({ ...b.summary, counts: b.summary.counts.map(c => ({ ...c })), runningCount: live ? b.active.size : 0, interruptedCount: live ? 0 : b.active.size, runningReasoningCount: live ? b.openReasoning.size : 0, interruptedReasoningCount: b.summary.interruptedReasoningCount + (live ? 0 : b.openReasoning.size), activeToolName: live ? b.active.values().next().value ?? null : null })
    return {
      live,
      work: Math.max(eventSpan, facts.length),
      summaries: () => [...ix.groups.values()].map(summary),
      after(id) {
        const group = ix.groups.get(turnKey(['activity', run.id, id]))
        return group ? summary(group) : null
      },
      latest: () => ix.lastGroup ? summary(ix.lastGroup) : null,
      groupForCall(key) {
        const entry = ix.latest.get(key)
        return entry ? summary(entry.bucket) : null
      },
      groupForReasoning(messageId, contentIndex) {
        const group = ix.reasoning.get(messageId)?.get(contentIndex)
        return group ? summary(group) : null
      },
      settled(messageId) { return [...(ix.settled.get(messageId) ?? [])].map(summary) },
      steps(id) { return ix.groups.get(id)?.steps ?? null },
      resolveStep(groupId, stepId) {
        const entry = ix.byStepId.get(stepId)
        if (fork || !entry?.fromSequence || entry.bucket.summary.id !== groupId)
          return null
        const { step, toolCallId, fromSequence, toSequence } = entry
        return { step: { ...step, status: !live && step.status === 'running' ? 'interrupted' : step.status }, toolCallId, fromSequence, toSequence: toSequence ?? (live && step.status === 'running' ? null : ix.sequence) }
      },
    }
  }
}

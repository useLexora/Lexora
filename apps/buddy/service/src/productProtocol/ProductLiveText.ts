import type { DatabaseSync } from 'node:sqlite'
import type { ProductReadLiveTextInput } from '../../../shared/productProtocol/messageText'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { LIVE_TEXT_WINDOW_UNITS } from '../../../shared/productProtocol/messageText'
import { decodeSafeProductRevision } from '../../../shared/productProtocol/scalars'

interface State { sequence: number, total: number, tail: string, pending: string }
interface PageIndex { total: number, points: { sequence: number, offset: number }[] }
const empty = (sequence: number): State => ({ sequence, total: 0, tail: '', pending: '' })
const high = (text: string, index: number) => (text.charCodeAt(index) & 0xFC00) === 0xD800
const low = (text: string, index: number) => (text.charCodeAt(index) & 0xFC00) === 0xDC00
function tail(text: string) {
  const index = Math.max(0, text.length - LIVE_TEXT_WINDOW_UNITS)
  return text.slice(index > 0 && low(text, index) && high(text, index - 1) ? index + 1 : index)
}
function append(state: State, sequence: number, delta: string) {
  const raw = state.pending + delta
  const pending = high(raw, raw.length - 1) ? raw.slice(-1) : ''
  const visible = pending ? raw.slice(0, -1) : raw
  const added = tail(visible)
  return { state: { sequence, total: state.total + visible.length, tail: added.length < visible.length ? added : tail(state.tail + added), pending }, added }
}
function range(sequence: number, start: number, end: number, total = end) {
  return { revision: String(sequence), start, end, total }
}

export class ProductLiveText {
  readonly #cache = new Map<string, { first: number, state: State }>()
  readonly #pages = new Map<string, PageIndex>()
  readonly #database: DatabaseSync
  constructor(database: DatabaseSync) { this.#database = database }

  #id(runId: string, id: string) { return JSON.stringify([runId, id]) }
  #save(runId: string, id: string, first: number, state: State) {
    const key = this.#id(runId, id)
    const previous = this.#cache.get(key)
    if (previous && previous.first === first && previous.state.sequence > state.sequence)
      return
    this.#cache.delete(key)
    this.#cache.set(key, { first, state })
    if (this.#cache.size > 32)
      this.#cache.delete(this.#cache.keys().next().value!)
  }

  * #deltas(runId: string, id: string, after: number, through: number) {
    const rows = this.#database.prepare(`SELECT sequence, payload_json FROM run_events WHERE run_id = ? AND sequence > ? AND sequence <= ? AND event_type = 'message.delta' AND json_extract(payload_json, '$.messageId') = ? ORDER BY sequence`).iterate(runId, after, through, id)
    for (const row of rows) {
      const { delta } = JSON.parse(String(row.payload_json)) as { delta?: unknown }
      if (typeof delta === 'string')
        yield { sequence: Number(row.sequence), delta }
    }
  }

  #state(runId: string, id: string, first: number, through = Number.MAX_SAFE_INTEGER) {
    const cached = this.#cache.get(this.#id(runId, id))
    let state = cached?.first === first && cached.state.sequence <= through ? cached.state : empty(first)
    for (const { sequence, delta } of this.#deltas(runId, id, state.sequence, through)) state = append(state, sequence, delta).state
    this.#save(runId, id, first, state)
    return state
  }

  snapshot(runId: string, id: string, first: number) {
    const state = this.#state(runId, id, first)
    return { text: state.tail, range: range(state.sequence, state.total - state.tail.length, state.total) }
  }

  delta(runId: string, id: string, sequence: number) {
    const cached = this.#cache.get(this.#id(runId, id))
    const first = cached?.first ?? this.#database.prepare(`SELECT sequence FROM run_events WHERE run_id = ? AND event_type = 'message.started' AND json_extract(payload_json, '$.role') = 'assistant' AND json_extract(payload_json, '$.messageId') = ? ORDER BY sequence LIMIT 1`).get(runId, id)?.sequence
    if (typeof first !== 'number' || first >= sequence)
      return null
    const [event] = this.#deltas(runId, id, sequence - 1, sequence)
    if (!event)
      return null
    const previous = this.#state(runId, id, first, sequence - 1)
    const { state, added } = append(previous, sequence, event.delta)
    this.#save(runId, id, first, state)
    return { kind: 'textAppend' as const, messageId: id, previousRevision: String(previous.sequence), range: range(sequence, state.total - added.length, state.total), text: added }
  }

  #pageIndex(runId: string, id: string, first: number, through: number): PageIndex {
    const key = JSON.stringify([runId, id, first, through])
    const existing = this.#pages.get(key)
    if (existing)
      return existing
    let points = [{ sequence: first, offset: 0 }]
    let spacing = LIVE_TEXT_WINDOW_UNITS * 2
    let sequence = first
    let offset = 0
    let lastUnit = ''
    for (const event of this.#deltas(runId, id, first, through)) {
      sequence = event.sequence
      offset += event.delta.length
      if (event.delta.length)
        lastUnit = event.delta.at(-1)!
      if (offset - points.at(-1)!.offset >= spacing) {
        points.push({ sequence, offset })
        if (points.length > 128) {
          points = points.filter((_, index) => index % 2 === 0)
          spacing *= 2
        }
      }
    }
    if (sequence !== through)
      throw new ProductProtocolError('SOURCE_CHANGED')
    const page = { points, total: offset - Number(high(lastUnit, 0)) }
    this.#pages.set(key, page)
    if (this.#pages.size > 8)
      this.#pages.delete(this.#pages.keys().next().value!)
    return page
  }

  readBefore(input: ProductReadLiveTextInput) {
    const { conversationId, branchId, runId, messageId, revision, before } = input
    if (BigInt(revision) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ProductProtocolError('SOURCE_CHANGED')
    const through = decodeSafeProductRevision(revision)
    const row = this.#database.prepare(`SELECT e.sequence FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN run_events e ON e.run_id = r.id
      WHERE r.id = ? AND r.conversation_id = ? AND r.branch_id = ? AND r.execution_kind = 'root' AND r.status IN ('queued','running') AND c.deleted_at IS NULL
      AND e.event_type = 'message.started' AND json_extract(e.payload_json, '$.role') = 'assistant' AND json_extract(e.payload_json, '$.messageId') = ?
      AND EXISTS (SELECT 1 FROM run_events d WHERE d.run_id = r.id AND d.sequence = ? AND d.event_type = 'message.delta' AND json_extract(d.payload_json, '$.messageId') = ?)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM run_events t WHERE t.run_id = r.id AND t.event_type IN ('message.completed','message.interrupted') AND json_extract(t.payload_json,'$.messageId') = ?) LIMIT 1`).get(runId, conversationId, branchId, messageId, through, messageId, messageId, messageId)
    if (!row)
      throw new ProductProtocolError('SOURCE_CHANGED')
    const { total, points } = this.#pageIndex(runId, messageId, Number(row.sequence), through)
    if (before > total)
      throw new ProductProtocolError('SOURCE_CHANGED')
    const from = Math.max(0, before - LIVE_TEXT_WINDOW_UNITS - 1)
    const point = points.findLast(point => point.offset <= from)!
    let fragment = ''
    let offset = point.offset
    for (const { delta } of this.#deltas(runId, messageId, point.sequence, through)) {
      const end = offset + delta.length
      if (end > from)
        fragment += delta.slice(Math.max(0, from - offset), Math.max(0, before + 1 - offset))
      offset = end
      if (offset > before)
        break
    }
    const end = before - from
    if (high(fragment, end - 1) && low(fragment, end))
      throw new ProductProtocolError('INVALID_PARAMS')
    const text = tail(fragment.slice(0, end))
    return { range: range(through, before - text.length, before, total), text }
  }
}

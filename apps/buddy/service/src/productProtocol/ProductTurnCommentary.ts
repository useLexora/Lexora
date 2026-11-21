import type { DatabaseSync } from 'node:sqlite'
import type { ProductReadSavedTextInput } from '../../../shared/productProtocol/messageText'
import type { MessageRecord } from '../storage/conversationHistoryRepository'
import { redactSensitiveText } from '../../../shared/permissions/approvalReviewPayload'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { LIVE_TEXT_WINDOW_UNITS } from '../../../shared/productProtocol/messageText'

const previewUnits = 2048

const publicFinal = `SELECT e.sequence FROM conversation_publications p
  JOIN runs r ON r.id = p.run_id AND r.conversation_id = p.conversation_id AND r.branch_id = p.branch_id
  JOIN conversations c ON c.id = r.conversation_id JOIN run_events e ON e.run_id = r.id AND e.sequence = p.source_sequence
  WHERE p.kind = 'message' AND r.execution_kind = 'root' AND c.deleted_at IS NULL AND e.event_type = 'message.completed'
    AND json_extract(e.payload_json,'$.role') = 'assistant' AND json_extract(e.payload_json,'$.phase') = 'final_answer'
    AND json_extract(e.payload_json,'$.messageId') = p.message_id`
const commentaryBlock = `event_type = 'message.block.completed' AND json_extract(payload_json,'$.kind') = 'text'
  AND json_extract(payload_json,'$.phase') = 'commentary' AND json_type(payload_json,'$.content') = 'text'
  AND json_type(payload_json,'$.contentIndex') = 'integer' AND json_extract(payload_json,'$.contentIndex') >= 0`

// A root has one Pi message in flight; an end-only recovery may lack its start.
function boundaryQuery(runId: string, sequence: string, messageId: string) {
  return `SELECT b.sequence FROM run_events b WHERE b.run_id = ${runId} AND b.sequence < ${sequence} AND (
    (b.event_type = 'message.started' AND json_extract(b.payload_json,'$.messageId') = ${messageId}) OR
    (b.event_type = 'message.completed' AND json_extract(b.payload_json,'$.role') = 'assistant')) ORDER BY b.sequence DESC LIMIT 1`
}

export const hasProductTurnCommentarySql = `EXISTS (${publicFinal} AND p.message_id = m.id AND p.run_id = m.run_id
  AND p.conversation_id = m.conversation_id AND p.branch_id = m.branch_id AND EXISTS (
    SELECT 1 FROM run_events WHERE run_id = e.run_id AND sequence < e.sequence AND ${commentaryBlock}
    AND sequence > coalesce((${boundaryQuery('e.run_id', 'e.sequence', 'm.id')}),0)
    AND json_extract(payload_json,'$.messageId') = m.id AND json_extract(payload_json,'$.content') <> ''))`

function publicFinalSequence(db: DatabaseSync, message: MessageRecord) {
  if (message.role !== 'assistant' || !message.runId)
    return null
  const row = db.prepare(`${publicFinal} AND p.message_id = ? AND p.run_id = ? AND p.conversation_id = ? AND p.branch_id = ?`).get(message.id, message.runId, message.conversationId, message.branchId)
  return typeof row?.sequence === 'number' ? row.sequence : null
}

function* commentaryPieces(db: DatabaseSync, message: MessageRecord, sequence: number) {
  const { id, runId } = message
  if (!runId)
    return
  const boundary = db.prepare(boundaryQuery('?', '?', '?')).get(runId, sequence, id)
  const blocks = db.prepare(`SELECT max(sequence) AS seq FROM run_events WHERE run_id = ? AND sequence > ? AND sequence < ?
    AND ${commentaryBlock} AND json_extract(payload_json,'$.messageId') = ?
    GROUP BY json_extract(payload_json,'$.contentIndex') ORDER BY json_extract(payload_json,'$.contentIndex')`)
  const body = db.prepare('SELECT payload_json FROM run_events WHERE run_id = ? AND sequence = ?')
  let separated = false
  for (const { seq } of blocks.iterate(runId, boundary?.sequence ?? 0, sequence, id)) {
    const row = body.get(runId, seq)!
    const { content } = JSON.parse(String(row.payload_json)) as { content: string }
    if (!content)
      continue
    if (separated)
      yield '\n\n'
    separated = true
    yield redactSensitiveText(content)
  }
}

function splitsPair(text: string, at: number) {
  return at > 0 && at < text.length && (text.charCodeAt(at - 1) & 0xFC00) === 0xD800 && (text.charCodeAt(at) & 0xFC00) === 0xDC00
}

export function readProductTurnCommentary(db: DatabaseSync, message: MessageRecord) {
  const sequence = publicFinalSequence(db, message)
  if (!sequence)
    return undefined
  let tail = ''
  let total = 0
  for (const piece of commentaryPieces(db, message, sequence)) {
    total += piece.length
    tail = (tail + piece.slice(-previewUnits - 1)).slice(-previewUnits - 1)
  }
  if (!total)
    return undefined
  let start = Math.max(0, tail.length - previewUnits)
  if (splitsPair(tail, start))
    start++
  const text = tail.slice(start)
  return { text, range: { revision: `c:${sequence}`, start: total - text.length, end: total, total } }
}

export function readProductTurnCommentaryPage(db: DatabaseSync, message: MessageRecord, input: ProductReadSavedTextInput) {
  const sequence = publicFinalSequence(db, message)
  if (!sequence || input.revision !== `c:${sequence}`)
    throw new ProductProtocolError('SOURCE_CHANGED')
  const before = input.direction === 'before'
  const from = before ? Math.max(0, input.offset - LIVE_TEXT_WINDOW_UNITS) : input.offset
  const to = before ? input.offset : input.offset + LIVE_TEXT_WINDOW_UNITS
  const padded = Math.max(0, from - 1)
  let total = 0
  let window = ''
  for (const piece of commentaryPieces(db, message, sequence)) {
    if (total + piece.length > padded && total <= to)
      window += piece.slice(Math.max(0, padded - total), Math.max(0, to + 1 - total))
    total += piece.length
  }
  if (!total)
    throw new ProductProtocolError('SOURCE_CHANGED')
  if (input.offset > total || splitsPair(window, input.offset - padded))
    throw new ProductProtocolError('INVALID_PARAMS')
  const start = from + Number(splitsPair(window, from - padded))
  const end = Math.min(total, to) - Number(splitsPair(window, to - padded))
  return { text: window.slice(start - padded, end - padded), range: { revision: input.revision, start, end, total } }
}

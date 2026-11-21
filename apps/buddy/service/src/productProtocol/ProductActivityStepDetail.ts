import type { DatabaseSync } from 'node:sqlite'
import type { ProductReadActivityStepDetailInput } from '../../../shared/productProtocol/activityStepDetail'
import type { BuddyToolPresentation } from '../../../shared/runs/runEventPresentation'
import type { ProductTurnWindow } from './ProductTurnWindow'
import { createHash } from 'node:crypto'
import { redactSensitiveText, redactShellCommand } from '../../../shared/permissions/approvalReviewPayload'
import { STEP_DETAIL_TEXT_LIMIT } from '../../../shared/productProtocol/activityStepDetail'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { buddyToolPresentationDeltaSchema, buddyToolPresentationSchema } from '../../../shared/runs/runEventPresentation'

const recentSequences = 128
const maxDeltas = 24
const maxPublishedOutput = 64 * 1024
const identity = `run_id = ? AND sequence BETWEEN ? AND ? AND event_type IN ('tool.preparing','tool.started','tool.updated','tool.completed')
  AND json_extract(payload_json,'$.toolCallId') = ? AND json_extract(payload_json,'$.toolName') = ?`

function display(p: BuddyToolPresentation, output: string | null) {
  const fields: string[] = []
  if ('description' in p && p.description)
    fields.push(redactSensitiveText(p.description))
  if (p.card === 'terminal' && p.command)
    fields.push(redactSensitiveText(redactShellCommand(p.command)))
  if ('path' in p && p.path)
    fields.push(redactSensitiveText(p.path))
  if ('status' in p && p.status)
    fields.push(redactSensitiveText(p.status))
  if (p.card === 'diff' && p.diff)
    fields.push(redactSensitiveText(p.diff))
  if (output)
    fields.push(redactSensitiveText(output))
  return fields.join('\n\n')
}

export function readActivityStepDetail(db: DatabaseSync, turns: ProductTurnWindow, input: ProductReadActivityStepDetailInput) {
  const match = turns.resolveStep(input)
  if (!match)
    throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
  const { step, toolCallId, fromSequence, toSequence } = match
  const end = toSequence ?? Number(db.prepare('SELECT MAX(sequence) AS n FROM run_events WHERE run_id = ?').get(input.runId)?.n ?? 0)
  const recent = Math.max(fromSequence, end - recentSequences + 1)
  const scope = (from: number, to: number) => [input.runId, from, to, toolCallId, step.toolName] as const
  // Only the exact opening event and a fixed PK range are eligible. A very busy run
  // may lose part of the preview, never trigger a transcript replay to fill the gap.
  const full = db.prepare(`SELECT sequence, CASE WHEN length(CAST(json_extract(payload_json,'$.presentation') AS BLOB)) <= 1048576
    THEN json_extract(payload_json,'$.presentation') END AS data FROM run_events WHERE ${identity}
    AND json_type(payload_json,'$.presentation') = 'object' ORDER BY sequence DESC LIMIT 1`)
  let row = full.get(...scope(recent, end))
  if (!row && recent > fromSequence)
    row = full.get(...scope(fromSequence, fromSequence))
  let text = ''
  let truncated = false
  const p = buddyToolPresentationSchema.safeParse(typeof row?.data === 'string' ? JSON.parse(row.data) : null)
  if (p.success) {
    let output = 'output' in p.data ? p.data.output : null
    truncated = 'truncated' in p.data && p.data.truncated
    const sequence = Number(row!.sequence)
    if (sequence + 1 < recent)
      truncated = true
    if (p.data.card === 'terminal' && sequence < end) {
      const deltaRows = db.prepare(`SELECT CASE WHEN length(CAST(json_extract(payload_json,'$.presentationDelta') AS BLOB)) <= 400000
        THEN json_extract(payload_json,'$.presentationDelta') END AS data FROM run_events WHERE ${identity}
        AND event_type = 'tool.updated' AND json_type(payload_json,'$.presentationDelta') = 'object' ORDER BY sequence DESC LIMIT ?`)
      const chunks: string[] = []
      let start: number | undefined
      let size = 0
      for (const d of deltaRows.iterate(...scope(Math.max(sequence + 1, recent), end), maxDeltas)) {
        const delta = buddyToolPresentationDeltaSchema.safeParse(typeof d.data === 'string' ? JSON.parse(d.data) : null)
        if (!delta.success || size + delta.data.outputDelta.length > maxPublishedOutput || (start !== undefined && delta.data.outputStart + delta.data.outputDelta.length !== start)) {
          truncated = true
          break
        }
        start = delta.data.outputStart
        size += delta.data.outputDelta.length
        chunks.push(delta.data.outputDelta)
        truncated ||= delta.data.truncated
      }
      const suffix = chunks.reverse().join('')
      if (start === (output?.length ?? 0)) {
        output = (output ?? '') + suffix
      }
      else if (start !== undefined) {
        // A partial first line can start inside a credential. Never expose it.
        const newline = suffix.indexOf('\n')
        if (newline >= 0)
          output = suffix.slice(newline + 1)
        truncated = true
      }
    }
    const formatted = display(p.data, output)
    if (formatted.length <= STEP_DETAIL_TEXT_LIMIT) {
      text = formatted
    }
    else {
      const half = STEP_DETAIL_TEXT_LIMIT / 2
      text = `${formatted.slice(0, half).replace(/[\uD800-\uDBFF]$/, '')}\n…\n${formatted.slice(3 - half).replace(/^[\uDC00-\uDFFF]/, '')}`
      truncated = true
    }
  }
  const revision = createHash('sha256').update(JSON.stringify([step.id, step.status, step.messageId, text, truncated])).digest('hex')
  return { stepId: step.id, messageId: step.messageId, status: step.status, available: !!text, truncated, revision, text: (input.knownRevision === revision || !text) ? null : text }
}

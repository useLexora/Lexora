import type { DatabaseSync } from 'node:sqlite'
import type { ProductActivityStep } from '../../../shared/productProtocol/turns'
import { redactSensitiveText, redactShellCommand } from '../../../shared/permissions/approvalReviewPayload'
import { buddyToolPresentationSchema } from '../../../shared/runs/runEventPresentation'

interface Observation { fromSequence: number | null, observationSequence: number | null, toolCallId: string }
export function isActivityCommand(name: string) {
  return ['bash', 'powershell', 'lexora_shell', 'lexora_host_shell'].includes(name)
}

function singleLine(text: string) {
  return redactSensitiveText(text).trim().split(/[\r\n\u2028\u2029]/u, 1)[0]!.replace(/\s+/gu, ' ').trim().slice(0, 240).replace(/[\uD800-\uDBFF]$/, '')
}

// A published command can still contain literal stdin, an inline script or an
// unlabelled credential. Keep the executable and recognisable CLI syntax, not operands.
const publicSyntax = new Set('add apk build check clean diff exec fix fmt format get help install lint lint:fix list log ls pull push run show stat status test type-check version --all --help --oneline --short --stat --version -a -l -la -n -v'.split(' '))
function commandSummary(command: string) {
  const [program, ...words] = singleLine(redactShellCommand(command)).split(' ')
  if (!program || !/^[a-z][\w.-]{0,63}$/i.test(program))
    return undefined
  const parts = [program]
  for (const word of words) {
    if (!publicSyntax.has(word) && !/^--?(?:api[-_]?key|token|secret|password|credential|authorization)=\[redacted\]$/i.test(word)) {
      parts.push('…')
      break
    }
    parts.push(word)
  }
  return parts.join(' ').slice(0, 240)
}

export function withActivityStepSummaries(db: DatabaseSync, runId: string, page: ProductActivityStep[], index: ReadonlyMap<string, Observation>): ProductActivityStep[] {
  const selected = new Map<number, { step: ProductActivityStep, toolCallId: string }>()
  for (const step of page) {
    const entry = index.get(step.id)
    if (!entry)
      continue
    for (const seq of [entry.fromSequence, entry.observationSequence]) {
      if (seq !== null)
        selected.set(seq, { step, toolCallId: entry.toolCallId })
    }
  }
  if (!selected.size)
    return page

  // One batch of exact lifecycle PKs from the visible page; oversized events
  // fall back to the name. Never replay updates or read saved tool resources.
  const rows = db.prepare(`SELECT sequence, json_extract(payload_json,'$.toolName') AS name,
    json_extract(payload_json,'$.toolCallId') AS callId,
    CASE WHEN json_type(payload_json,'$.toolLabel') = 'text' THEN json_extract(payload_json,'$.toolLabel') END AS label,
    CASE WHEN json_extract(payload_json,'$.presentation.card') = 'terminal' AND json_type(payload_json,'$.presentation.output') IN ('text','null')
      THEN json_replace(json_extract(payload_json,'$.presentation'),'$.output',NULL) END AS terminal
    FROM run_events WHERE run_id = ? AND sequence IN (SELECT value FROM json_each(?))
    AND event_type IN ('tool.preparing','tool.started','tool.completed') AND octet_length(payload_json) <= 16384
    ORDER BY sequence`)
  const summaries = new Map<string, string>()
  for (const row of rows.iterate(runId, JSON.stringify([...selected.keys()]))) {
    const { step, toolCallId } = selected.get(Number(row.sequence))!
    if (row.name !== step.toolName || row.callId !== toolCallId || summaries.has(step.id))
      continue
    let summary: string | undefined
    if (isActivityCommand(step.toolName)) {
      const p = typeof row.terminal === 'string' && buddyToolPresentationSchema.safeParse(JSON.parse(row.terminal))
      if (p && p.success && p.data.card === 'terminal')
        summary = commandSummary(p.data.command)
    }
    else if (typeof row.label === 'string') {
      summary = singleLine(row.label)
    }
    if (summary)
      summaries.set(step.id, summary)
  }
  return page.map(step => summaries.has(step.id) ? { ...step, summary: summaries.get(step.id)! } : step)
}

import { modelFailureFeedback } from '../../../shared/providers/modelFailureFeedback'

export interface RunModelFailureRow {
  code: string | null
  launchFailureJson: string | null
}

export const runModelFailureColumns = `runs.error_code AS code,
  (SELECT CASE WHEN json_extract(terminal.payload_json, '$.errorCode') = runs.error_code
    AND json_type(terminal.payload_json, '$.launchFailure') = 'object' THEN json_extract(terminal.payload_json, '$.launchFailure') END
   FROM run_events terminal WHERE terminal.run_id = runs.id AND terminal.event_type = 'run.failed'
   ORDER BY terminal.sequence DESC LIMIT 1) AS launchFailureJson`

export function storedModelFailure(row: RunModelFailureRow | undefined) {
  return row && modelFailureFeedback(row.code, row.launchFailureJson ? JSON.parse(row.launchFailureJson) : undefined)
}

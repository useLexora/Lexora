import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { RunRepository } from '../storage/runRepository'
import type { RunEventObservation } from './RunEventPorts'
import { diagnosticIdentitySchema, safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'

export function observeRunDiagnostics(
  eventLog: Pick<RunEventObservation, 'onDidCommit'>,
  runs: Pick<RunRepository, 'findById'>,
  report: ApplicationDiagnosticReporter,
) {
  const record = safeDiagnosticReporter(report)
  return eventLog.onDidCommit((event) => {
    if (!['run.started', 'run.completed', 'run.failed', 'run.cancelled', 'tool.started', 'tool.completed', 'approval.requested', 'approval.resolved', 'approval.reused'].includes(event.type))
      return
    const run = runs.findById(event.runId)
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : null
    const toolCallId = diagnosticIdentitySchema.safeParse(payload?.toolCallId)
    const approvalId = diagnosticIdentitySchema.safeParse(event.type === 'approval.reused' ? payload?.sourceApprovalId : event.type.startsWith('approval.') ? payload?.id : undefined)
    const type = event.type === 'tool.completed' && payload?.isError === true
      ? 'tool.failed'
      : event.type === 'approval.resolved' && ['approved', 'denied', 'cancelled'].includes(String(payload?.status))
        ? `approval.resolved.${payload?.status}`
        : event.type
    record({
      event: type,
      level: type === 'run.failed' || type === 'tool.failed' ? 'error' : 'info',
      runId: event.runId,
      revision: event.sequence,
      occurredAt: event.createdAt,
      conversationId: run?.conversationId,
      branchId: run?.branchId,
      ...(toolCallId.success ? { toolCallId: toolCallId.data } : {}),
      ...(approvalId.success ? { operationId: approvalId.data } : {}),
      ...(run?.errorCode ? { errorCode: run.errorCode } : {}),
      ...(run?.completedAt ? { durationMs: Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)) } : {}),
    })
  })
}

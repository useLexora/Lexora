import type { ApplicationDiagnosticReporter } from '../../../../../shared/diagnostics/applicationDiagnostic'
import type { SessionToolCapabilities } from './SessionToolCapabilities'
import { safeDiagnosticReporter } from '../../../../../shared/diagnostics/applicationDiagnostic'

export function observeSessionTools(source: Pick<SessionToolCapabilities, 'onDidChange'>, conversationId: string, getRunId: () => string | undefined, report?: ApplicationDiagnosticReporter) {
  const record = safeDiagnosticReporter(report ?? (() => {}))
  return source.onDidChange(event => record({ event: `session.tools.${event.kind.replaceAll('-', '_')}.${event.reason}`, level: event.kind === 'application-failed' ? 'warn' : 'info', operationId: event.snapshot.instanceId, conversationId, runId: getRunId(), revision: event.snapshot.revision, count: event.kind === 'disclosure-changed' ? event.snapshot.discovered.length : event.snapshot.active.length }))
}

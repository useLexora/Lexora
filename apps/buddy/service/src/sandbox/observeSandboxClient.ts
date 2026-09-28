import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ShellSandboxClient } from './ShellSandboxClient'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'

export function observeSandboxClient(source: Pick<ShellSandboxClient, 'onDidChange'>, report: ApplicationDiagnosticReporter) {
  const record = safeDiagnosticReporter(report)
  return source.onDidChange((event) => {
    const kind = event.kind === 'backend' ? `backend.${event.event.kind}` : event.kind
    const result = event.kind === 'returned' ? event.result : event.kind === 'backend' ? event.event.snapshot.result : undefined
    record({
      event: `sandbox.${kind.replaceAll('-', '_')}`,
      level: event.kind === 'transport-failed' || result?.ok === false ? 'warn' : 'info',
      requestId: event.requestId,
      revision: event.revision,
      ...(event.kind === 'backend' ? { count: event.event.snapshot.waiting, sourceSequence: event.event.revision } : {}),
      ...(result?.ok === false ? { errorCode: result.code } : {}),
      ...(event.kind === 'transport-failed' ? { errorCode: 'SANDBOX_TRANSPORT_FAILED' } : {}),
    })
  })
}

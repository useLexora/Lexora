import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { EventContext } from '../../../shared/observability/ApplicationEvents'
import type { ShellSandboxClient } from './ShellSandboxClient'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { diagnosticContext } from '../diagnostics/diagnosticContext'

export function observeSandboxClient(source: Pick<ShellSandboxClient, 'onDidChange'>, report: ApplicationDiagnosticReporter) {
  const record = safeDiagnosticReporter(report)
  const contexts = new Map<string, EventContext>()
  const subscription = source.onDidChange((event) => {
    if (event.kind === 'requested' && contexts.size < 64)
      contexts.set(event.requestId, { ...diagnosticContext.getStore() })
    const kind = event.kind === 'backend' ? `backend.${event.event.kind}` : event.kind
    const cleanupFailed = event.kind === 'backend' && event.event.snapshot.process?.phase === 'cleanup_failed'
    const result = event.kind === 'returned' ? event.result : event.kind === 'backend' ? event.event.snapshot.result : undefined
    record({
      ...contexts.get(event.requestId),
      event: `sandbox.${kind.replaceAll('-', '_')}`,
      level: event.kind === 'transport-failed' || result?.ok === false || cleanupFailed ? 'warn' : 'info',
      requestId: event.requestId,
      revision: event.revision,
      ...(event.kind === 'backend' ? { count: event.event.snapshot.waiting, sourceSequence: event.event.revision, sandboxProcess: event.event.snapshot.process } : {}),
      ...(cleanupFailed ? { errorCode: 'SANDBOX_CLEANUP_FAILED' } : {}),
      ...(result?.ok === false ? { errorCode: result.code } : {}),
      ...(event.kind === 'transport-failed' ? { errorCode: 'SANDBOX_TRANSPORT_FAILED' } : {}),
    })
    if (event.kind === 'returned' || event.kind === 'transport-failed')
      contexts.delete(event.requestId)
  })
  return { dispose: () => {
    subscription.dispose()
    contexts.clear()
  } }
}

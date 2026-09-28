import type { ApplicationDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { Event } from '../../../../shared/events/Emitter'
import type { SessionResourceChange } from './SessionResourceReconciler'
import { safeDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'

export function observeSessionResourceDiagnostics(source: { onDidChange: Event<SessionResourceChange> }, report: ApplicationDiagnosticReporter) {
  const record = safeDiagnosticReporter(report)
  return source.onDidChange((event) => {
    if (event.type === 'external-invalidation') {
      record({ event: `sessions.resources.${event.source}_invalidation`, component: 'runtime.sessions', level: event.result.degraded ? 'warn' : 'debug', count: event.result.matched })
      return
    }
    if (event.type === 'applied') {
      record({ event: 'sessions.resources.applied', component: 'runtime.sessions', level: 'debug', sessionId: event.sessionId, generation: event.resourceRevision })
      return
    }
    record({
      event: event.type === 'resolution-failed' ? 'sessions.resources.resolution_failed' : `sessions.resources.${event.type}`,
      component: 'runtime.sessions',
      level: event.scope.status === 'degraded' ? 'warn' : 'debug',
      count: event.scope.pending + event.scope.degraded,
      ...(event.type === 'resolution-failed' ? { errorCode: event.error } : {}),
    })
  })
}

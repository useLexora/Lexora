import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { WebCapabilityService } from './WebCapabilityService'
import type { WebHostClient } from './WebHostClient'

export function observeWebDiagnostics(service: WebCapabilityService, report: ApplicationDiagnosticReporter) {
  return service.onDidChange(change => report({
    event: `web.${change.kind}.${change.phase.replaceAll('-', '_')}${change.outcome ? `_${change.outcome}` : ''}${change.cancelled ? '_after_cancel' : ''}`,
    component: 'runtime.web',
    level: change.errorCode || change.outcome === 'failed' ? 'warn' : 'info',
    operationId: change.operationId,
    revision: change.revision,
    ...(change.provider ? { providerId: change.provider } : {}),
    ...(change.errorCode ? { errorCode: change.errorCode } : {}),
    ...(change.count === undefined ? {} : { count: change.count }),
    ...(change.attempt === undefined ? {} : { attempt: change.attempt }),
    ...(change.durationMs === undefined ? {} : { durationMs: change.durationMs }),
  }))
}

export function observeWebHostDiagnostics(client: WebHostClient, report: ApplicationDiagnosticReporter) {
  return client.onDidChange(change => report({
    event: `web.transport.${change.kind}.${change.phase.replaceAll('-', '_')}${change.outcome ? `_${change.outcome}` : ''}${change.cancelled ? '_after_cancel' : ''}`,
    component: 'runtime.web_host',
    level: change.outcome === 'unknown' || change.outcome === 'rejected' || change.phase === 'cancel-unconfirmed' ? 'warn' : 'info',
    requestId: change.requestId,
    revision: change.revision,
    ...(change.count === undefined ? {} : { count: change.count }),
  }))
}

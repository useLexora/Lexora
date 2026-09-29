import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ExtensionAgentRuntime } from './ExtensionAgentRuntime'

export function observeExtensionAgentDiagnostics(service: ExtensionAgentRuntime, report: ApplicationDiagnosticReporter) {
  return service.onDidChange((change) => {
    if (change.kind === 'capabilities') {
      report({ event: `plugins.capabilities.${change.projection.status}`, level: change.projection.status === 'unavailable' ? 'warn' : 'info', operationId: change.projection.id, conversationId: change.projection.conversationId, revision: change.projection.revision, count: change.projection.descriptors.length })
    }
    else if (change.kind === 'invocation') {
      report({ event: `plugins.invocation.${change.stage}`, level: change.outcome === 'failed' ? 'warn' : 'info', extensionId: change.extensionId, operationId: change.invocationId, runId: change.runId ?? undefined, conversationId: change.conversationId, ...(change.durationMs === undefined ? {} : { durationMs: change.durationMs }), ...(change.outcome === 'failed' ? { errorCode: 'EXTENSION_AGENT_FAILED' } : change.outcome === 'cancelled' ? { errorCode: 'EXTENSION_AGENT_CANCELLED' } : {}) })
    }
    else if (change.kind === 'request') {
      report({ event: `plugins.request.${change.stage}`, level: change.response === 'failed' ? 'warn' : 'info', extensionId: change.extensionId, operationId: change.invocationId, requestId: change.requestId, runId: change.runId ?? undefined, conversationId: change.conversationId, method: change.method, ...(change.durationMs === undefined ? {} : { durationMs: change.durationMs }), ...(change.handler === 'failed' ? { errorCode: 'EXTENSION_REQUEST_FAILED' } : change.response === 'cancelled' ? { errorCode: 'EXTENSION_RESPONSE_CANCELLED' } : {}) })
    }
  })
}

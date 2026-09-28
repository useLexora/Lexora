import type { ConnectorChangeNotice } from '../../../../shared/connectors/connectorApi'
import type { ApplicationDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { McpConnectorService } from './McpConnectorService'
import { safeDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'

export function observeMcpDiagnostics(service: McpConnectorService, report: ApplicationDiagnosticReporter) {
  const record = safeDiagnosticReporter(report)
  const subscriptions = [
    service.onDidChange((event) => {
      const common = { component: 'runtime.connectors', connectorId: event.connectorId, producerInstanceId: event.sourceId, sourceSequence: event.revision, generation: String(event.generation) }
      if (event.type === 'configuration')
        record({ ...common, event: `connectors.configuration.${event.kind}`, level: 'info' })
      else if (event.type === 'credential')
        record({ ...common, event: `connectors.credential.${event.status.replaceAll('-', '_')}`, level: event.status === 'restore-failed' ? 'warn' : 'debug' })
      else
        record({ ...common, event: `connectors.login.${event.status}`, level: event.status === 'failed' ? 'warn' : 'info', operationId: event.operationId, ...(event.errorCode ? { errorCode: event.errorCode } : {}) })
    }),
    service.onDidChangeConnection((event) => {
      const common = { component: 'runtime.connectors', connectorId: event.connectorId, producerInstanceId: event.sourceId, sourceSequence: event.revision, generation: String(event.generation) }
      if (event.type === 'state')
        record({ ...common, event: `connectors.connection.${event.snapshot.status}`, level: event.snapshot.errorCode ? 'warn' : 'debug', ...(event.snapshot.errorCode ? { errorCode: event.snapshot.errorCode } : {}) })
      else if (event.type === 'catalog')
        record({ ...common, event: 'connectors.catalog.accepted', level: 'debug', count: event.tools.length })
      else if (event.type === 'cleanup')
        record({ ...common, event: `connectors.cleanup.${event.status}`, level: event.status === 'degraded' ? 'warn' : 'debug' })
      else if (event.type === 'availability')
        record({ ...common, event: `connectors.availability.${event.available ? 'available' : 'unavailable'}`, level: 'debug' })
      else
        record({ ...common, event: 'connectors.generation.changed', level: 'debug' })
    }),
  ]
  return { dispose: () => subscriptions.forEach(subscription => subscription.dispose()) }
}

export function observeMcpNotifications(service: McpConnectorService, notify: (event: ConnectorChangeNotice) => void) {
  const subscriptions = [
    service.onDidChange(event => notify(Object.freeze({ sourceId: event.sourceId, revision: event.revision, generation: event.generation, connectorId: event.connectorId, type: event.type }))),
    service.onDidChangeConnection((event) => {
      if (event.type === 'cleanup')
        return
      notify(Object.freeze({ sourceId: event.sourceId, revision: event.revision, generation: event.generation, connectorId: event.connectorId, type: event.type === 'catalog' ? 'catalog' : 'runtime' }))
    }),
  ]
  return { dispose: () => subscriptions.forEach(subscription => subscription.dispose()) }
}

import type { ApplicationDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import type { ExtensionService } from './ExtensionService'

export function observeExtensionDiagnostics(service: ExtensionService, report: ApplicationDiagnosticReporter) {
  return service.onDidChange((change) => {
    const common = { revision: change.revision, component: 'desktop.extensions', ...('extensionId' in change ? { extensionId: change.extensionId } : {}) }
    switch (change.kind) {
      case 'package':
        report({ ...common, event: `extensions.package.${change.action}`, level: 'info' })
        break
      case 'enabled':
        report({ ...common, event: change.enabled ? 'extensions.enabled' : 'extensions.disabled', level: 'info' })
        break
      case 'resources-revoked':
        report({ ...common, event: 'extensions.resources.revoked', level: 'info' })
        break
      case 'configuration':
        report({ ...common, event: `extensions.configuration.${change.application.status.replaceAll('-', '_')}`, level: change.errorCode ? 'warn' : 'info', operationId: change.application.operationId, ...(change.application.generation ? { generation: change.application.generation } : {}), count: change.changedKeys.length, ...(change.errorCode ? { errorCode: change.errorCode } : {}) })
        break
      case 'host':
        report({ ...common, event: `extensions.host.${change.status.replaceAll('-', '_')}`, level: change.errorCode ? 'error' : 'info', generation: change.generation, ...(change.errorCode ? { errorCode: change.errorCode } : {}), ...(change.durationMs === undefined ? {} : { durationMs: change.durationMs }) })
        break
      case 'view':
        report({ ...common, event: `extensions.view.${change.status.replaceAll('-', '_')}`, level: change.errorCode ? 'warn' : 'info', generation: change.generation, ...(change.errorCode ? { errorCode: change.errorCode } : {}) })
        break
      case 'contributions':
        report({ ...common, event: 'extensions.contributions.accepted', level: 'info', count: change.descriptors.length })
        break
      case 'diagnostic':
        if (change.event === 'schedule.failed')
          report({ ...common, event: 'extensions.schedule.failed', level: 'warn', ...(change.errorCode ? { errorCode: change.errorCode } : {}) })
        break
    }
  })
}

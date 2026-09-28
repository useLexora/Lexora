import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { BrowserCapabilityService } from './BrowserCapabilityService'

export function observeBrowserCapabilityDiagnostics(service: BrowserCapabilityService, report: ApplicationDiagnosticReporter) {
  return service.onDidChange((change) => {
    if ('phase' in change) {
      report({
        event: `browser.client.${change.kind}.${change.phase.replaceAll('-', '_')}${change.cancelled ? '_after_cancel' : ''}`,
        component: 'runtime.browser',
        level: change.phase.endsWith('unknown') || change.accepted === false ? 'warn' : 'info',
        operationId: change.operationId,
        revision: change.revision,
      })
      return
    }
    report({ event: `browser.client.${change.kind}.changed`, component: 'runtime.browser', level: 'info', revision: change.revision, count: change.count })
  })
}

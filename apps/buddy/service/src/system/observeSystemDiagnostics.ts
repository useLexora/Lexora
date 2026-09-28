import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { SystemCapabilityService } from './systemCapability'

export function observeSystemDiagnostics(service: SystemCapabilityService, report: ApplicationDiagnosticReporter) {
  const actions = service.onDidChange(change => report({
    event: `system.action.${change.phase}_${change.effect.replaceAll('-', '_')}${change.cancelled ? '_after_cancel' : ''}`,
    component: 'runtime.system',
    level: change.phase === 'failed' || change.verified === false ? 'warn' : 'info',
    operationId: change.operationId,
    revision: change.revision,
    ...(change.errorCode ? { errorCode: change.errorCode } : {}),
  }))
  const preparations = service.onDidChangePreparation(change => report({
    event: `system.preparation.${change.reason ?? change.phase}`,
    component: 'runtime.system',
    level: 'info',
    operationId: change.preparationId,
    revision: change.revision,
  }))
  return {
    dispose() {
      actions.dispose()
      preparations.dispose()
    },
  }
}

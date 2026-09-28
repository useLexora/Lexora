import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { PetActionService } from './PetActionService'

export function observePetActionDiagnostics(service: PetActionService, report: ApplicationDiagnosticReporter) {
  return service.onDidChange((change) => {
    const result = 'result' in change ? change.result : null
    const outcome = 'result' in change ? `.${result?.status ?? 'unknown'}` : ''
    report({
      event: `pet.action.${change.phase.replaceAll('-', '_')}${outcome}`,
      component: 'runtime.pet',
      level: change.phase === 'transport-unknown' || change.phase === 'progress-failed' || result?.status === 'failed' ? 'warn' : 'info',
      operationId: change.operationId,
      revision: change.revision,
      ...(change.runId ? { runId: change.runId } : {}),
      ...(change.toolCallId ? { toolCallId: change.toolCallId } : {}),
      ...(change.phase === 'host-confirmed' ? { count: change.result.completedSteps } : {}),
      ...(result?.status === 'failed' ? { errorCode: result.code } : {}),
    })
  })
}

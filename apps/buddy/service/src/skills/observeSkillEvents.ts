import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { SkillChangeNotice } from '../../../shared/skills/skillApi'
import type { SkillService } from './SkillService'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'

export function observeSkillNotifications(service: Pick<SkillService, 'onDidChange'>, notify: (event: SkillChangeNotice) => void) {
  return service.onDidChange((event) => {
    if (event.type !== 'catalog' && event.type !== 'installation')
      return
    notify(Object.freeze({
      sourceId: event.sourceId,
      sequence: event.sequence,
      generation: event.generation,
      spaceId: event.spaceId,
      type: event.type,
      ...(event.type === 'catalog' ? { mode: event.mode } : {}),
    }))
  })
}

export function observeSkillDiagnostics(service: Pick<SkillService, 'onDidChange'>, report: ApplicationDiagnosticReporter) {
  const record = safeDiagnosticReporter(report)
  return service.onDidChange((event) => {
    const common = { component: 'runtime.skills', producerInstanceId: event.sourceId, sourceSequence: event.sequence, generation: String(event.generation) }
    if (event.type === 'installation')
      record({ ...common, event: `skills.installation.${event.reason}`, level: 'info', operationId: event.operationId, count: event.installationIds.length })
    else if (event.type === 'catalog')
      record({ ...common, event: `skills.catalog.${event.mode}`, level: 'debug', count: event.skillIds.length })
    else if (event.type === 'resources')
      record({ ...common, event: 'skills.resources.changed', level: 'debug', count: event.skillIds.length })
    else
      record({ ...common, event: `skills.cleanup.${event.status}`, level: event.status === 'failed' ? 'warn' : 'debug', ...(event.error ? { errorCode: event.error } : {}) })
  })
}

import type { ApplicationEvents } from '../../../shared/observability/ApplicationEvents'
import type { DesktopStartup } from './DesktopStartup'
import { lifecycleDiagnostic } from '../../../shared/observability/lifecycleDiagnostics'

export function observeStartupDiagnostics(startup: DesktopStartup, events: ApplicationEvents): () => void {
  let previousStatus = startup.state.status
  const renderer = startup.onDidReportRenderer((report) => {
    if (report.change.component)
      events.publish({ ...lifecycleDiagnostic(report.change.component), generation: report.generation })
  })
  const subscription = startup.onDidChange((change) => {
    if (change.state.status === 'stopping' && previousStatus !== 'stopping')
      events.publish({ event: 'app.stopping', level: 'info' })
    previousStatus = change.state.status
    if (!change.transition)
      return
    events.publish({
      event: `app.${change.transition}`,
      level: change.transition === 'stop_failed' || change.state.status === 'failed' ? 'error' : 'info',
      component: change.component,
      parentOperationId: change.operationId,
      durationMs: change.durationMs,
      ...change.failure,
    })
  })
  return () => {
    subscription.dispose()
    renderer.dispose()
  }
}

import type { ApplicationDiagnostic } from '../diagnostics/applicationDiagnostic'
import type { LifecycleComponent, ServiceLifecycleReader } from '../lifecycle/serviceLifecycle'
import type { ApplicationEvents } from './ApplicationEvents'

export function lifecycleDiagnostic(component: LifecycleComponent): ApplicationDiagnostic {
  const operationStatus = { starting: 'started', ready: 'completed', start_failed: 'failed' } as const
  return {
    event: component.kind === 'service'
      ? `component.${component.status}`
      : `startup.step.${operationStatus[component.status as keyof typeof operationStatus]}`,
    component: component.component,
    operationId: component.operationId,
    level: component.status.endsWith('failed') ? 'error' : 'info',
    ...(component.durationMs === undefined ? {} : { durationMs: component.durationMs }),
    ...component.failure,
  }
}

export function observeLifecycleDiagnostics(source: ServiceLifecycleReader, events: ApplicationEvents): () => void {
  const subscription = source.onDidChange(({ component }) => {
    if (component)
      events.publish(lifecycleDiagnostic(component))
  })
  return () => subscription.dispose()
}

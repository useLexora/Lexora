import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'
import { randomUUID } from 'node:crypto'
import { writePlatformHostDiagnostic } from './writePlatformHostDiagnostic'

type ServiceStartupComponent = 'launcher.installation_gate' | 'runtime.host_handshake' | 'runtime.module_load' | 'runtime.node_environment' | 'runtime.node_resources' | 'runtime.product_ready' | 'runtime.process_installation_gate'

export async function measureServiceStartupStep<T, C extends ServiceStartupComponent>(component: C, parentOperationId: string, operation: () => Promise<T>, facts?: (value: T) => Pick<ApplicationDiagnostic, 'releaseCheck'>) {
  const identity = { component, parentOperationId, operationId: randomUUID() }
  const start = performance.now()
  function timing() {
    return { ...identity, durationMs: Math.round(performance.now() - start), occurredAt: new Date().toISOString() }
  }
  let value: T
  try {
    value = await operation()
  }
  catch (error) {
    writePlatformHostDiagnostic({ ...timing(), event: 'startup.step.failed', level: 'error' })
    throw error
  }
  const record = { ...timing(), ...facts?.(value), event: 'startup.step.completed', level: 'info' } as const satisfies ApplicationDiagnostic
  writePlatformHostDiagnostic(record)
  return { value, record }
}

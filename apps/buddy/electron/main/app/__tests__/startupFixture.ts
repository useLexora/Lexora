import type { RuntimeLifecycleChange, RuntimeLifecycleSnapshot } from '../../../../shared/lifecycle/runtimeLifecycle'
import type { LifecycleComponent } from '../../../../shared/lifecycle/serviceLifecycle'
import { Emitter } from '../../../../shared/events/Emitter'
import { ServiceLifecycleSource } from '../../../../shared/lifecycle/ServiceLifecycleSource'
import { DesktopStartup } from '../DesktopStartup'

export function createStartupFixture() {
  const startup = new DesktopStartup()
  const desktop = new ServiceLifecycleSource()
  const runtimeChanges = new Emitter<RuntimeLifecycleChange>(() => {})
  let runtime: RuntimeLifecycleSnapshot = { revision: 0, generation: null, status: 'stopped', errorCode: null, connection: null, services: null }
  let renderer = new ServiceLifecycleSource()
  startup.bindDesktop(desktop.reader)
  startup.bindRuntime({ get lifecycleState() {
    return runtime
  }, onDidChangeLifecycle: runtimeChanges.event })
  const connect = (generation: string, status: 'starting' | 'ready' | 'offline' = 'ready') => {
    runtime = {
      revision: runtime.revision + 1,
      generation,
      status,
      errorCode: status === 'offline' ? 'RUNTIME_START_FAILED' : null,
      connection: { component: 'runtime.connection', kind: 'service', operationId: generation, status: status === 'ready' ? 'ready' : status === 'offline' ? 'start_failed' : 'starting' },
      services: null,
    }
    runtimeChanges.fire({ snapshot: runtime })
  }
  const send = (component: string, status: LifecycleComponent['status'], generation = 'runtime-1') => {
    if (component === 'renderer' && status === 'starting')
      renderer = new ServiceLifecycleSource()
    const source = component.startsWith('renderer') ? renderer : desktop
    const subscription = component.startsWith('renderer') ? source.reader.onDidChange(change => startup.acceptRenderer({ generation, change })) : null
    source.update({ component, kind: 'service', operationId: component, status })
    subscription?.dispose()
  }
  const complete = (component: string, generation = 'runtime-1') => {
    send(component, 'starting', generation)
    send(component, 'ready', generation)
  }
  return { startup, desktop, send, complete, connect }
}

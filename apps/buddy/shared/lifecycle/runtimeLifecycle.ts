import type { Event } from '../events/Emitter'
import type { LifecycleComponent, ServiceLifecycleSnapshot } from './serviceLifecycle'

export type RuntimeLifecycleStatus = 'stopped' | 'starting' | 'ready' | 'restarting' | 'offline' | 'stopping'

export interface RuntimeLifecycleSnapshot {
  readonly revision: number
  readonly generation: string | null
  readonly status: RuntimeLifecycleStatus
  readonly errorCode: string | null
  readonly connection: LifecycleComponent | null
  readonly services: ServiceLifecycleSnapshot | null
}

export interface RuntimeLifecycleChange {
  readonly snapshot: RuntimeLifecycleSnapshot
  readonly connection?: LifecycleComponent
}

export interface RuntimeLifecycleReader {
  readonly lifecycleState: RuntimeLifecycleSnapshot
  readonly onDidChangeLifecycle: Event<RuntimeLifecycleChange>
}

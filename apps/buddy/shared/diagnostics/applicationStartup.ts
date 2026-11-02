import type { RuntimeMaintenance } from '../lifecycle/runtimeLifecycle'
import type { LifecycleProgress } from '../lifecycle/serviceLifecycle'

export interface ApplicationStartupState {
  revision: number
  generation: string | null
  maintenance: RuntimeMaintenance | null
  hasBeenReady: boolean
  status: 'starting' | 'failed' | 'ready' | 'stopping' | 'stopped'
  stages: ReadonlyArray<{
    stage: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'stopping' | 'stopped'
    operationId?: string
    durationMs?: number
    progress?: LifecycleProgress
    errorCode?: string
  }>
}

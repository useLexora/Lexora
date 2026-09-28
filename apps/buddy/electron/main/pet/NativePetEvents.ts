import type { NativePetSupervisorState } from './NativePetSupervisor'

export type NativePetFact
  = | { readonly kind: 'state', readonly state: Readonly<NativePetSupervisorState> }
    | { readonly kind: 'process', readonly status: 'spawn-failed' | 'exited' | 'stop-requested' | 'stop-unknown' }
    | { readonly kind: 'configuration', readonly status: 'reload-requested' }
    | { readonly kind: 'step', readonly operationId: string, readonly stepId: string, readonly index: number, readonly action: 'playAction' | 'moveByPath', readonly status: 'dispatched' | 'completed' | 'interrupted' | 'failed' | 'unknown', readonly completedSteps: number }
    | { readonly kind: 'recovery', readonly operationId: string, readonly status: 'requested' | 'completed' | 'failed' | 'unknown' }

export type NativePetChange = NativePetFact & { readonly revision: number, readonly generation: string | null }

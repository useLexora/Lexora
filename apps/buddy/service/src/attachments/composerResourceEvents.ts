import type { ComposerResourceRecord } from '../storage/composerResourceRepository'

export type ComposerResourceChangeReason = 'import' | 'selection' | 'recovery' | 'cleanup' | 'discard' | 'compatibility'
export interface ComposerResourceChange {
  readonly revision: number
  readonly operationId: string
  readonly reason: ComposerResourceChangeReason
  readonly resources: readonly {
    readonly resourceId: string
    readonly draftId: string
    readonly kind: 'created' | 'changed' | 'removed'
    readonly state: ComposerResourceRecord['state'] | null
  }[]
}

export interface AttachmentChange {
  readonly revision: number
  readonly operationId: string
  readonly kind: 'file-published' | 'registered' | 'released' | 'prepared' | 'cleanup-completed' | 'cleanup-failed' | 'reconciled'
  readonly phase: 'import' | 'message' | 'commit' | 'rollback' | 'release' | 'recovery'
  readonly attachmentIds: readonly string[]
  readonly count: number
}

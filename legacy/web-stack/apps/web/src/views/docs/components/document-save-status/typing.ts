import type { DocumentSaveState } from '@haohaoxue/lexora-contracts'
import type { DocumentSaveFailureKind } from '../../typing'

export interface DocumentSaveStatusProps {
  canRetry: boolean
  failureKind: DocumentSaveFailureKind | null
  saveState: DocumentSaveState
}

export interface DocumentSaveStatusEmits {
  reload: []
  retry: []
}

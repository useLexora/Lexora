import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { SpaceFileMutation, SpaceFileMutationError, SpaceFileMutationResult, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'

export interface WorkspaceEntryChange {
  target: SpaceFileTarget
  removedPath?: string
}
export type WorkspaceMutationError = SpaceFileMutationError | 'save-conflict' | 'save-failed' | 'destination-open'
export type WorkspaceMutationResult = SpaceFileMutationResult | { status: 'cancelled' } | { status: 'failed', reason: WorkspaceMutationError }
export type WorkspaceFilesApi = Pick<LocalChatApi['spaces'], 'listDirectory' | 'readFile' | 'revealFile'>
  & Partial<Pick<LocalChatApi['spaces'], 'locateEntry'>>
  & {
    mutateEntry?: (input: SpaceFileMutation) => Promise<WorkspaceMutationResult>
    openEntry?: (target: SpaceFileTarget, tabId: string) => Promise<boolean>
    closeEntries?: (target: SpaceFileTarget) => Promise<boolean>
    onEntriesChanged?: (listener: (change: WorkspaceEntryChange) => void) => () => void
  }

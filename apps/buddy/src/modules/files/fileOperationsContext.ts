import type { SpaceFileMutation, SpaceFileOperation, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { InjectionKey, ShallowRef } from 'vue'
import { inject } from 'vue'

export interface FileOperations {
  clipboard: ShallowRef<{ target: SpaceFileTarget, move: boolean } | null>
  copyPath: (target: SpaceFileTarget) => Promise<void>
  execute: (input: SpaceFileMutation) => Promise<SpaceFileOperation | null>
}
export const fileOperationsKey: InjectionKey<FileOperations> = Symbol('fileOperations')
export function useFileOperations(): FileOperations {
  const operations = inject(fileOperationsKey)
  if (!operations)
    throw new Error('FILE_OPERATIONS_UNAVAILABLE')
  return operations
}

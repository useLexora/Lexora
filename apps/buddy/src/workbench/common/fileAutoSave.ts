import type { ResourceRef } from './workbench'

export type FileAutoSaveStatus = 'off' | 'idle' | 'waiting' | 'saving' | 'saving-dirty' | 'failed' | 'conflict' | 'recovered' | 'blocked' | 'paused' | 'loading'

/** UI contract: scheduling and storage remain owned by the workbench. */
export interface FileAutoSaveController {
  readonly enabled: boolean
  setEnabled: (enabled: boolean) => void
  status: (resource: ResourceRef) => FileAutoSaveStatus
  retry: (resource: ResourceRef) => Promise<void>
  subscribe: (listener: () => void) => () => void
}

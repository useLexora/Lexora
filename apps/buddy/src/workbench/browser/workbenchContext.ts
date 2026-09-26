import type { WorkbenchMountTarget } from '@buddy-shared/workbench/workbenchUi'
import type { InjectionKey, Ref } from 'vue'
import type { DropPosition, WorkbenchLayout } from '../common/workbench'
import type { workbenchLabels } from '../common/workbenchLabels'
import type { WorkbenchController } from '../services/WorkbenchController'
import type { WorkingCopyService } from '../services/WorkingCopyService'
import type { WorkbenchResize } from './useWorkbenchResize'
import { inject } from 'vue'

export interface WorkbenchContext {
  resize: WorkbenchResize
  controller: WorkbenchController
  copies: WorkingCopyService
  layout: Readonly<Ref<WorkbenchLayout>>
  revision: Readonly<Ref<number>>
  mountPoints: Readonly<Ref<ReadonlyMap<string, HTMLElement>>>
  registerMountPoint: (target: WorkbenchMountTarget, element: HTMLElement, instanceId?: string) => () => void
  viewTarget: (id: string) => HTMLElement | null
  labels: Readonly<Ref<ReturnType<typeof workbenchLabels>>>
  dropPosition: Ref<{ paneId: string, position: DropPosition } | null>
  viewVisible: (id: string) => boolean
  mountView: (id: string, element: HTMLElement) => () => void
}
export const workbenchKey: InjectionKey<WorkbenchContext> = Symbol('workbench')
export function useWorkbench(): WorkbenchContext {
  const context = inject(workbenchKey)
  if (!context)
    throw new Error('Workbench is unavailable')
  return context
}

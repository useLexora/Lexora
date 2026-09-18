import type { InjectionKey } from 'vue'
import type { useDesktopWorkbench } from './useDesktopWorkbench'
import { inject } from 'vue'

export type DesktopWorkbench = ReturnType<typeof useDesktopWorkbench>
export const desktopWorkbenchKey: InjectionKey<DesktopWorkbench> = Symbol('desktop-workbench')
export function useDesktopWorkbenchContext(): DesktopWorkbench {
  const value = inject(desktopWorkbenchKey)
  if (!value)
    throw new Error('Desktop workbench is unavailable')
  return value
}

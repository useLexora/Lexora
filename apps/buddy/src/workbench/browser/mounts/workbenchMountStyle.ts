import type { WorkbenchPresentation } from '@buddy-shared/workbench/workbenchUi'
import type { CSSProperties } from 'vue'

export function workbenchMountStyle(presentation: WorkbenchPresentation): CSSProperties {
  const { position, order, zIndex = 0 } = presentation
  const lengths = Object.fromEntries((['width', 'height', 'top', 'right', 'bottom', 'left'] as const).map((key) => {
    const value = presentation[key]
    return [key, typeof value === 'number' ? `${value}px` : value ?? undefined]
  }))
  return { position, order, ...lengths, zIndex: 30 + zIndex }
}

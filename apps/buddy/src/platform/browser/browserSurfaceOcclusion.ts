import type { SurfaceRect } from '@/shared/ui/surfaces/surfaceLayout'

const modalSelector = '[aria-modal="true"], dialog:modal, .n-modal-mask, .n-drawer-mask'
const overlaySelector = `${modalSelector}, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], .n-popover-shared, .n-dropdown-menu, .n-base-select-menu, .n-cascader-menu, .n-date-panel, .n-drawer, .n-notification, .n-message, .workbench-interactions, .desktop-update-reminder, [data-extension-overlay], [data-workbench-hit-regions], [data-browser-occluder]`

export function browserSurfaceOccluded(clip: SurfaceRect): boolean {
  if (document.querySelector('.workbench.is-dragging'))
    return true
  for (const overlay of document.querySelectorAll<HTMLElement>(overlaySelector)) {
    const rect = overlay.getBoundingClientRect()
    if (!rect.width || !rect.height || getComputedStyle(overlay).visibility === 'hidden')
      continue
    if (overlay.matches(modalSelector))
      return true
    if (rect.left < clip.x + clip.width && rect.right > clip.x && rect.top < clip.y + clip.height && rect.bottom > clip.y)
      return true
  }
  return false
}

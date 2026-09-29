import type { DesktopUpdates } from './contracts'
import { createInjectionState } from '@vueuse/core'

const [useProvideDesktopUpdates, injectDesktopUpdates] = createInjectionState((updates: DesktopUpdates) => updates)
export { useProvideDesktopUpdates }

export function useDesktopUpdatesContext(): DesktopUpdates {
  const updates = injectDesktopUpdates()
  if (!updates)
    throw new Error('Desktop updates context is unavailable')
  return updates
}

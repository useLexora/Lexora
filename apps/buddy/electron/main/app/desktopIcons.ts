import type { BuddyRuntimeProfile } from '../../../shared/runtime/profile'
import developmentApp from '../../../resources/icons/app-icon-dev.png?asset'
import testApp from '../../../resources/icons/app-icon-test.png?asset'
import stableApp from '../../../resources/icons/app-icon.png?asset'
import developmentTray from '../../../resources/icons/tray-icon-dev.png?asset'
import testTray from '../../../resources/icons/tray-icon-test.png?asset'
import stableTray from '../../../resources/icons/tray-icon.png?asset'

export const desktopIcons: Record<BuddyRuntimeProfile, { app: string, tray: string }> = {
  stable: { app: stableApp, tray: stableTray },
  development: { app: developmentApp, tray: developmentTray },
  test: { app: testApp, tray: testTray },
}

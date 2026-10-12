import type { DesktopPageContribution } from '@/shared/navigation/desktopPages'
import { translateBuddy } from '@/i18n/buddyI18n'
import { DESKTOP_ROUTE_NAMES, desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import BuddyIcon from './widgets/BuddyIcon.vue'

export const buddiesPage: DesktopPageContribution = {
  id: 'lexora.buddies',
  title: language => translateBuddy(language, 'desktop.navigation.buddies'),
  icon: { kind: 'component', component: BuddyIcon },
  order: 25,
  location: desktopRouteLocations.buddies(),
  routes: [{ path: '/buddies/:buddyId?', name: DESKTOP_ROUTE_NAMES.buddies, component: () => import('./pages/DesktopBuddiesView.vue'), props: true }],
}

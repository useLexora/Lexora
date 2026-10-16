import type { SettingsTabName } from '../typing'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const settingsRouteNameByTab = {
  user: 'settings-user',
  preference: 'settings-preference',
  providers: 'settings-providers',
} as const satisfies Record<SettingsTabName, string>

export function useSettingsRouteTabs() {
  const route = useRoute()
  const router = useRouter()

  const activeTab = computed<SettingsTabName>({
    get() {
      if (route.name === settingsRouteNameByTab.preference) {
        return 'preference'
      }

      if (route.name === settingsRouteNameByTab.providers) {
        return 'providers'
      }

      return 'user'
    },
    set(tabName) {
      void router.push({
        name: settingsRouteNameByTab[tabName],
      })
    },
  })

  return {
    activeTab,
  }
}

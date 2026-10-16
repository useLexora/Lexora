import type { NavigationItemDefinition } from '@/router/routes'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { ADMIN_ROUTE_PATH, isAdminRoutePath } from '@/router/constants'
import { adminNavigationItems, workspaceNavigationItems } from '@/router/routes'
import { useUiStore } from '@/stores/ui'

const workspaceBrand = {
  to: '/',
  iconSrc: '/app-icon.png',
}

const adminBrand = {
  to: ADMIN_ROUTE_PATH,
  iconSrc: '/app-icon.png',
}

export function useWorkspaceContainer() {
  const route = useRoute()
  const { t } = useI18n({ useScope: 'global' })
  const uiStore = useUiStore()

  const isAdminContainer = computed(() => isAdminRoutePath(route.path))
  const brand = computed(() => isAdminContainer.value ? adminBrand : workspaceBrand)
  const navigationItems = computed(() => {
    if (isAdminContainer.value) {
      return localizeNavigationItems(adminNavigationItems)
    }

    return localizeNavigationItems(workspaceNavigationItems.map(item => item.name === 'home'
      ? {
          ...item,
          to: uiStore.lastActiveChatSessionId
            ? {
                name: 'chat',
                params: {
                  sessionId: uiStore.lastActiveChatSessionId,
                },
              }
            : item.to,
        }
      : item))
  })

  return {
    brand,
    navigationItems,
  }

  function localizeNavigationItems(items: NavigationItemDefinition[]) {
    return items.map(({ labelKey, ...item }) => ({
      ...item,
      label: t(labelKey),
    }))
  }
}

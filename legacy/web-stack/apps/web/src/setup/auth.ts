import type { Router } from 'vue-router'
import { loadAdminRoutes, resetAdminRoutes } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'

export default async function setupAuth(router: Router) {
  const authStore = useAuthStore()
  const userStore = useUserStore()

  authStore.installRouter(router)

  if (!authStore.accessToken) {
    authStore.clearSession()
    resetAdminRoutes(router)
    return
  }

  try {
    await authStore.refreshToken()
  }
  catch {
    authStore.clearSession()
    resetAdminRoutes(router)
    return
  }

  if (!userStore.currentUser) {
    authStore.clearSession()
    resetAdminRoutes(router)
    return
  }

  if (userStore.isSystemAdmin) {
    loadAdminRoutes(router)
    return
  }

  resetAdminRoutes(router)
}

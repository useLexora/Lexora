import type { Router } from 'vue-router'
import type { useAuthStore } from '@/stores/auth'
import { loadAdminRoutes, resetAdminRoutes } from '@/router'
import { useUserStore } from '@/stores/user'

const AUTH_FLOW_REDIRECT_PATHS = [
  '/login',
  '/register',
  '/auth/change-password',
]

export async function completeAuthNavigation(router: Router, authStore: ReturnType<typeof useAuthStore>) {
  const userStore = useUserStore()

  if (userStore.isSystemAdmin) {
    loadAdminRoutes(router)
  }
  else {
    resetAdminRoutes(router)
  }

  if (userStore.requiresPasswordChange) {
    await router.replace({ name: 'change-password' })
    return
  }

  const saved = authStore.consumeRedirect()
  await router.replace(resolvePostAuthRedirect(saved, userStore.defaultRouteName))
}

export function syncPendingRedirect(redirect: unknown, authStore: ReturnType<typeof useAuthStore>) {
  if (typeof redirect !== 'string') {
    return
  }

  const normalizedRedirect = redirect.trim()

  if (!normalizedRedirect.length) {
    return
  }

  authStore.savePendingRedirect(normalizedRedirect)
}

function resolvePostAuthRedirect(saved: string, defaultRouteName: string) {
  if (!saved || isAuthFlowRedirect(saved)) {
    return { name: defaultRouteName }
  }

  return saved
}

function isAuthFlowRedirect(path: string) {
  return AUTH_FLOW_REDIRECT_PATHS.some(authPath =>
    path === authPath
    || path.startsWith(`${authPath}?`)
    || path.startsWith(`${authPath}#`)
    || path.startsWith(`${authPath}/`),
  )
}

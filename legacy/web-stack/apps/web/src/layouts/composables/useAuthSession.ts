import { computed, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { resetAdminRoutes } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'

export function useAuthSession() {
  const router = useRouter()
  const authStore = useAuthStore()
  const userStore = useUserStore()
  const isLoggingOut = shallowRef(false)

  async function logout() {
    isLoggingOut.value = true

    try {
      await authStore.logout()
    }
    finally {
      try {
        await router.replace({ name: 'login' })
      }
      finally {
        resetAdminRoutes(router)
        isLoggingOut.value = false
      }
    }
  }

  return {
    currentUser: computed(() => userStore.currentUser),
    isLoggingOut,
    logout,
  }
}

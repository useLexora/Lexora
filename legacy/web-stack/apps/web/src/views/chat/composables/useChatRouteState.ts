import { createSharedComposable } from '@vueuse/core'
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatSessions } from './useChatSessions'

export const useChatRouteState = createSharedComposable(() => {
  const route = useRoute()
  const router = useRouter()
  const {
    clearActiveSession,
    selectSession,
  } = useChatSessions()

  const routeSessionId = computed(() => {
    const rawSessionId = route.params.sessionId
    return typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
  })
  const isNewChatRoute = computed(() => route.name === 'home')
  const isChatSessionRoute = computed(() => route.name === 'chat')

  watch(
    () => [route.name, routeSessionId.value] as const,
    async () => {
      if (isChatSessionRoute.value && routeSessionId.value) {
        const selected = await selectSession(routeSessionId.value)
        if (!selected && isChatSessionRoute.value) {
          await router.replace({ name: 'home' })
        }
        return
      }

      if (isNewChatRoute.value) {
        clearActiveSession()
      }
    },
    { immediate: true },
  )

  async function navigateToNewChat() {
    if (isNewChatRoute.value) {
      clearActiveSession()
      return
    }

    await router.push({ name: 'home' })
  }

  async function navigateToSession(sessionId: string, options: { replace?: boolean } = {}) {
    const nextSessionId = sessionId.trim()
    if (!nextSessionId) {
      return
    }

    if (isChatSessionRoute.value && routeSessionId.value === nextSessionId) {
      return
    }

    const target = {
      name: 'chat',
      params: {
        sessionId: nextSessionId,
      },
    }

    if (options.replace) {
      await router.replace(target)
      return
    }

    await router.push(target)
  }

  return {
    isChatSessionRoute,
    isNewChatRoute,
    navigateToNewChat,
    navigateToSession,
    routeSessionId,
  }
})

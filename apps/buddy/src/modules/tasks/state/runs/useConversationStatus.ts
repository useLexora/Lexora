import type { LocalConversationStatus } from '@buddy-shared/runs/conversationStatusApi'
import type { Ref } from 'vue'
import { shallowRef } from 'vue'

export function useConversationStatus(conversationId: Ref<string | null>) {
  const status = shallowRef<LocalConversationStatus | null>(null)
  const isLoading = shallowRef(false)
  const loadFailed = shallowRef(false)
  let requestId = 0

  async function load(): Promise<void> {
    const current = conversationId.value
    const api = window.lexoraDesktop?.localChat?.runs
    if (!current || !api) {
      status.value = null
      loadFailed.value = false
      isLoading.value = false
      return
    }
    const id = ++requestId
    isLoading.value = true
    loadFailed.value = false
    try {
      const next = await api.status({ conversationId: current })
      if (id === requestId && conversationId.value === current)
        status.value = next
    }
    catch {
      if (id === requestId && conversationId.value === current) {
        status.value = null
        loadFailed.value = true
      }
    }
    finally {
      if (id === requestId)
        isLoading.value = false
    }
  }

  return { isLoading, load, loadFailed, status }
}

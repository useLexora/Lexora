import type { LocalConversationHistoryPage } from '@buddy-shared/conversation/conversationHistoryApi'
import type { TaskIndex } from '../../contracts'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'

export function useTaskHistorySearch(options: {
  show: () => boolean
  search: TaskIndex['history']['search']
  onError: () => void
}) {
  const query = shallowRef('')
  const items = shallowRef<LocalConversationHistoryPage['items']>([])
  const nextCursor = shallowRef<string | null>(null)
  const loading = shallowRef(false)
  const failed = shallowRef(false)
  const normalizedQuery = computed(() => query.value.trim())
  let version = 0

  async function fetchPage(requestVersion: number, cursor?: string) {
    loading.value = true
    failed.value = false
    const searchQuery = normalizedQuery.value
    try {
      const page = await options.search(searchQuery, cursor)
      if (requestVersion !== version)
        return
      const entries = cursor ? [...items.value, ...page.items] : page.items
      items.value = [...new Map(entries.map(item => [item.conversation.id, item])).values()]
      nextCursor.value = page.nextCursor
    }
    catch {
      if (requestVersion !== version)
        return
      failed.value = true
      options.onError()
    }
    finally {
      if (requestVersion === version)
        loading.value = false
    }
  }

  watch([normalizedQuery, options.show], ([value, show], _, cleanup) => {
    const requestVersion = ++version
    items.value = []
    nextCursor.value = null
    failed.value = false
    loading.value = Boolean(show && value)
    if (!show || !value)
      return
    const timer = setTimeout(() => void fetchPage(requestVersion), 220)
    cleanup(() => clearTimeout(timer))
  }, { immediate: true, flush: 'sync' })

  onScopeDispose(() => version += 1)

  async function loadMore() {
    if (loading.value || !options.show() || !normalizedQuery.value)
      return
    if (nextCursor.value || failed.value)
      await fetchPage(version, nextCursor.value ?? undefined)
  }

  return { query, normalizedQuery, items, nextCursor, loading, failed, loadMore }
}

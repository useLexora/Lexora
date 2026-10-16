import type { ReadableDocumentSearchResult } from '@/apis/document'
import { useDebounceFn } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import { searchReadableDocumentsForChat } from '@/apis/document'
import { translate } from '@/i18n'
import { useWorkspaceStore } from '@/stores/workspace'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export interface UseChatDocumentSearchOptions {
  debounceMs?: number
  search?: (workspaceId: string, query: string) => Promise<ReadableDocumentSearchResult[]>
}

export function useChatDocumentSearch(options: UseChatDocumentSearchOptions = {}) {
  const workspaceStore = useWorkspaceStore()
  const search = options.search ?? searchReadableDocumentsForChat
  const query = shallowRef('')
  const documents = shallowRef<ReadableDocumentSearchResult[]>([])
  const isLoading = shallowRef(false)
  const errorMessage = shallowRef('')
  let requestId = 0

  const hasQuery = computed(() => Boolean(query.value.trim()))
  const isEmpty = computed(() =>
    hasQuery.value
    && !isLoading.value
    && !errorMessage.value
    && documents.value.length === 0,
  )

  const runDebouncedSearch = useDebounceFn(
    () => runSearch(),
    options.debounceMs ?? 180,
  )

  function setQuery(nextQuery: string) {
    query.value = nextQuery
    void runDebouncedSearch()
  }

  async function runSearch() {
    const normalizedQuery = query.value.trim()
    const currentRequestId = ++requestId
    errorMessage.value = ''

    if (!normalizedQuery) {
      documents.value = []
      isLoading.value = false
      return
    }

    isLoading.value = true

    try {
      const workspace = await workspaceStore.ensurePersonalWorkspace()
      const result = await search(workspace.id, normalizedQuery)
      if (currentRequestId !== requestId) {
        return
      }
      documents.value = result
    }
    catch (error) {
      if (currentRequestId !== requestId) {
        return
      }
      documents.value = []
      errorMessage.value = getRequestErrorDisplayMessage(error, translate('chat.composer.documentPicker.searchFailed'))
    }
    finally {
      if (currentRequestId === requestId) {
        isLoading.value = false
      }
    }
  }

  function reset() {
    requestId += 1
    query.value = ''
    documents.value = []
    isLoading.value = false
    errorMessage.value = ''
  }

  return {
    query,
    documents,
    isLoading,
    errorMessage,
    hasQuery,
    isEmpty,
    setQuery,
    runSearch,
    reset,
  }
}

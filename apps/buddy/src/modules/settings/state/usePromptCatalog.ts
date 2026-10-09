import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuiltinPromptCatalog } from '@buddy-shared/prompts/promptApi'
import type { Ref } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { onMounted, onScopeDispose, readonly, shallowRef } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

export function usePromptCatalog(api: LocalChatApi['prompts'], ready: Promise<void>, language: Readonly<Ref<BuddyLocale>>) {
  const catalog = shallowRef<BuiltinPromptCatalog | null>(null)
  const loading = shallowRef(true)
  const error = shallowRef<string | null>(null)
  let disposed = false
  let request = 0
  onScopeDispose(() => {
    disposed = true
    request++
  })

  async function load() {
    if (disposed)
      return
    const current = ++request
    loading.value = true
    error.value = null
    try {
      await ready
      if (disposed || current !== request)
        return
      const result = await api.get()
      if (!disposed && current === request)
        catalog.value = result
    }
    catch (cause) {
      if (!disposed && current === request)
        error.value = resolveLocalChatErrorMessage(cause, language.value)
    }
    finally {
      if (!disposed && current === request)
        loading.value = false
    }
  }

  onMounted(load)
  return { catalog: readonly(catalog), loading: readonly(loading), error: readonly(error), load }
}

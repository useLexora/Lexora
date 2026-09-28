import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { WebSearchProvider, WebSettings, WebSettingsSnapshot } from '@buddy-shared/network/webProtocol'
import type { ShallowRef } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, getCurrentScope, onScopeDispose, readonly, shallowRef } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

export function useWebSettingsCapability(options: {
  api: LexoraDesktopApi['localChat']['web']
  language: Readonly<ShallowRef<BuddyLocale>>
}) {
  const snapshot = shallowRef<WebSettingsSnapshot | null>(null)
  const busy = shallowRef(false)
  const error = shallowRef<string | null>(null)
  let disposed = false
  let epoch = 0
  let invalidated = false
  let refreshing: Promise<void> | null = null
  const unsubscribe = options.api.onChanged(() => {
    invalidated = true
    epoch++
    void refresh()
  })
  function dispose() {
    disposed = true
    epoch++
    unsubscribe()
  }
  if (getCurrentScope())
    onScopeDispose(dispose)
  const searchSources = computed(() => snapshot.value?.settings.search.filter(source => source.provider !== 'tavily' || snapshot.value?.tavilyKeyConfigured) ?? [])

  async function refresh(): Promise<void> {
    if (refreshing || busy.value || disposed)
      return
    refreshing = (async () => {
      while (invalidated && !busy.value) {
        if (disposed)
          break
        invalidated = false
        const accepted = ++epoch
        try {
          const next = await options.api.read()
          if (!disposed && accepted === epoch)
            snapshot.value = next
        }
        catch {}
      }
    })().finally(() => {
      refreshing = null
      if (invalidated && !busy.value && !disposed)
        void refresh()
    })
    await refreshing
  }

  async function execute(operation: () => Promise<WebSettingsSnapshot>): Promise<boolean> {
    if (busy.value || disposed)
      return false
    const accepted = ++epoch
    busy.value = true
    error.value = null
    try {
      const next = await operation()
      if (!disposed && accepted === epoch)
        snapshot.value = next
      return true
    }
    catch (cause) {
      if (!disposed)
        error.value = resolveLocalChatErrorMessage(cause, options.language.value)
      return false
    }
    finally {
      busy.value = false
      await refresh()
    }
  }

  function save(settings: WebSettings): Promise<boolean> {
    if (disposed || busy.value || !snapshot.value)
      return Promise.resolve(false)
    const previous = snapshot.value
    const value = { search: settings.search.map(source => ({ provider: source.provider, enabled: source.enabled })), fetch: { render: settings.fetch.render, remote: settings.fetch.remote } }
    snapshot.value = { ...previous, settings: value }
    return execute(async () => {
      try {
        return await options.api.save(value)
      }
      catch (cause) {
        snapshot.value = previous
        throw cause
      }
    })
  }

  function setSearchEnabled(provider: WebSearchProvider, enabled: boolean) {
    const settings = snapshot.value?.settings
    if (settings)
      return save({ ...settings, search: settings.search.map(source => source.provider === provider ? { ...source, enabled } : source) })
  }

  function reorderSearch(provider: WebSearchProvider, target: WebSearchProvider, position: 'before' | 'after') {
    const settings = snapshot.value?.settings
    if (!settings || provider === target)
      return
    const source = settings.search.find(source => source.provider === provider)
    const search = settings.search.filter(source => source.provider !== provider)
    const index = search.findIndex(source => source.provider === target)
    if (!source || index < 0)
      return
    search.splice(index + (position === 'after' ? 1 : 0), 0, source)
    return save({ ...settings, search })
  }

  function setFetchEnabled(name: keyof WebSettings['fetch'], enabled: boolean) {
    const settings = snapshot.value?.settings
    if (settings)
      return save({ ...settings, fetch: { ...settings.fetch, [name]: enabled } })
  }

  return {
    dispose,
    busy: readonly(busy),
    error: readonly(error),
    snapshot: readonly(snapshot),
    searchSources: readonly(searchSources),
    language: options.language,
    load: () => execute(() => options.api.read()),
    setSearchEnabled,
    reorderSearch,
    setFetchEnabled,
    saveCredential: (key: string | null) => execute(() => options.api.saveCredential(key)),
    revealCredential: () => options.api.revealCredential(),
  }
}

export type WebSettingsCapability = ReturnType<typeof useWebSettingsCapability>

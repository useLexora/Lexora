import type { ExtensionApi } from '@buddy-shared/extensions/extensionApi'
import type { FileOpeningChoice, FileOpeningLocation, FileOpeningSnapshot } from '@buddy-shared/files/fileOpening'
import type { Ref } from 'vue'
import type { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { builtinFileOpeningProviders, resolveFileOpening } from '@buddy-shared/files/fileOpening'
import { createInjectionState } from '@vueuse/core'
import { computed, onScopeDispose, shallowReadonly, shallowRef } from 'vue'

export interface FileOpeningState {
  snapshot: Readonly<Ref<FileOpeningSnapshot>>
  error: Readonly<Ref<string>>
  loading: Readonly<Ref<boolean>>
  loaded: Readonly<Ref<boolean>>
  ready: Promise<void>
  ensureReady: () => Promise<void>
  refresh: () => Promise<void>
  resolve: (name: string, location: FileOpeningLocation) => ReturnType<typeof resolveFileOpening>
  setDefault: (choice: FileOpeningChoice) => Promise<void>
  bindRegistry: (registry: ContributionRegistry) => void
}

const [useProvideFileOpening, useFileOpening] = createInjectionState((api: Pick<ExtensionApi, 'fileOpeners' | 'setFileOpener' | 'onChanged'>): FileOpeningState => {
  const snapshot = shallowRef<FileOpeningSnapshot>({ providers: [...builtinFileOpeningProviders], defaults: {} })
  const error = shallowRef('')
  const loaded = shallowRef(false)
  const pendingReads = shallowRef(0)
  let revision = 0
  let disposed = false
  let mutations = Promise.resolve()
  let currentRefresh: Promise<void> | undefined
  let source = snapshot.value
  let registry: ContributionRegistry | undefined
  let unsubscribeRegistry: (() => void) | undefined

  function publish() {
    if (!registry) {
      snapshot.value = source
      return
    }
    const registered = registry.fileOpeners
    snapshot.value = {
      defaults: source.defaults,
      providers: source.providers.map(provider => ({ ...provider, available: provider.available && registered.get(provider.id)?.available === true })),
    }
  }

  function bindRegistry(next: ContributionRegistry) {
    if (disposed)
      return
    unsubscribeRegistry?.()
    registry = next
    unsubscribeRegistry = registry.subscribe(publish)
    publish()
  }

  async function readSnapshot(): Promise<void> {
    await mutations
    if (disposed)
      return
    const current = ++revision
    pendingReads.value++
    try {
      const next = await api.fileOpeners()
      if (!disposed && current === revision) {
        source = next
        publish()
        loaded.value = true
        error.value = ''
      }
    }
    catch (reason) {
      if (!disposed && current === revision)
        error.value = reason instanceof Error ? reason.message : String(reason)
      throw reason
    }
    finally {
      pendingReads.value--
    }
  }

  function refresh(): Promise<void> {
    const pending = readSnapshot()
    currentRefresh = pending
    const clear = () => {
      if (currentRefresh === pending)
        currentRefresh = undefined
    }
    void pending.then(clear, clear)
    return pending
  }

  async function ensureReady(): Promise<void> {
    while (!loaded.value) {
      if (disposed)
        throw new Error('File opening state is unavailable')
      await (currentRefresh ?? refresh())
    }
  }

  function setDefault(choice: FileOpeningChoice): Promise<void> {
    const pending = mutations.then(async () => {
      if (disposed)
        throw new Error('File opening state is unavailable')
      revision++
      const next = await api.setFileOpener(choice)
      if (!disposed) {
        revision++
        source = next
        publish()
        loaded.value = true
        error.value = ''
      }
    })
    mutations = pending.catch(() => {})
    return pending
  }

  const unsubscribe = api.onChanged(() => {
    void refresh().catch(() => {})
  })
  const ready = refresh()
  void ready.catch(() => {})
  onScopeDispose(() => {
    disposed = true
    revision++
    unsubscribe()
    unsubscribeRegistry?.()
  })
  return {
    snapshot: shallowReadonly(snapshot),
    error: shallowReadonly(error),
    loaded: shallowReadonly(loaded),
    loading: computed(() => pendingReads.value > 0),
    ready,
    ensureReady,
    refresh,
    resolve: (name, location) => resolveFileOpening(snapshot.value, name, location),
    setDefault,
    bindRegistry,
  }
})

export { useFileOpening, useProvideFileOpening }

import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { ServiceHost } from '@buddy-shared/lifecycle/ServiceHost'
import { useModelProvidersStore } from '@/modules/models'
import { useNotificationCenterStore } from '@/modules/notifications'
import { useApplicationSettingsStore, useUsageStore } from '@/modules/settings'
import { useDesktopUpdates } from '@/modules/updates'
import { useRuntimeSupervisorStore } from '@/platform/runtime/useRuntimeSupervisorStore'
import { requireInitialState } from './requireInitialState'

export interface UseDesktopAppStateOptions {
  api: LexoraDesktopApi
}

export function useDesktopAppState(options: UseDesktopAppStateOptions) {
  const applicationSettings = useApplicationSettingsStore(options.api.settings)
  const updates = useDesktopUpdates(options.api.app)
  const notifications = useNotificationCenterStore(options.api.localChat, updates)
  const modelProviders = useModelProvidersStore({
    api: options.api.localChat.providers,
    language: applicationSettings.language,
  })
  const runtimeSupervisor = useRuntimeSupervisorStore({
    api: options.api.localChat.runtime,
    language: applicationSettings.language,
  })
  const usage = useUsageStore({
    api: options.api.localChat.usage,
    language: applicationSettings.language,
  })
  const stores = {
    applicationSettings,
    modelProviders,
    notifications,
    runtimeSupervisor,
    updates,
    usage,
  } as const

  let initialization: Promise<boolean> | undefined
  let disposed = false

  function initialize(): Promise<boolean> {
    if (disposed)
      return Promise.resolve(false)
    return initialization ??= loadInitialState().then((result) => {
      if (!result)
        initialization = undefined
      return result
    })
  }

  async function loadInitialState(): Promise<boolean> {
    void updates.load().catch(() => {})
    const results = await Promise.allSettled([
      applicationSettings.load(),
      runtimeSupervisor.loadStatus(),
    ])
    return !disposed && results.every(result => result.status === 'fulfilled')
  }

  async function refreshRuntimeDependentState(host: ServiceHost): Promise<void> {
    const results = await Promise.allSettled([
      host.step('renderer.providers', async () => requireInitialState(await modelProviders.loadModelCatalog(true))),
      host.step('renderer.notifications', async () => requireInitialState(await notifications.load())),
    ])
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length)
      throw new AggregateError(failures, 'Initial runtime data is unavailable')
  }

  function dispose() {
    if (disposed)
      return
    disposed = true
    applicationSettings.dispose()
    modelProviders.dispose()
    notifications.dispose()
    updates.dispose()
    runtimeSupervisor.dispose()
  }

  return {
    dispose,
    initialize,
    refreshRuntimeDependentState,
    stores,
  }
}

export type DesktopAppState = ReturnType<typeof useDesktopAppState>
export type DesktopStores = DesktopAppState['stores']

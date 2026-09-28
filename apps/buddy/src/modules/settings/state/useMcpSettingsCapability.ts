import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConnector, LocalConnectorConfig, LocalConnectorCredentialMutation } from '@buddy-shared/connectors/connectorApi'
import type { Ref } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { onScopeDispose, readonly, shallowRef } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

export function useMcpSettingsCapability(options: {
  api: LexoraDesktopApi['localChat']['connectors']
  language: Readonly<Ref<BuddyLocale>>
}) {
  const connectors = shallowRef<readonly LocalConnector[]>([])
  const busyId = shallowRef<string | null>(null)
  const error = shallowRef<string | null>(null)
  const loaded = shallowRef(false)
  let reading: Promise<void> | undefined
  let refreshRequested = false
  let disposed = false
  const revisions = new Map<string, number>()
  const stop = options.api.onChanged((event) => {
    if (event.revision <= (revisions.get(event.sourceId) ?? 0))
      return
    revisions.set(event.sourceId, event.revision)
    if (revisions.size > 32)
      revisions.delete(revisions.keys().next().value!)
    if (loaded.value || reading)
      void load()
  })
  onScopeDispose(() => {
    disposed = true
    stop()
  })

  async function load() {
    if (disposed)
      return
    if (reading) {
      refreshRequested = true
      return reading
    }
    const operation = (async () => {
      do {
        if (disposed)
          break
        refreshRequested = false
        try {
          const value = await options.api.list()
          if (!disposed) {
            connectors.value = value
            loaded.value = true
          }
        }
        catch (cause) {
          if (!disposed)
            error.value = resolveLocalChatErrorMessage(cause, options.language.value)
        }
      } while (refreshRequested)
    })().finally(() => { reading = undefined })
    reading = operation
    return operation
  }

  async function execute<T>(id: string, action: () => Promise<T>): Promise<T | null> {
    if (busyId.value)
      return null
    busyId.value = id
    error.value = null
    try {
      const result = await action()
      await reading
      await load()
      return result
    }
    catch (cause) {
      error.value = resolveLocalChatErrorMessage(cause, options.language.value)
      return null
    }
    finally { busyId.value = null }
  }

  return {
    connectors: readonly(connectors),
    busyId: readonly(busyId),
    error: readonly(error),
    loaded: readonly(loaded),
    language: options.language,
    load,
    save: (input: { config: LocalConnectorConfig, credential: LocalConnectorCredentialMutation }) => execute(input.config.id, () => options.api.upsert(input)),
    setEnabled: (id: string, enabled: boolean) => execute(id, () => options.api.setEnabled(id, enabled)),
    test: (id: string) => execute(id, () => options.api.test(id)),
    tools: (id: string) => execute(id, () => options.api.tools(id)),
    confirmExecution: (id: string) => execute(id, () => options.api.confirmExecution(id)),
    remove: (id: string) => execute(id, () => options.api.remove(id)),
    login: (id: string) => execute(id, () => options.api.login(id)),
    cancelLogin: (id: string) => execute(id, () => options.api.cancelLogin(id)),
    clearCredential: (id: string) => execute(id, () => options.api.clearCredential(id)),
  }
}

export type McpSettingsCapability = ReturnType<typeof useMcpSettingsCapability>

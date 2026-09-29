import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionConfiguration, ExtensionConfigurationSnapshot, ExtensionSettingValue } from '@buddy-shared/extensions/extensionSettings'
import type { Ref } from 'vue'
import type { PluginSettingField } from '../model/settingsRegistry'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { usePluginSettingConditions } from './usePluginSettingConditions'
import { activeSettingsExtensions } from './useSettingsRegistry'

interface ConfigurationSession {
  revision: string
  request: number
  saving: boolean
  loading: boolean
}

export function usePluginSettings(installed: Readonly<Ref<ExtensionStatus[]>>, api: Pick<ExtensionApi, 'configurationSnapshot' | 'configure' | 'settingConditions' | 'onConditionsChanged'>) {
  const snapshots = shallowRef<Record<string, ExtensionConfigurationSnapshot>>({})
  const configurations = computed<Record<string, ExtensionConfiguration>>(() => Object.fromEntries(Object.entries(snapshots.value).map(([id, snapshot]) => [id, snapshot.values])))
  const conditions = usePluginSettingConditions(api, configurations)
  const invalidKeys = computed<Record<string, readonly string[]>>(() => Object.fromEntries(Object.entries(snapshots.value).map(([id, snapshot]) => [id, snapshot.invalidKeys])))
  const errors = shallowRef<ReadonlySet<string>>(new Set())
  const pending = shallowRef<ReadonlySet<string>>(new Set())
  const loading = shallowRef<ReadonlySet<string>>(new Set())
  const sessions = new Map<string, ConfigurationSession>()
  const isCurrent = (id: string, session: ConfigurationSession) => sessions.get(id) === session
  const syncPending = () => pending.value = new Set([...sessions].filter(([, session]) => session.saving).map(([id]) => id))
  const syncLoading = () => loading.value = new Set([...sessions].filter(([, session]) => session.loading).map(([id]) => id))
  function setError(id: string, failed: boolean) {
    const next = new Set(errors.value)
    if (failed)
      next.add(id)
    else next.delete(id)
    errors.value = next
  }
  async function reload(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session || session.saving)
      return
    const request = ++session.request
    session.loading = true
    syncLoading()
    try {
      const snapshot = await api.configurationSnapshot(id)
      if (isCurrent(id, session) && request === session.request) {
        snapshots.value = { ...snapshots.value, [id]: snapshot }
        setError(id, false)
      }
    }
    catch {
      if (isCurrent(id, session) && request === session.request)
        setError(id, true)
    }
    finally {
      if (request === session.request)
        session.loading = false
      syncLoading()
    }
  }
  watch(installed, (plugins) => {
    const active = activeSettingsExtensions(plugins).filter(plugin => plugin.manifest.contributes.settings.items.length)
    for (const [id, session] of sessions) {
      if (!active.some(plugin => plugin.manifest.id === id && plugin.revision === session.revision)) {
        sessions.delete(id)
        const next = { ...snapshots.value }
        delete next[id]
        snapshots.value = next
        setError(id, false)
      }
    }
    for (const plugin of active) {
      const id = plugin.manifest.id
      if (!sessions.has(id))
        sessions.set(id, { revision: plugin.revision, request: 0, saving: false, loading: false })
      void reload(id)
    }
    syncPending()
    syncLoading()
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => sessions.clear())

  async function save(field: PluginSettingField, value: ExtensionSettingValue): Promise<'saved' | 'failed' | 'stale'> {
    const id = field.extensionId
    const session = sessions.get(id)
    if (!session || session.revision !== field.revision || session.saving)
      return 'stale'
    session.saving = true
    session.request++
    session.loading = false
    syncLoading()
    syncPending()
    let committed = false
    try {
      await api.configure(id, { [field.item.key]: value })
      committed = true
      if (!isCurrent(id, session))
        return 'stale'
      snapshots.value = { ...snapshots.value, [id]: {
        values: { ...configurations.value[id], [field.item.key]: value },
        invalidKeys: invalidKeys.value[id]?.filter(key => key !== field.item.key) ?? [],
      } }
      const snapshot = await api.configurationSnapshot(id)
      if (!isCurrent(id, session))
        return 'stale'
      snapshots.value = { ...snapshots.value, [id]: snapshot }
      setError(id, false)
      return 'saved'
    }
    catch {
      if (!isCurrent(id, session))
        return 'stale'
      if (committed) {
        setError(id, true)
        return 'saved'
      }
      return 'failed'
    }
    finally {
      conditions.draft(field, undefined)
      session.saving = false
      syncPending()
    }
  }
  return { conditions, configurations, invalidKeys, errors, pending, loading, save, reload }
}
export type PluginSettings = ReturnType<typeof usePluginSettings>

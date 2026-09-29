import type { ExtensionApi } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionConditionState } from '@buddy-shared/extensions/extensionConditions'
import type { ExtensionConfiguration, ExtensionSettingValue } from '@buddy-shared/extensions/extensionSettings'
import type { Ref } from 'vue'
import type { PluginSettingField } from '../model/settingsRegistry'
import { onScopeDispose, shallowRef, watch } from 'vue'

export function usePluginSettingConditions(api: Pick<ExtensionApi, 'settingConditions' | 'onConditionsChanged'>, configurations: Readonly<Ref<Record<string, ExtensionConfiguration>>>) {
  const states = shallowRef<Record<string, ExtensionConditionState | undefined>>({})
  const fields = new Map<symbol, PluginSettingField>()
  const drafts = new Map<string, ExtensionConfiguration>()
  const requests = new Map<string, number>()
  const scheduled = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const key = (field: PluginSettingField) => `${field.extensionId}:${field.item.id}`
  function refresh(id: string) {
    if (disposed)
      return
    const mounted = [...fields.values()].filter(field => field.extensionId === id && field.item.enabledWhen)
    requests.set(id, (requests.get(id) ?? 0) + 1)
    if (!mounted.length)
      return
    scheduled.add(id)
    timer ??= setTimeout(() => {
      timer = undefined
      const ids = [...scheduled]
      scheduled.clear()
      for (const id of ids) void evaluate(id)
    }, 50)
  }
  async function evaluate(id: string) {
    const mounted = [...fields.values()].filter(field => field.extensionId === id && field.item.enabledWhen)
    if (!mounted.length || disposed)
      return
    const request = requests.get(id)
    const result = await api.settingConditions(id, [...new Set(mounted.map(field => field.item.id))], drafts.get(id)).catch(() => ({} as Record<string, ExtensionConditionState>))
    if (disposed || request !== requests.get(id))
      return
    states.value = { ...states.value, ...Object.fromEntries(mounted.map(field => [key(field), result[field.item.id] ?? { status: 'unavailable', value: false }])) }
  }
  function draft(field: PluginSettingField, value: ExtensionSettingValue | undefined) {
    const values = { ...drafts.get(field.extensionId) }
    if (value === undefined || JSON.stringify(value) === JSON.stringify(configurations.value[field.extensionId]?.[field.item.key]))
      delete values[field.item.key]
    else values[field.item.key] = value
    if (JSON.stringify(values) === JSON.stringify(drafts.get(field.extensionId) ?? {}))
      return
    drafts.set(field.extensionId, values)
    refresh(field.extensionId)
  }
  function observe(field: PluginSettingField) {
    const token = Symbol('setting-condition')
    fields.set(token, field)
    refresh(field.extensionId)
    return () => {
      fields.delete(token)
      if (![...fields.values()].some(current => key(current) === key(field))) {
        const next = { ...states.value }
        delete next[key(field)]
        states.value = next
        draft(field, undefined)
      }
      refresh(field.extensionId)
      if (![...fields.values()].some(current => current.extensionId === field.extensionId)) {
        drafts.delete(field.extensionId)
        scheduled.delete(field.extensionId)
      }
    }
  }
  watch(() => JSON.stringify(configurations.value), () => {
    for (const id of new Set([...fields.values()].map(field => field.extensionId))) refresh(id)
  })
  const stop = api.onConditionsChanged(event => refresh(event.extensionId))
  onScopeDispose(() => {
    disposed = true
    stop()
    clearTimeout(timer)
    fields.clear()
    drafts.clear()
    requests.clear()
    scheduled.clear()
  })
  return { states, key, observe, draft, refresh }
}

import type { ExtensionConditionsChanged, ExtensionConditionState } from '@buddy-shared/extensions/extensionConditions'
import type { PluginSettingField } from '../../model/settingsRegistry'
import { deferred } from '@buddy-tests/deferred'
import { expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { usePluginSettingConditions } from '../usePluginSettingConditions'

it('keeps the last condition while drafts are evaluated, then applies false or unavailable results', async () => {
  vi.useFakeTimers()
  const scope = effectScope()
  const field: PluginSettingField = { extensionId: 'tests.settings', revision: 'v1', item: { id: 'tests.settings.name', key: 'name', title: 'Name', description: '', type: 'string', group: 'settings.general.general', default: '', order: 0, enabledWhen: { condition: 'tests.settings.available', params: {} } } }
  const reads: ReturnType<typeof deferred<Record<string, ExtensionConditionState>>>[] = []
  const store = scope.run(() => usePluginSettingConditions({
    settingConditions: async () => {
      const result = deferred<Record<string, ExtensionConditionState>>()
      reads.push(result)
      return result.promise
    },
    onConditionsChanged: () => () => {},
  }, shallowRef({ 'tests.settings': { name: '' } })))!
  try {
    const remove = store.observe(field)
    expect(store.states.value[store.key(field)]).toBeUndefined()
    await vi.advanceTimersByTimeAsync(50)
    reads[0]!.resolve({ [field.item.id]: { status: 'ready', value: true } })
    await vi.advanceTimersByTimeAsync(0)
    for (const value of ['e', 'ed', 'editing']) {
      store.draft(field, value)
      expect(store.states.value[store.key(field)]).toEqual({ status: 'ready', value: true })
      await vi.advanceTimersByTimeAsync(50)
      expect(store.states.value[store.key(field)]).toEqual({ status: 'ready', value: true })
    }
    reads[1]!.resolve({ [field.item.id]: { status: 'ready', value: false } })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.states.value[store.key(field)]).toEqual({ status: 'ready', value: true })
    reads[3]!.resolve({ [field.item.id]: { status: 'ready', value: false, reason: 'Disabled' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.states.value[store.key(field)]).toEqual({ status: 'ready', value: false, reason: 'Disabled' })
    store.refresh(field.extensionId)
    await vi.advanceTimersByTimeAsync(50)
    reads[4]!.reject(new Error('unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.states.value[store.key(field)]).toEqual({ status: 'unavailable', value: false })
    remove()
    store.observe({ ...field, revision: 'v2' })
    expect(store.states.value[store.key(field)]).toBeUndefined()
  }
  finally {
    scope.stop()
    vi.useRealTimers()
  }
})

it('refreshes only mounted fields, overlays drafts and rejects responses from an older invalidation or disposed page', async () => {
  vi.useFakeTimers()
  const scope = effectScope()
  const configurations = shallowRef({ 'tests.settings': { enabled: true, name: 'saved' } })
  const field: PluginSettingField = { extensionId: 'tests.settings', revision: 'v1', item: { id: 'tests.settings.name', key: 'name', title: 'Name', description: '', type: 'string', group: 'settings.general.general', default: '', order: 0, enabledWhen: { condition: 'tests.settings.available', params: {} } } }
  const reads: { fields: readonly string[], form: unknown, result: ReturnType<typeof deferred<Record<string, ExtensionConditionState>>> }[] = []
  let changed!: (event: ExtensionConditionsChanged) => void
  let stopped = false
  const store = scope.run(() => usePluginSettingConditions({ settingConditions: async (_id, fields, form) => {
    const result = deferred<Record<string, ExtensionConditionState>>()
    reads.push({ fields, form, result })
    return result.promise
  }, onConditionsChanged: (listener) => {
    changed = listener
    return () => {
      stopped = true
    }
  } }, configurations))!
  try {
    await vi.advanceTimersByTimeAsync(100)
    expect(reads).toHaveLength(0)
    const remove = store.observe(field)
    await vi.advanceTimersByTimeAsync(50)
    changed({ extensionId: 'tests.settings', revision: 1 })
    await vi.advanceTimersByTimeAsync(50)
    reads[1]!.result.resolve({ [field.item.id]: { status: 'ready', value: false } })
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    reads[0]!.result.resolve({ [field.item.id]: { status: 'ready', value: true } })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.states.value[store.key(field)]).toEqual({ status: 'ready', value: false })
    store.draft(field, 'editing')
    await vi.advanceTimersByTimeAsync(50)
    expect(reads[2]).toMatchObject({ fields: [field.item.id], form: { name: 'editing' } })
    expect(configurations.value['tests.settings'].name).toBe('saved')
    remove()
    reads[2]!.result.resolve({ [field.item.id]: { status: 'ready', value: true } })
    await vi.advanceTimersByTimeAsync(100)
    expect(store.states.value).toEqual({})
    expect(reads).toHaveLength(3)
  }
  finally {
    scope.stop()
    vi.useRealTimers()
  }
  expect(stopped).toBe(true)
})

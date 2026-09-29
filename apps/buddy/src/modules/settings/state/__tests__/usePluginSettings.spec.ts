import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionConfiguration } from '@buddy-shared/extensions/extensionSettings'
import type { PluginSettingField } from '../../model/settingsRegistry'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { usePluginSettings } from '../usePluginSettings'
import { useSettingsRegistry } from '../useSettingsRegistry'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
const settle = () => new Promise(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function status(): ExtensionStatus {
  return {
    manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.settings', name: 'Settings', version: '1.0.0', apiVersion: 3, engines: { lexora: '*' }, entry: 'extension.js', contributes: { settings: {
      modules: [{ id: 'tests.settings.module', title: 'Settings' }],
      groups: [{ id: 'tests.settings.group', module: 'tests.settings.module', title: 'Group' }],
      items: [{ id: 'tests.settings.enabled', key: 'enabled', type: 'boolean', title: 'Enabled', group: 'tests.settings.group', default: true }],
    } } }),
    revision: '1',
    enabled: true,
    development: false,
    compatible: true,
    pending: null,
    state: 'inactive',
    generation: null,
    error: null,
    activationMs: null,
    logs: [],
  }
}
function fixture() {
  const scope = effectScope()
  scopes.push(scope)
  const plugin = status()
  const installed = shallowRef([plugin])
  const reads: ReturnType<typeof deferred<ExtensionConfiguration>>[] = []
  const writes: ReturnType<typeof deferred<void>>[] = []
  const store = scope.run(() => usePluginSettings(installed, {
    settingConditions: async () => ({}),
    onConditionsChanged: () => () => {},
    configurationSnapshot: () => {
      const result = deferred<ExtensionConfiguration>()
      reads.push(result)
      return result.promise.then(values => ({ values, invalidKeys: Object.entries(values).filter(([key, value]) => key === 'enabled' && typeof value !== 'boolean').map(([key]) => key) }))
    },
    configure: () => {
      const result = deferred<void>()
      writes.push(result)
      return result.promise
    },
  }))!
  const registry = scope.run(() => useSettingsRegistry(installed))!
  const field: PluginSettingField = { extensionId: plugin.manifest.id, revision: plugin.revision, item: plugin.manifest.contributes.settings.items[0]! }
  return { installed, plugin, store, registry, reads, writes, scope, field }
}

describe('plugin settings configuration lifecycle', () => {
  it('keeps incompatible persisted values editable and clears only a repaired field after a committed write', async () => {
    const f = fixture()
    f.reads[0]!.resolve({ enabled: 'retired', count: 0 })
    await settle()
    expect(f.store.invalidKeys.value['tests.settings']).toEqual(['enabled'])
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: 'retired', count: 0 })
    const save = f.store.save(f.field, false)
    f.writes[0]!.resolve()
    await settle()
    f.reads[1]!.reject(new Error('readback failed'))
    expect(await save).toBe('saved')
    expect(f.store.invalidKeys.value['tests.settings']).toEqual([])
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: false, count: 0 })
    f.installed.value = []
    expect(f.store.invalidKeys.value).toEqual({})
  })
  it('exposes retryable read failures without replacing explicit false, zero or null values', async () => {
    const f = fixture()
    f.reads[0]!.reject(new Error('private detail'))
    await settle()
    expect([...f.store.errors.value]).toEqual(['tests.settings'])
    expect(f.store.loading.value.size).toBe(0)
    const retry = f.store.reload('tests.settings')
    f.reads[1]!.resolve({ enabled: false, model: null, count: 0 })
    await retry
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: false, model: null, count: 0 })
    expect(f.store.errors.value.size).toBe(0)
  })

  it('retains persisted values after a failed save and permits a successful retry', async () => {
    const f = fixture()
    f.reads[0]!.resolve({ enabled: false })
    await settle()
    const failed = f.store.save(f.field, true)
    f.writes[0]!.reject(new Error('write failed'))
    expect(await failed).toBe('failed')
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: false })
    expect(f.store.pending.value.size).toBe(0)
    const retry = f.store.save(f.field, true)
    f.writes[1]!.resolve()
    await settle()
    f.reads[1]!.resolve({ enabled: true })
    expect(await retry).toBe('saved')
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: true })
  })

  it('distinguishes a committed write from a failed readback and permits resynchronization', async () => {
    const f = fixture()
    f.reads[0]!.resolve({ enabled: false })
    await settle()
    const save = f.store.save(f.field, true)
    f.writes[0]!.resolve()
    await settle()
    f.reads[1]!.reject(new Error('readback failed'))
    expect(await save).toBe('saved')
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: true })
    expect(f.store.errors.value.has('tests.settings')).toBe(true)
    const retry = f.store.reload('tests.settings')
    f.reads[2]!.resolve({ enabled: true })
    await retry
    expect(f.store.errors.value.size).toBe(0)
  })

  it('does not let a background read overwrite a newer save or rebuild unchanged registrations', async () => {
    const f = fixture()
    f.reads[0]!.resolve({ enabled: false })
    await settle()
    const modules = f.registry.modules.value
    f.installed.value = [{ ...f.plugin, state: 'active' }]
    expect(f.registry.modules.value).toBe(modules)
    const save = f.store.save(f.field, true)
    f.writes[0]!.resolve()
    await settle()
    f.reads[2]!.resolve({ enabled: true })
    await save
    f.reads[1]!.resolve({ enabled: false })
    await settle()
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: true })
    expect(f.store.loading.value.size).toBe(0)
  })

  it('withdraws disabled contributions and ignores old writes after enabling a new instance', async () => {
    const f = fixture()
    f.reads[0]!.resolve({ enabled: false })
    await settle()
    const oldSave = f.store.save(f.field, true)
    f.installed.value = [{ ...f.plugin, enabled: false }]
    expect(f.registry.modules.value.some(module => module.id === 'tests.settings.module')).toBe(false)
    expect(f.store.configurations.value).toEqual({})
    f.installed.value = [f.plugin]
    f.reads[1]!.resolve({ enabled: false })
    await settle()
    const newSave = f.store.save(f.field, true)
    f.writes[0]!.resolve()
    expect(await oldSave).toBe('stale')
    expect(f.store.pending.value.has('tests.settings')).toBe(true)
    f.writes[1]!.resolve()
    await settle()
    f.reads[2]!.resolve({ enabled: true })
    expect(await newSave).toBe('saved')
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: true })
  })

  it('rejects stale revision fields and late reads after disposal', async () => {
    const f = fixture()
    f.installed.value = [{ ...f.plugin, revision: '2' }]
    expect(await f.store.save(f.field, true)).toBe('stale')
    f.reads[1]!.resolve({ enabled: false })
    await settle()
    f.reads[0]!.resolve({ enabled: true })
    await settle()
    expect(f.store.configurations.value['tests.settings']).toEqual({ enabled: false })
    const pending = f.store.reload('tests.settings')
    f.scope.stop()
    f.reads[2]!.reject(new Error('disposed request'))
    await pending
    expect(f.store.errors.value.size).toBe(0)
  })
})

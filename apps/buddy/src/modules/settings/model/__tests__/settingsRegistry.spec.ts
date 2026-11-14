import type { SettingsContribution } from '../settingsRegistry'
import { extensionSettingItemSchema } from '@buddy-shared/extensions/extensionSettings'
import { builtinSettingsModuleIds } from '@buddy-shared/settings/settingsCatalog'
import { describe, expect, it } from 'vitest'
import { builtinSettings } from '../builtinSettings'
import { extensionSettingsLocation } from '../settingsNavigation'
import { SettingsRegistry } from '../settingsRegistry'

function plugin(): SettingsContribution {
  const item = extensionSettingItemSchema.parse({ id: 'tests.settings.inline', key: 'enabled', type: 'boolean', title: 'Inline', group: 'settings.general.general', default: false })
  return {
    modules: [{ id: 'tests.settings.module', title: 'Plugin', order: 0, section: 'plugins', requiresRuntime: false }],
    groups: [{ id: 'tests.settings.group', module: 'tests.settings.module', title: 'Group', order: 0 }, { id: 'tests.settings.extra', module: 'settings.general', title: 'Extra', order: 5 }],
    items: [{ id: item.id, group: item.group, order: -1, kind: 'plugin', field: { extensionId: 'tests.settings', revision: '1', item } }],
  }
}

describe('settings registry', () => {
  it('registers and withdraws an integration module while rejecting foreign view ownership', () => {
    const registry = new SettingsRegistry()
    registry.register('settings', builtinSettings)
    const module = { ...plugin().modules[0]!, section: 'integrations' as const, view: 'tests.settings.view' }
    const dispose = registry.register('tests.settings', { modules: [module], groups: [], items: [] })
    expect(registry.modules.find(item => item.id === module.id)).toMatchObject({ section: 'integrations', view: module.view, owner: 'tests.settings' })
    expect(() => registry.register('tests.settings', { modules: [{ ...module, view: 'other.plugin.view' }], groups: [], items: [] })).toThrow()
    dispose()
    expect(extensionSettingsLocation(registry.modules, 'tests.settings')).toBeNull()
  })

  it('rejects conflicting IDs, missing parents and cross-owner parents without partial publication', () => {
    const registry = new SettingsRegistry()
    registry.register('settings', builtinSettings)
    const contribution = plugin()
    registry.register('tests.settings', contribution)
    const before = registry.modules
    const attempts: SettingsContribution[] = [
      { ...contribution, modules: [{ ...contribution.modules[0]!, id: 'settings.general' }] },
      { ...contribution, groups: [{ ...contribution.groups[0]!, module: 'other.plugin.module' }] },
      { ...contribution, groups: [{ ...contribution.groups[0]!, id: contribution.modules[0]!.id }] },
      { ...contribution, items: [{ ...contribution.items[0]!, group: 'settings.logs.content' }] },
      { ...contribution, items: [{ id: 'tests.settings.content', group: 'tests.settings.group', order: 0, kind: 'content' }] },
    ]
    for (const attempt of attempts) {
      expect(() => registry.register('tests.settings', attempt)).toThrow()
      expect(registry.modules).toBe(before)
    }
  })

  it('atomically replaces an owner and prevents an old disposer from removing its replacement', () => {
    const registry = new SettingsRegistry()
    registry.register('settings', builtinSettings)
    const original = plugin()
    const disposeOld = registry.register('tests.settings', original)
    const disposeNew = registry.register('tests.settings', { ...original, modules: [{ ...original.modules[0]!, title: 'Updated' }] })
    disposeOld()
    expect(registry.modules.find(module => module.id === 'tests.settings.module')!.title).toBe('Updated')
    disposeNew()
    expect(registry.modules.map(module => module.id)).toEqual(builtinSettingsModuleIds)
    expect(registry.modules[0]!.groups.flatMap(group => group.items).every(item => item.kind !== 'plugin')).toBe(true)
    const disposeFirst = registry.register('tests.settings', original)
    registry.register('tests.settings', original)
    disposeFirst()
    expect(registry.modules.some(module => module.id === 'tests.settings.module')).toBe(true)
  })
})

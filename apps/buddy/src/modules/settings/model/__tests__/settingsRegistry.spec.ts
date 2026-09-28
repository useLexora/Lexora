import type { SettingsContribution } from '../settingsRegistry'
import { extensionSettingItemSchema } from '@buddy-shared/extensions/extensionSettings'
import { builtinSettingsModuleIds, publicSettingsGroups } from '@buddy-shared/settings/settingsCatalog'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { settingsRoutes } from '../../routes'
import { builtinSettings } from '../builtinSettings'
import { extensionSettingsLocation } from '../settingsNavigation'
import { SettingsRegistry, settingsText } from '../settingsRegistry'

function plugin(): SettingsContribution {
  const item = extensionSettingItemSchema.parse({ id: 'tests.settings.inline', key: 'enabled', type: 'boolean', title: 'Inline', group: 'settings.general.general', default: false })
  return {
    modules: [{ id: 'tests.settings.module', title: 'Plugin', order: 0, section: 'plugins', requiresRuntime: false }],
    groups: [{ id: 'tests.settings.group', module: 'tests.settings.module', title: 'Group', order: 0 }, { id: 'tests.settings.extra', module: 'settings.general', title: 'Extra', order: 5 }],
    items: [{ id: item.id, group: item.group, order: -1, kind: 'plugin', field: { extensionId: 'tests.settings', revision: '1', item } }],
  }
}

describe('settings registry', () => {
  it('opens an owned module, a builtin group or an inline field only for registered owners', () => {
    const registry = new SettingsRegistry()
    registry.register('settings', builtinSettings)
    const contribution = plugin()
    const dispose = registry.register('tests.settings', contribution)
    expect(extensionSettingsLocation(registry.modules, 'tests.settings')).toEqual({ name: 'desktop.settings.plugin', params: { moduleId: 'tests.settings.module' } })
    expect(extensionSettingsLocation(registry.modules, 'tests')).toBeNull()
    registry.register('tests.settings', { ...contribution, modules: [], groups: [{ ...contribution.groups[1]!, module: 'settings.runtime' }] })
    dispose()
    expect(extensionSettingsLocation(registry.modules, 'tests.settings')).toEqual({ name: 'desktop.settings.runtime', query: { group: 'tests.settings.extra' } })
    const remove = registry.register('tests.settings', { ...contribution, modules: [], groups: [] })
    expect(extensionSettingsLocation(registry.modules, 'tests.settings')).toEqual({ name: 'desktop.settings.general', query: { group: 'settings.general.general' } })
    remove()
    expect(extensionSettingsLocation(registry.modules, 'tests.settings')).toBeNull()
  })
  it('projects builtins and extensions into one ordered module/group/item tree', () => {
    const registry = new SettingsRegistry()
    registry.register('settings', builtinSettings)
    registry.register('tests.settings', plugin())
    const general = registry.modules.find(module => module.id === 'settings.general')!
    expect(general.groups.map(group => group.id)).toEqual(['settings.general.general', 'tests.settings.extra', 'settings.general.context-panel'])
    expect(general.groups[0]!.items.map(item => item.id)).toEqual(['tests.settings.inline', 'settings.general.language'])
    expect(registry.modules.find(module => module.id === 'tests.settings.module')!.groups[0]!.id).toBe('tests.settings.group')
    expect(settingsText(general.title, 'zh-CN')).toBe('常规')
    expect(settingsText(general.title, 'en-US')).toBe('General')
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

  it('keeps all public targets and existing builtin URLs/names backed by registered definitions', () => {
    const registry = new SettingsRegistry()
    registry.register('settings', builtinSettings)
    const router = createRouter({ history: createMemoryHistory(), routes: [...settingsRoutes] })
    for (const module of registry.modules) {
      const route = router.resolve({ name: `desktop.settings.${module.category}` })
      expect(route.path).toBe(`/settings/${module.category}`)
      expect(route.meta.settingsModule).toBe(module.id)
      expect(settingsText(module.description, 'en-US')).not.toContain('desktop.')
    }
    for (const [group, module] of Object.entries(publicSettingsGroups))
      expect(registry.modules.find(entry => entry.id === module)!.groups.some(entry => entry.id === group)).toBe(true)
    expect(router.resolve('/settings/models/example').meta.settingsModule).toBe('settings.models')
    expect(router.resolve('/settings/plugins/tests.settings.module').params.moduleId).toBe('tests.settings.module')
    expect(router.resolve('/settings/app').matched.at(-1)!.redirect).toEqual({ name: 'desktop.settings.general' })
    expect(router.resolve('/settings/extensions').matched.at(-1)!.redirect).toEqual({ name: 'desktop.extensions' })
  })
})

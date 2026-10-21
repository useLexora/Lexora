import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useSettingsRegistry } from '../useSettingsRegistry'

function plugin(): ExtensionStatus {
  const id = 'tests.shell-settings'
  return {
    manifest: extensionManifestSchema.parse({
      schemaVersion: 1,
      id,
      name: 'Shells',
      version: '1.0.0',
      apiVersion: 4,
      engines: { lexora: '*' },
      permissions: { shells: true },
      contributes: {
        shells: { settingsGroup: `${id}.execution`, candidates: [{ id: 'bash', enabled: 'enabled', executable: 'executable', priority: 'priority' }] },
        settings: {
          groups: [{ id: `${id}.execution`, module: 'settings.runtime', title: 'Shells' }],
          items: [
            { id: `${id}.enabled`, group: `${id}.execution`, key: 'enabled', title: 'Enabled', type: 'boolean', default: false },
            { id: `${id}.executable`, group: `${id}.execution`, key: 'executable', title: 'Executable', type: 'string', default: '' },
            { id: `${id}.priority`, group: `${id}.execution`, key: 'priority', title: 'Priority', type: 'number', min: 0, max: 100, default: 0 },
          ],
        },
      },
    }),
    revision: 'one',
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

describe('shell settings registration', () => {
  it('registers the declared native table in Runtime with its original configuration keys and owner', () => {
    const scope = effectScope()
    try {
      const installed = shallowRef([plugin()])
      const registry = scope.run(() => useSettingsRegistry(installed))!
      const id = installed.value[0]!.manifest.id
      const runtime = registry.modules.value.find(module => module.id === 'settings.runtime')!
      const group = runtime.groups.find(group => group.owner === id)!
      expect(group.shells).toEqual({ extensionId: id, revision: 'one', candidates: [{ id: 'bash', enabled: 'enabled', executable: 'executable', priority: 'priority' }] })
      expect(group.items.map(item => item.kind === 'plugin' && item.field.item.key).sort()).toEqual(['enabled', 'executable', 'priority'])
      expect(registry.extensionLocation(id)).toEqual({ name: 'desktop.settings.runtime', query: { group: `${id}.execution` } })
      expect(registry.modules.value.some(module => module.owner === id)).toBe(false)
    }
    finally { scope.stop() }
  })

  it('revokes the table on disable, incompatibility and removal, and refreshes package-bound fields after update', () => {
    const scope = effectScope()
    try {
      const original = plugin()
      const installed = shallowRef([original])
      const registry = scope.run(() => useSettingsRegistry(installed))!
      const groups = () => registry.modules.value.flatMap(module => module.groups).filter(group => group.owner === original.manifest.id)
      installed.value = [{ ...original, enabled: false }]
      expect(groups()).toEqual([])
      installed.value = [{ ...original, compatible: false }]
      expect(groups()).toEqual([])
      installed.value = [{ ...original, revision: 'two' }]
      expect(groups()[0]!.shells?.revision).toBe('two')
      expect(groups()[0]!.items.every(item => item.kind === 'plugin' && item.field.revision === 'two')).toBe(true)
      installed.value = []
      expect(groups()).toEqual([])
    }
    finally { scope.stop() }
  })
})

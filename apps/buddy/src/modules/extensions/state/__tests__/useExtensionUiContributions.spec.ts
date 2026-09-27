import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { parseWorkbenchUiSelection, workbenchUiSelectionKey, workbenchUiTargetCatalog } from '@buddy-shared/workbench/workbenchUi'
import { expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { useExtensionUiContributions } from '../useExtensionUiContributions'

it('discovers contributions automatically, preserves legacy ordering and isolates runtime overrides by generation', () => {
  const manifest = extensionManifestSchema.parse({ schemaVersion: 1, apiVersion: 3, id: 'tests.accessories', name: 'Accessories', version: '1.0.0', engines: { lexora: '*' }, contributes: {
    views: [{ id: 'tests.accessories.view', title: 'Panel', entry: 'view.js', resource: 'none' }],
    placements: ['first', 'second', 'optional'].map(name => ({ id: `tests.accessories.${name}`, view: 'tests.accessories.view', kind: 'slot', target: 'composer.accessory', ...(name === 'optional' ? { enabled: false } : {}) })),
  } })
  const status: ExtensionStatus = { manifest, revision: 'one', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] }
  const installed = shallowRef([status])
  const controller = new WorkbenchController(new ContributionRegistry())
  controller.registry.register('configuration', scope => workbenchUiTargetCatalog.forEach(target => scope.configuration({ id: workbenchUiSelectionKey(target), defaultValue: '', validate: value => parseWorkbenchUiSelection(value, target.selection === 'multiple') !== null })))
  const scope = effectScope()
  const ui = scope.run(() => useExtensionUiContributions(installed, controller.configuration))!
  const target = { kind: 'slot', target: 'composer.accessory' } as const
  const ids = () => ui.providers(target).filter(provider => provider.enabled).map(provider => provider.placement.id)
  try {
    expect(ids()).toEqual(['tests.accessories.first', 'tests.accessories.second'])
    const previous = ['tests.accessories.second', 'tests.accessories.first']
    controller.configuration.set(workbenchUiSelectionKey(target), JSON.stringify(previous))
    expect(ids()).toEqual(previous)
    expect(ui.setEnabled('tests.other', status.generation!, previous[0]!, false)).toBeNull()
    expect(ui.setEnabled(manifest.id, crypto.randomUUID(), previous[0]!, false)).toBeNull()
    expect(ui.setEnabled(manifest.id, status.generation!, previous[0]!, false)).toEqual({ changed: true })
    expect(ids()).toEqual([previous[1]])
    expect(ui.setEnabled(manifest.id, status.generation!, 'tests.accessories.optional', true)).toEqual({ changed: true })
    expect(ids()).toEqual([previous[1], 'tests.accessories.optional'])
    installed.value = [{ ...status }]
    expect(ids()).toEqual([previous[1], 'tests.accessories.optional'])
    installed.value = [{ ...status, generation: crypto.randomUUID() }]
    expect(ids()).toEqual(previous)
    expect(controller.configuration.get(workbenchUiSelectionKey(target))).toBe(JSON.stringify(previous))
    installed.value = [{ ...status, enabled: false }]
    expect(ui.providers(target)).toEqual([])
  }
  finally { scope.stop() }
})

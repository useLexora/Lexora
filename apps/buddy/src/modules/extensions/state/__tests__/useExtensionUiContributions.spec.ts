import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { parseWorkbenchUiSelection, workbenchUiSelectionKey, workbenchUiTargetCatalog } from '@buddy-shared/workbench/workbenchUi'
import { expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { useExtensionUiContributions } from '../useExtensionUiContributions'

it('retains ordered selections through disabled providers and rejects malformed settings', () => {
  const manifest = extensionManifestSchema.parse({ schemaVersion: 1, apiVersion: 3, id: 'tests.accessories', name: 'Accessories', version: '1.0.0', engines: { lexora: '*' }, contributes: {
    views: [{ id: 'tests.accessories.view', title: 'Panel', entry: 'view.js', resource: 'none' }],
    placements: ['first', 'second'].map(name => ({ id: `tests.accessories.${name}`, view: 'tests.accessories.view', kind: 'slot', target: 'composer.accessory' })),
  } })
  const status: ExtensionStatus = { manifest, revision: 'one', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] }
  const installed = shallowRef([status])
  const controller = new WorkbenchController(new ContributionRegistry())
  controller.registry.register('configuration', scope => workbenchUiTargetCatalog.forEach(target => scope.configuration({ id: workbenchUiSelectionKey(target), defaultValue: '', validate: value => parseWorkbenchUiSelection(value, target.selection === 'multiple') !== null })))
  const scope = effectScope()
  const ui = scope.run(() => useExtensionUiContributions(installed, controller.configuration))!
  const target = { kind: 'slot', target: 'composer.accessory' } as const
  const selected = ['tests.accessories.second', 'tests.accessories.first']
  try {
    ui.choose(target, selected)
    expect(ui.selected(target).map(provider => provider.placement.id)).toEqual(selected)
    expect(() => controller.configuration.set(workbenchUiSelectionKey(target), 'unparsed')).toThrow()
    ui.choose(target, [selected[0]!, selected[0]!])
    expect(ui.selected(target).map(provider => provider.placement.id)).toEqual(selected)
    installed.value = [{ ...status, enabled: false }]
    expect(ui.selected(target)).toEqual([])
    expect(controller.configuration.get(workbenchUiSelectionKey(target))).toBe(JSON.stringify(selected))
    ui.choose(target, [selected[1]!])
    installed.value = [status]
    expect(ui.selected(target).map(provider => provider.placement.id)).toEqual([selected[1]])
  }
  finally { scope.stop() }
})

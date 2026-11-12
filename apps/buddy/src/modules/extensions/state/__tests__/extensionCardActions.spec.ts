import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { expect, it } from 'vitest'
import { extensionCardActions } from '../extensionCardActions'

function plugin(id = 'tests.cleanup'): ExtensionStatus {
  return {
    manifest: extensionManifestSchema.parse({ schemaVersion: 1, id, name: 'Fixture', version: '1.0.0', apiVersion: 4, engines: { lexora: '^0.21.0' }, entry: 'main.js', contributes: {
      commands: [{ id: `${id}.run`, title: 'Run', hidden: true }],
      menus: [{ id: `${id}.action`, command: `${id}.run`, target: 'extension.actions' }, { id: `${id}.task`, command: `${id}.run`, target: 'task.actions' }],
    } }),
    registeredCommands: [`${id}.run`],
    revision: 'fixture',
    enabled: true,
    compatible: true,
    development: false,
    pending: null,
    state: 'active',
    generation: 'fixture',
    error: null,
    activationMs: null,
    logs: [],
  }
}

it('projects only this plugin card actions, not other plugins or task menu entries', () => {
  const first = plugin()
  const other = plugin('tests.other')
  expect(extensionCardActions(first).map(item => item.key)).toEqual(['tests.cleanup.action'])
  expect(extensionCardActions(other).map(item => item.key)).toEqual(['tests.other.action'])
  first.manifest.contributes.menus[0]!.command = 'tests.other.run'
  expect(extensionCardActions(first)).toEqual([])
})

it('hides the submenu for disabled, failed, incompatible or unregistered contributions', () => {
  for (const patch of [{ enabled: false }, { compatible: false }, { state: 'failed' as const }, { state: 'inactive' as const }, { state: 'activating' as const }, { registeredCommands: [] }])
    expect(extensionCardActions({ ...plugin(), ...patch })).toEqual([])
  const conditional = plugin()
  conditional.manifest.contributes.menus[0]!.when = { 'workbench.page': 'extensions' }
  expect(extensionCardActions(conditional)).toEqual([])
  expect(extensionCardActions(conditional, { 'workbench.page': 'extensions' })).toHaveLength(1)
})

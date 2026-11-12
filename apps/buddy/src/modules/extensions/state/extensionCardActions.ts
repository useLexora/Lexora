import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchContextValues } from '@buddy-shared/workbench/workbenchContext'
import { matchesWorkbenchContext } from '@buddy-shared/workbench/workbenchContext'

export function extensionCardActions(plugin: ExtensionStatus, values: WorkbenchContextValues = {}) {
  if (!plugin.enabled || !plugin.compatible || plugin.incompatibility || plugin.state !== 'active')
    return []
  return plugin.manifest.contributes.menus.flatMap((menu) => {
    const command = plugin.manifest.contributes.commands.find(command => command.id === menu.command)
    return menu.target === 'extension.actions' && command && plugin.registeredCommands?.includes(command.id) && matchesWorkbenchContext(menu.when, values) && matchesWorkbenchContext(command.when, values)
      ? [{ key: menu.id, label: command.title, order: menu.order, props: { 'role': 'menuitem', 'data-extension-action': menu.id } }]
      : []
  }).sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
}

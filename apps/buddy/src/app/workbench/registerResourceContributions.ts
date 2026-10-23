import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskResourcePanel } from '@/modules/tasks/contracts'
import type { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { translateBuddy } from '@/i18n/buddyI18n'

export function registerResourceContributions(registry: ContributionRegistry, panel: () => TaskResourcePanel, language: () => BuddyLocale) {
  return registry.register('lexora.resource-panel', (scope) => {
    const entries = [
      { id: 'changes', icon: 'changes', enabled: () => panel().canAddChanges.value, execute: () => panel().openChanges() },
      { id: 'files', icon: 'folder', enabled: () => Boolean(panel().fileEntry.value), execute: () => panel().requestFiles() },
      { id: 'browser', icon: 'browser', enabled: () => true, execute: () => panel().addBrowser() },
    ] as const
    for (const [index, entry] of entries.entries()) {
      const label = () => translateBuddy(language(), `desktop.context.${entry.id}`)
      const command = `resource.${entry.id}`
      scope.command({ id: command, label, enabled: entry.enabled, execute: entry.execute })
      scope.launcher({ id: entry.id, label, command, icon: entry.icon, order: index - entries.length, when: entry.enabled })
    }
  })
}

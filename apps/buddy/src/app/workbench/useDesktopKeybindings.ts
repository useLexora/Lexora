import type { ApplicationSettings, ShortcutSettings } from '@/modules/settings/contracts'
import type { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { conflictingShortcuts, isKeybinding } from '@buddy-shared/shortcuts/keybinding'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { commandKeybinding, commandLabel } from '@/workbench/common/workbench'

export function useDesktopKeybindings(registry: ContributionRegistry, settings: ApplicationSettings, platform: () => string): ShortcutSettings {
  const revision = shallowRef(0)
  onScopeDispose(registry.subscribe(() => revision.value++))
  const bindings = computed(() => {
    void revision.value
    return Object.fromEntries([...registry.commands.values()].map(command => [command.id, Object.hasOwn(settings.config.value?.desktop.keybindings ?? {}, command.id) ? [settings.config.value!.desktop.keybindings[command.id]!] : [commandKeybinding(command) ?? '', ...command.alternateKeybindings ?? []]]))
  })
  const entries = computed(() => {
    void revision.value
    return [...registry.commands.values()].map(command => ({
      id: command.id,
      label: commandLabel(command),
      binding: bindings.value[command.id]?.[0] ?? '',
      alternatives: bindings.value[command.id]?.slice(1) ?? [],
      defaultBinding: commandKeybinding(command) ?? '',
      scope: command.shortcutScope ?? 'workbench',
      modified: Object.hasOwn(settings.config.value?.desktop.keybindings ?? {}, command.id),
    }))
  })
  async function set(id: string, binding: string | null): Promise<boolean> {
    const command = registry.commands.get(id)
    const candidates = binding === null ? [commandKeybinding(command) ?? '', ...command?.alternateKeybindings ?? []] : [binding]
    if (!command || candidates.some(candidate => !isKeybinding(candidate) || conflictingShortcuts(entries.value, id, candidate, platform()).length))
      return false
    const next = { ...settings.config.value?.desktop.keybindings }
    if (binding === null || (binding === commandKeybinding(command) && !command.alternateKeybindings?.length))
      delete next[id]
    else
      next[id] = binding
    return settings.updateSettings({ desktop: { keybindings: next } })
  }
  return { entries, bindings, platform: computed(platform), set, reset: () => settings.updateSettings({ desktop: { keybindings: {} } }) }
}

import type { ExtensionSettingItem } from '@buddy-shared/extensions/extensionSettings'
import type { BuiltinSettingsCategory } from '@buddy-shared/settings/settingsCatalog'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { builtinSettingsModuleIds, publicSettingsGroups } from '@buddy-shared/settings/settingsCatalog'

export type SettingsText = string | ((language: BuddyLocale) => string)
export type SettingsSection = 'plugins' | 'personal' | 'ai' | 'integrations' | 'system'
export type GeneralSettingField = 'language' | 'contextPanelMode' | 'contextPanelGlobal'

export interface SettingsModule {
  id: string
  title: SettingsText
  description?: SettingsText
  section: SettingsSection
  order: number
  category?: BuiltinSettingsCategory
  page?: Exclude<BuiltinSettingsCategory, 'general'>
  requiresRuntime: boolean
  fill?: boolean
}

export interface SettingsGroup {
  id: string
  module: string
  title?: SettingsText
  order: number
  unframed?: boolean
}

export interface PluginSettingField {
  extensionId: string
  revision: string
  item: ExtensionSettingItem
}

export type SettingsItem = { id: string, group: string, order: number } & (
  | { kind: 'content' }
  | { kind: 'general', field: GeneralSettingField }
  | { kind: 'plugin', field: PluginSettingField }
)

export interface SettingsContribution {
  modules: readonly SettingsModule[]
  groups: readonly SettingsGroup[]
  items: readonly SettingsItem[]
}

export interface SettingsGroupNode extends SettingsGroup { owner: string, items: readonly SettingsItem[] }
export interface SettingsModuleNode extends SettingsModule { owner: string, groups: readonly SettingsGroupNode[] }

export class SettingsRegistry {
  readonly #owners = new Map<string, SettingsContribution>()
  readonly #listeners = new Set<() => void>()
  #modules: readonly SettingsModuleNode[] = []

  get modules(): readonly SettingsModuleNode[] { return this.#modules }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  register(owner: string, contribution: SettingsContribution): () => void {
    const registration = { modules: contribution.modules.map(module => ({ ...module })), groups: contribution.groups.map(group => ({ ...group })), items: contribution.items.map(item => ({ ...item })) }
    const next = new Map(this.#owners).set(owner, registration)
    this.#validate(next)
    this.#owners.set(owner, registration)
    this.#publish()
    return () => {
      if (this.#owners.get(owner) !== registration)
        return
      this.#owners.delete(owner)
      this.#publish()
    }
  }

  #validate(owners: ReadonlyMap<string, SettingsContribution>): void {
    const ids = new Set<string>()
    for (const [owner, contribution] of owners) {
      const builtin = owner === 'settings'
      for (const entry of [...contribution.modules, ...contribution.groups, ...contribution.items]) {
        if (!entry.id.startsWith(`${owner}.`) || ids.has(entry.id))
          throw new Error(`Invalid or duplicate settings ID: ${entry.id}`)
        ids.add(entry.id)
      }
      const modules = new Set(contribution.modules.map(module => module.id))
      if (!builtin && contribution.modules.some(module => module.category || module.page || module.section !== 'plugins'))
        throw new Error(`Invalid settings module owner: ${owner}`)
      const groups = new Set(contribution.groups.map(group => group.id))
      for (const group of contribution.groups) {
        if (!modules.has(group.module) && (builtin || !builtinSettingsModuleIds.includes(group.module)))
          throw new Error(`Unknown settings module: ${group.module}`)
      }
      for (const item of contribution.items) {
        if (!groups.has(item.group) && (builtin || !Object.hasOwn(publicSettingsGroups, item.group)))
          throw new Error(`Unknown settings group: ${item.group}`)
        if (!builtin && (item.kind !== 'plugin' || item.field.extensionId !== owner))
          throw new Error(`Invalid settings renderer: ${item.id}`)
      }
    }
  }

  #publish(): void {
    const contributions = [...this.#owners.entries()]
    const groups = contributions.flatMap(([owner, entry]) => entry.groups.map(group => ({ ...group, owner }))).sort(compareSettingsOrder)
    const items = contributions.flatMap(([, entry]) => [...entry.items]).sort(compareSettingsOrder)
    this.#modules = contributions.flatMap(([owner, entry]) => entry.modules.map(module => ({ ...module, owner }))).sort(compareSettingsOrder).map(module => ({
      ...module,
      groups: groups.filter(group => group.module === module.id).map(group => ({
        ...group,
        items: items.filter(item => item.group === group.id),
      })),
    }))
    for (const listener of this.#listeners) listener()
  }
}

export function compareSettingsOrder(a: { order: number, id: string }, b: { order: number, id: string }): number {
  return a.order - b.order || a.id.localeCompare(b.id, 'en')
}

export function settingsText(value: SettingsText | undefined, language: BuddyLocale): string {
  return typeof value === 'function' ? value(language) : value ?? ''
}

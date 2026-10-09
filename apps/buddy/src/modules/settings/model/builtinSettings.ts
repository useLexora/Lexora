import type { GeneralSettingField, SettingsContribution, SettingsText } from './settingsRegistry'
import type { BuddyI18nKey } from '@/i18n/buddyI18n'
import { builtinSettingsCatalog, builtinSettingsCategories } from '@buddy-shared/settings/settingsCatalog'
import { translateBuddy } from '@/i18n/buddyMessages'

const text = (key: BuddyI18nKey): SettingsText => language => translateBuddy(language, key)

export const builtinSettings = {
  modules: builtinSettingsCategories.map((category, order) => ({
    id: `settings.${category}`,
    category,
    page: category === 'general' ? undefined : category,
    ...builtinSettingsCatalog[category],
    order,
    fill: category === 'logs' || category === 'prompts',
    title: text(`desktop.settings.category.${category}`),
    description: text(category === 'logs' ? 'applicationLogs.description' : category === 'usage' ? 'usageAnalytics.description' : category === 'skills' ? 'desktop.skills.description' : `desktop.settings.categoryDescription.${category}`),
  })),
  groups: [
    { id: 'settings.general.general', module: 'settings.general', title: text('desktop.settings.category.general'), order: 0 },
    { id: 'settings.general.context-panel', module: 'settings.general', title: text('desktop.settings.contextPanel'), order: 10 },
    ...builtinSettingsCategories.filter(category => category !== 'general').map(category => ({
      id: `settings.${category}.content`,
      module: `settings.${category}`,
      order: -1000,
      unframed: true,
    })),
  ],
  items: [
    ...(['language', 'contextPanelMode', 'contextPanelGlobal'] as GeneralSettingField[]).map((field, order) => ({
      id: `settings.general.${field}`,
      group: field === 'language' ? 'settings.general.general' : 'settings.general.context-panel',
      order,
      kind: 'general' as const,
      field,
    })),
    ...builtinSettingsCategories.filter(category => category !== 'general').map(category => ({
      id: `settings.${category}.body`,
      group: `settings.${category}.content`,
      order: 0,
      kind: 'content' as const,
    })),
  ],
} satisfies SettingsContribution

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
    title: category === 'file-opening' ? language => language === 'en-US' ? 'Open with' : '打开方式' : text(`desktop.settings.category.${category}`),
    description: category === 'file-opening'
      ? language => language === 'en-US' ? 'Choose how each file type is previewed and opened separately.' : '按文件类型分别设置文件内预览和独立打开方式。'
      : text(category === 'logs' ? 'applicationLogs.description' : category === 'usage' ? 'usageAnalytics.description' : category === 'skills' ? 'desktop.skills.description' : `desktop.settings.categoryDescription.${category}`),
  })),
  groups: [
    { id: 'settings.general.general', module: 'settings.general', title: text('desktop.settings.category.general'), order: 0 },
    { id: 'settings.general.context-panel', module: 'settings.general', title: text('desktop.settings.contextPanel'), order: 10 },
    { id: 'settings.general.composer', module: 'settings.general', title: text('desktop.settings.conversationInput'), order: 20 },
    ...builtinSettingsCategories.filter(category => category !== 'general').map(category => ({
      id: `settings.${category}.content`,
      module: `settings.${category}`,
      order: -1000,
      unframed: true,
    })),
  ],
  items: [
    { id: 'settings.general.pasteTextAsAttachment', group: 'settings.general.composer', order: 0, kind: 'general', field: 'pasteTextAsAttachment' },
    ...(['language', 'contextPanelMode', 'contextPanelGlobal', 'contextPanelAutoCollapse'] as GeneralSettingField[]).map((field, order) => ({
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

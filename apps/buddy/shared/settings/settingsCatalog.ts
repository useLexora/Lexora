export const builtinSettingsCatalog = {
  general: { section: 'personal', requiresRuntime: false },
  appearance: { section: 'personal', requiresRuntime: false },
  notifications: { section: 'personal', requiresRuntime: false },
  pet: { section: 'personal', requiresRuntime: true },
  shortcuts: { section: 'personal', requiresRuntime: false },
  models: { section: 'ai', requiresRuntime: true },
  runtime: { section: 'ai', requiresRuntime: false },
  prompts: { section: 'ai', requiresRuntime: true },
  mcp: { section: 'ai', requiresRuntime: true },
  skills: { section: 'ai', requiresRuntime: true },
  usage: { section: 'ai', requiresRuntime: true },
  web: { section: 'integrations', requiresRuntime: true },
  browser: { section: 'integrations', requiresRuntime: false },
  proxy: { section: 'system', requiresRuntime: false },
  logs: { section: 'system', requiresRuntime: false },
  about: { section: 'system', requiresRuntime: false },
} as const

export type BuiltinSettingsCategory = keyof typeof builtinSettingsCatalog
export const builtinSettingsCategories = Object.keys(builtinSettingsCatalog) as BuiltinSettingsCategory[]
export const builtinSettingsModuleIds = builtinSettingsCategories.map(category => `settings.${category}`)
export const publicSettingsGroups: Readonly<Record<string, string>> = {
  'settings.general.general': 'settings.general',
  'settings.general.context-panel': 'settings.general',
}

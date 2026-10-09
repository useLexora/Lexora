import type { BuiltinSettingsCategory } from '@buddy-shared/settings/settingsCatalog'
import type { Component } from 'vue'
import { defineAsyncComponent } from 'vue'

export const settingsPageRenderers: Record<Exclude<BuiltinSettingsCategory, 'general'>, Component> = {
  appearance: defineAsyncComponent(() => import('./DesktopAppearanceSettingsView.vue')),
  notifications: defineAsyncComponent(() => import('./DesktopNotificationsSettingsView.vue')),
  pet: defineAsyncComponent(() => import('./DesktopPetSettingsView.vue')),
  shortcuts: defineAsyncComponent(() => import('./DesktopShortcutsSettingsView.vue')),
  models: defineAsyncComponent(() => import('./DesktopModelsSettingsView.vue')),
  prompts: defineAsyncComponent(() => import('./DesktopPromptsSettingsView.vue')),
  runtime: defineAsyncComponent(() => import('./DesktopRuntimeSettingsView.vue')),
  mcp: defineAsyncComponent(() => import('./DesktopMcpSettingsView.vue')),
  skills: defineAsyncComponent(() => import('./DesktopSkillsSettingsView.vue')),
  usage: defineAsyncComponent(() => import('./DesktopUsageSettingsView.vue')),
  web: defineAsyncComponent(() => import('./DesktopWebSettingsView.vue')),
  browser: defineAsyncComponent(() => import('./DesktopBrowserSettingsView.vue')),
  proxy: defineAsyncComponent(() => import('./DesktopProxySettingsView.vue')),
  logs: defineAsyncComponent(() => import('./DesktopLogsSettingsView.vue')),
  about: defineAsyncComponent(() => import('./DesktopAboutSettingsView.vue')),
}

<script setup lang="ts">
import type { BuddyCapabilities } from '@buddy-shared/platform'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import {
  Alert20Regular,
  AnimalCat20Regular,
  DataUsage20Regular,
  DocumentTextClock20Regular,
  Globe20Regular,
  Info20Regular,
  Keyboard20Regular,
  PaintBrush20Regular,
  PlugConnected20Regular,
  Server20Regular,
  Settings20Regular,
  TextDescription20Regular,
  Window20Regular,
} from '@vicons/fluent'
import { computed } from 'vue'

import { useRoute } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { supportsSettingsCategory } from '@/platform/desktop/desktopCapabilities'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import ModelIcon from '@/shared/ui/icon/ModelIcon.vue'
import RuntimeIcon from '@/shared/ui/icon/RuntimeIcon.vue'
import SkillIcon from '@/shared/ui/icon/SkillIcon.vue'
import DesktopWorkspaceSidebarIdentity from '@/shared/ui/workspace-sidebar/DesktopWorkspaceSidebarIdentity.vue'
import { settingsModuleLocation, settingsNavigationSections } from '../../model/settingsNavigation'
import { settingsText } from '../../model/settingsRegistry'
import { useSettingsContext } from '../../settingsContext'

const props = defineProps<{
  appSidebarCollapsed: boolean
  language: BuddyLocale
  capabilities: BuddyCapabilities | null
}>()
const route = useRoute()
const { registry } = useSettingsContext()
const { t } = useBuddyI18n(() => props.language)
const icons = { general: Settings20Regular, appearance: PaintBrush20Regular, notifications: Alert20Regular, pet: AnimalCat20Regular, shortcuts: Keyboard20Regular, models: ModelIcon, runtime: RuntimeIcon, prompts: TextDescription20Regular, mcp: PlugConnected20Regular, skills: SkillIcon, usage: DataUsage20Regular, web: Globe20Regular, browser: Window20Regular, proxy: Server20Regular, logs: DocumentTextClock20Regular, about: Info20Regular }
const activeModuleId = computed(() => route.meta.settingsModule ?? route.params.moduleId)
const visibleGroups = computed(() => settingsNavigationSections.map(section => ({
  ...section,
  modules: registry.modules.value.filter(module => module.section === section.id && (!module.category || supportsSettingsCategory(props.capabilities, module.category))),
})).filter(section => section.modules.length))
</script>

<template>
  <nav class="desktop-settings-sidebar">
    <header class="desktop-settings-sidebar__header">
      <DesktopWorkspaceSidebarIdentity
        :label="t('desktop.navigation.settings')"
        :visible="appSidebarCollapsed"
      />
    </header>

    <div class="desktop-settings-sidebar__content">
      <section v-for="group in visibleGroups" :key="group.id" class="desktop-settings-sidebar__group">
        <h2 class="desktop-settings-sidebar__group-title">
          {{ settingsText(group.title, language) }}
        </h2>
        <RouterLink
          v-for="module in group.modules"
          :key="module.id"
          class="desktop-settings-sidebar__item"
          :class="{ 'is-active': activeModuleId === module.id }"
          :aria-current="activeModuleId === module.id ? 'page' : undefined"
          :to="settingsModuleLocation(module)"
        >
          <DesktopIcon :component="module.category ? icons[module.category] : PlugConnected20Regular" />
          <span>{{ settingsText(module.title, language) }}</span>
        </RouterLink>
      </section>
    </div>
  </nav>
</template>

<style scoped>
.desktop-settings-sidebar {
  display: flex;
  width: var(--buddy-workspace-sidebar-width);
  height: 100%;
  min-height: 0;
  flex: none;
  flex-direction: column;
  border-right: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-workspace-sidebar);
}

.desktop-settings-sidebar__header {
  display: flex;
  height: var(--buddy-region-header-height);
  flex: none;
  align-items: center;
  gap: 0.35rem;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 0 0.75rem;
}

.desktop-settings-sidebar__content {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 1.15rem;
  overflow-y: auto;
  padding: 0.9rem 0.7rem;
}

.desktop-settings-sidebar__group {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.15rem;
}

.desktop-settings-sidebar__group-title {
  margin: 0 0 0.25rem;
  padding: 0 0.65rem;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-sidebar-section-font-size);
  font-weight: var(--buddy-sidebar-section-font-weight);
  line-height: 1.5;
}

.desktop-settings-sidebar__item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.65rem;
  border: 0;
  border-radius: 0.45rem;
  background: transparent;
  color: var(--buddy-text-primary);
  font-size: var(--buddy-sidebar-item-font-size);
  font-weight: var(--buddy-sidebar-item-font-weight);
  line-height: 20px;
  padding: 0.4rem 0.65rem;
  text-align: left;
  text-decoration: none;
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
}

.desktop-settings-sidebar__item:hover {
  background: var(--buddy-nav-hover);
}

.desktop-settings-sidebar__item:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -2px;
}

.desktop-settings-sidebar__item.is-active {
  background: var(--buddy-nav-selected);
  color: var(--buddy-nav-foreground);
}

.desktop-settings-sidebar__item.is-active:hover {
  background: var(--buddy-nav-pressed);
}
</style>

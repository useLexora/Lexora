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
  <nav class="desktop-settings-sidebar flex w-workspace-sidebar h-full min-h-0 flex-none flex-col border-r-1 border-r-solid border-r-border bg-workspace-sidebar">
    <header class="flex flex-none items-center gap-[0.35rem] border-b-1 border-b-solid border-b-border py-0 px-3 h-region-header">
      <DesktopWorkspaceSidebarIdentity
        :label="t('desktop.navigation.settings')"
        :visible="appSidebarCollapsed"
      />
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-[1.15rem] overflow-y-auto py-[0.9rem] px-[0.7rem]">
      <section v-for="group in visibleGroups" :key="group.id" class="flex flex-none flex-col gap-[0.15rem]">
        <h2 class="mt-0 mr-0 mb-1 ml-0 py-0 px-[0.65rem] text-muted text-sidebar-section [font-weight:var(--buddy-sidebar-section-font-weight)] leading-[1.5]">
          {{ settingsText(group.title, language) }}
        </h2>
        <RouterLink
          v-for="module in group.modules"
          :key="module.id"
          class="desktop-settings-sidebar__item ui-focus-ring transition-state-colors flex w-full items-center gap-[0.65rem] border-0 rounded-[0.45rem] text-sidebar-item [font-weight:var(--buddy-sidebar-item-font-weight)] leading-[20px] px-[0.65rem] py-[0.4rem] text-left decoration-none"
          :class="activeModuleId === module.id ? 'is-active bg-nav-selected text-nav-foreground hover:bg-nav-selected-hover active:bg-nav-pressed' : 'bg-transparent text-fg hover:bg-nav-hover active:bg-nav-pressed'"
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

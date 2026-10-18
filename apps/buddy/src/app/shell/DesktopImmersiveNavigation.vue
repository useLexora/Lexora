<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import type { DesktopShellBindings } from './desktopShellBindings'
import { VehicleShip20Regular } from '@vicons/fluent'
import { NDropdown, NTooltip } from 'naive-ui'
import { computed, h } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopNavigationButton from './DesktopNavigationButton.vue'
import DesktopNavigationControls from './DesktopNavigationControls.vue'
import DesktopNavigationIcon from './DesktopNavigationIcon.vue'

const props = defineProps<{ bindings: DesktopShellBindings, visible: boolean }>()
const emit = defineEmits<{ navigate: [id: string] }>()
const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const navigation = computed(() => props.bindings.pages.navigation.value)
const coreEntries = computed(() => navigation.value.filter(entry => !entry.extensionId && entry.id !== 'lexora.extensions' && entry.id !== 'lexora.settings' && !(entry.id === 'lexora.tasks' && entry.active)))
const settingsEntry = computed(() => navigation.value.find(entry => entry.id === 'lexora.settings'))
const pluginActive = computed(() => navigation.value.some(entry => entry.active && (entry.extensionId || entry.id === 'lexora.extensions')))
const pluginOptions = computed<DropdownOption[]>(() => {
  const entries = navigation.value.filter(entry => entry.extensionId)
  const options: DropdownOption[] = entries.map(entry => ({
    key: entry.id,
    label: entry.title,
    icon: () => h(DesktopNavigationIcon, { icon: entry.icon }),
  }))
  if (!options.length)
    options.push({ key: 'empty', label: t('desktop.navigation.noPluginPages'), disabled: true })
  const manager = navigation.value.find(entry => entry.id === 'lexora.extensions')
  if (manager)
    options.push({ key: 'separator', type: 'divider' }, { key: manager.id, label: t('desktop.navigation.managePlugins'), icon: () => h(DesktopNavigationIcon, { icon: manager.icon }) })
  return options
})
</script>

<template>
  <footer class="desktop-immersive-navigation flex-none border-t-1 border-r-1 border-t-solid border-r-solid border-t-border border-r-border bg-workspace-sidebar text-app-sidebar-fg" data-theme-surface="layout">
    <DesktopNavigationControls v-slot="{ openPanel, setPanel, closePanel }" :bindings="bindings" presentation="immersive" :visible="visible">
      <nav class="flex min-w-0 flex-1 items-center justify-center">
        <DesktopNavigationButton v-for="entry in coreEntries" :key="entry.id" :entry="entry" icon-only dense @navigate="closePanel(); emit('navigate', $event)" />
        <NDropdown
          :show="openPanel === 'plugins'" trigger="click" placement="top-start" :options="pluginOptions" :value="pluginActive ? bindings.pages.current.value : null"
          :scrollable="true" :max-height="360"
          @update:show="setPanel('plugins', $event)"
          @select="id => { closePanel(); emit('navigate', String(id)) }"
        >
          <NTooltip class="pointer-events-none" :disabled="openPanel === 'plugins'" placement="top">
            <template #trigger>
              <button
                class="desktop-immersive-navigation__plugins grid size-7 flex-none place-items-center border-0 rounded-icon p-0 cursor-pointer ui-focus-ring transition-state-colors"
                :class="pluginActive ? 'is-active bg-nav-selected text-nav-foreground hover:bg-nav-selected-hover active:bg-nav-pressed' : 'bg-transparent text-app-sidebar-fg hover:(bg-hover text-strong) active:bg-nav-pressed'"
                type="button"
                :aria-label="t('desktop.navigation.openPlugins')" :aria-expanded="openPanel === 'plugins'" aria-haspopup="menu"
              >
                <DesktopIcon :component="VehicleShip20Regular" />
              </button>
            </template>
            {{ t('desktop.navigation.openPlugins') }}
          </NTooltip>
        </NDropdown>
        <DesktopNavigationButton v-if="settingsEntry" :entry="settingsEntry" icon-only dense @navigate="closePanel(); emit('navigate', $event)" />
      </nav>
    </DesktopNavigationControls>
  </footer>
</template>

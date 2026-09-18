<script setup lang="ts">
import type {
  DesktopCommandId,
  DesktopCommandMenu,
  DesktopPlatform,
} from '@buddy-electron/shared/desktopCommands'
import type { DropdownMenuProps, DropdownNodeProps, DropdownOption } from 'naive-ui'
import type { BuddyI18nKey, BuddyLocale } from '@/i18n/buddyI18n'
import {
  getDesktopMenuCommands,
  isDesktopCommandId,
} from '@buddy-electron/shared/desktopCommands'
import { formatKeybinding } from '@buddy-shared/shortcuts/keybinding'
import {
  PanelLeft20Regular,
} from '@vicons/fluent'
import { NDropdown } from 'naive-ui'
import { computed, h, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BRAND_ASSET_URLS } from '@/shared/branding/brandAssets'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  appSidebarCollapsed: boolean
  language: BuddyLocale
  platform: DesktopPlatform
  shortcutBindings: Readonly<Record<string, readonly string[]>>
}>()
const emit = defineEmits<{
  command: [commandId: DesktopCommandId]
  toggleAppSidebar: []
}>()

const activeMenu = shallowRef<DesktopCommandMenu | null>(null)
const { t } = useBuddyI18n(() => props.language)
const menuTriggers = computed(() => [
  { id: 'application' as const, label: 'Lexora Buddy' },
  { id: 'window' as const, label: t('desktop.menu.window') },
  { id: 'help' as const, label: t('desktop.menu.help') },
])
const menuOptions = computed<Record<DesktopCommandMenu, DropdownOption[]>>(() => ({
  application: createMenuOptions('application'),
  help: createMenuOptions('help'),
  window: createMenuOptions('window'),
}))

const commandLabelKeys = {
  'app.about': 'desktop.command.app.about',
  'app.checkUpdates': 'desktop.command.app.checkUpdates',
  'app.quit': 'desktop.command.app.quit',
  'help.feedback': 'desktop.command.help.feedback',
  'help.openDocumentation': 'desktop.command.help.openDocumentation',
  'help.openLogsDirectory': 'desktop.command.help.openLogsDirectory',
  'window.close': 'desktop.command.window.close',
  'window.toggleDeveloperTools': 'desktop.command.window.toggleDeveloperTools',
} satisfies Record<DesktopCommandId, BuddyI18nKey>

function createMenuOptions(menu: DesktopCommandMenu): DropdownOption[] {
  const options: DropdownOption[] = []
  let currentSection: number | null = null
  for (const command of getDesktopMenuCommands(menu)) {
    if (currentSection !== null && currentSection !== command.section) {
      options.push({
        key: `${menu}-section-${command.section}`,
        type: 'divider',
      })
    }
    currentSection = command.section
    const shortcut = props.shortcutBindings[command.id]?.[0]
    options.push({
      key: command.id,
      label: () => h('span', { class: 'desktop-window-menu-option' }, [
        h('span', t(commandLabelKeys[command.id])),
        shortcut
          ? h('kbd', { class: 'desktop-window-menu-option__shortcut' }, formatKeybinding(shortcut, props.platform))
          : null,
      ]),
    })
  }
  return options
}

function selectCommand(value: string | number) {
  activeMenu.value = null
  if (isDesktopCommandId(value))
    emit('command', value)
}

function setMenuVisibility(menu: DesktopCommandMenu, visible: boolean) {
  activeMenu.value = visible ? menu : null
}

function switchOpenMenu(menu: DesktopCommandMenu) {
  if (activeMenu.value && activeMenu.value !== menu)
    activeMenu.value = menu
}

const menuProps: DropdownMenuProps = () => ({
  class: 'desktop-window-menu-popover',
  role: 'menu',
})
const nodeProps: DropdownNodeProps = () => ({
  role: 'menuitem',
})
</script>

<template>
  <nav
    class="desktop-window-menu"
    @dblclick.stop
    @mousedown.stop
    @pointerdown.stop
  >
    <button
      type="button"
      class="desktop-window-menu__sidebar-trigger"
      :aria-label="t(appSidebarCollapsed ? 'desktop.layout.expandAppSidebar' : 'desktop.layout.collapseAppSidebar')"
      :aria-expanded="!appSidebarCollapsed"
      aria-controls="desktop-app-sidebar"
      @click="emit('toggleAppSidebar')"
    >
      <DesktopIcon :component="PanelLeft20Regular" />
    </button>
    <NDropdown
      v-for="menu in menuTriggers"
      :key="menu.id"
      trigger="click"
      placement="bottom-start"
      size="small"
      :options="menuOptions[menu.id]"
      :show="activeMenu === menu.id"
      :menu-props="menuProps"
      :node-props="nodeProps"
      @select="selectCommand"
      @update:show="setMenuVisibility(menu.id, $event)"
    >
      <button
        type="button"
        class="desktop-window-menu__trigger"
        :class="{ 'is-active': activeMenu === menu.id }"
        :aria-expanded="activeMenu === menu.id"
        aria-haspopup="menu"
        @mouseenter="switchOpenMenu(menu.id)"
      >
        <img v-if="menu.id === 'application'" :src="BRAND_ASSET_URLS.appIcon" alt="" draggable="false">
        <span>{{ menu.label }}</span>
      </button>
    </NDropdown>
  </nav>
</template>

<style scoped>
.desktop-window-menu {
  display: flex;
  height: 100%;
  min-width: 0;
  align-items: center;
  padding-left: 0.25rem;
  -webkit-app-region: no-drag;
}

.desktop-window-menu__sidebar-trigger {
  display: grid;
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: var(--buddy-text-secondary);
  cursor: default;
  margin-right: 0.125rem;
  padding: 0;
  transition: background-color 80ms ease, color 80ms ease;

  &:hover {
    background: var(--buddy-state-hover);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    outline: 1px solid var(--buddy-focus-ring);
    outline-offset: -1px;
  }

  .desktop-icon {
    width: 1rem;
    height: 1rem;
  }
}

.desktop-window-menu__trigger {
  display: flex;
  height: 1.5rem;
  align-items: center;
  gap: 0.4rem;
  border: 0;
  border-radius: 0.25rem;
  background: transparent;
  color: var(--buddy-text-primary);
  cursor: default;
  font: inherit;
  font-size: 0.75rem;
  padding: 0 0.5rem;
  transition: background-color 80ms ease, color 80ms ease;

  &:hover,
  &.is-active {
    background: var(--buddy-state-hover);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    outline: 1px solid var(--buddy-focus-ring);
    outline-offset: -1px;
  }

  &.is-active:focus-visible {
    outline: 0;
  }

  img {
    width: 1rem;
    height: 1rem;
    flex: none;
    border-radius: 0.25rem;
  }

  span {
    white-space: nowrap;
  }
}
</style>

<style>
.desktop-window-menu-popover.n-dropdown-menu {
  --desktop-window-menu-panel-radius: 0.375rem;
  --desktop-window-menu-option-radius: 0.1875rem;
  --n-option-color-active: var(--buddy-accent-solid-pressed) !important;
  --n-option-color-hover: var(--buddy-accent-solid) !important;
  --n-option-text-color-active: var(--buddy-text-on-accent) !important;
  --n-option-text-color-hover: var(--buddy-text-on-accent) !important;

  width: 12.5rem;
  min-width: 12.5rem;
  overflow: hidden;
  border: 1px solid var(--buddy-border-strong);
  border-radius: var(--desktop-window-menu-panel-radius);
  box-shadow: var(--buddy-shadow-overlay);
}

.desktop-window-menu-option {
  display: flex;
  min-width: 0;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 1.25rem;
}

.desktop-window-menu-popover.n-dropdown-menu .n-dropdown-option-body {
  font-size: 0.75rem;
  transition-duration: 80ms;
}

.desktop-window-menu-popover.n-dropdown-menu .n-dropdown-option-body::before {
  border-radius: var(--desktop-window-menu-option-radius);
  transition-duration: 80ms;
}

.desktop-window-menu-option__shortcut {
  color: var(--buddy-text-muted);
  font: inherit;
  font-size: 0.72rem;
}
</style>

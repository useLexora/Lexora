<script setup lang="ts" generic="Tab extends { id: string, title: string }">
import type { Component } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Add20Regular, Dismiss16Regular } from '@vicons/fluent'
import { useResizeObserver } from '@vueuse/core'
import { NPopover } from 'naive-ui'
import { nextTick, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  activeTabId: string | null
  actions: readonly { id: string, label: string, icon: Component }[]
  language: BuddyLocale
  tabs: readonly Tab[]
}>()
const emit = defineEmits<{
  add: [id: string]
  closeTab: [tabId: string]
  selectTab: [tabId: string]
}>()
defineSlots<{ 'default'?: () => unknown, 'header-actions'?: () => unknown, 'toolbar'?: () => unknown, 'icon'?: (props: { tab: Tab }) => unknown }>()
const { t } = useBuddyI18n(() => props.language)
const panelId = `context-${useId()}`
const menuOpen = shallowRef(false)
const tabsScrollRoot = useTemplateRef<HTMLElement>('tabsScrollRoot')
function open(kind: string) {
  menuOpen.value = false
  emit('add', kind)
}
async function navigateTab(event: KeyboardEvent, index: number) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
    return
  const next = event.key === 'ArrowLeft'
    ? (index + props.tabs.length - 1) % props.tabs.length
    : event.key === 'ArrowRight'
      ? (index + 1) % props.tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? props.tabs.length - 1 : null
  const tab = next === null ? null : props.tabs[next]
  if (!tab)
    return
  event.preventDefault()
  emit('selectTab', tab.id)
  await nextTick()
  document.getElementById(`${panelId}-${tab.id}`)?.focus()
}
function handleTabsWheel(event: WheelEvent) {
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY))
    return
  const root = tabsScrollRoot.value
  if (!root || root.scrollWidth <= root.clientWidth)
    return
  event.preventDefault()
  root.scrollBy({ left: event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientWidth : 1) })
}
async function revealActiveTab() {
  await nextTick()
  tabsScrollRoot.value?.querySelector('[aria-selected="true"]')?.closest('.desktop-task-context-panel__tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
watch(() => [props.activeTabId, props.tabs.length], revealActiveTab)
useResizeObserver(tabsScrollRoot, revealActiveTab)
</script>

<template>
  <section class="desktop-task-context-panel flex w-full min-w-0 min-h-0 flex-none flex-col bg-surface" data-testid="task-context-panel">
    <header class="flex min-w-0 flex-none items-stretch border-b-1 border-b-solid border-b-border bg-surface h-region-header" :style="{ '--tab-count': tabs.length }">
      <div v-if="tabs.length" ref="tabsScrollRoot" class="desktop-task-context-panel__tabs-scroll min-w-0 overflow-x-auto" @wheel="handleTabsWheel">
        <div class="desktop-task-context-panel__tabs flex w-full min-w-[calc(var(--tab-count)_*_7.5rem)] h-full items-center gap-1 py-0 px-[0.375rem]" role="tablist" :aria-label="t('desktop.context.tabCount', { count: tabs.length })">
          <div v-for="(tab, index) in tabs" :key="tab.id" class="desktop-task-context-panel__tab relative flex h-8 min-w-30 max-w-56 items-center overflow-hidden border-0 rounded-icon" :class="tab.id === activeTabId ? 'is-active bg-nav-selected text-nav-foreground hover:bg-nav-selected-hover active:bg-nav-pressed' : 'bg-transparent text-muted hover:(bg-hover text-strong) active:bg-pressed'">
            <button :id="`${panelId}-${tab.id}`" class="desktop-task-context-panel__tab-select flex min-w-0 h-full flex-1 items-center gap-[0.375rem] border-0 bg-transparent text-inherit cursor-pointer pt-0 pr-[0.2rem] pb-0 pl-[0.625rem] text-left ui-focus-ring" role="tab" type="button" :tabindex="tab.id === activeTabId ? 0 : -1" :aria-controls="panelId" :aria-selected="tab.id === activeTabId" @keydown="navigateTab($event, index)" @auxclick.middle.prevent="emit('closeTab', tab.id)" @click="emit('selectTab', tab.id)">
              <slot name="icon" :tab="tab" />
              <span>{{ tab.title }}</span>
            </button>
            <button class="desktop-task-context-panel__tab-close grid flex-none place-items-center border-0 rounded-icon bg-transparent cursor-pointer w-6 h-6 mr-1 ui-focus-ring" :class="tab.id === activeTabId ? 'text-inherit hover:bg-nav-selected-hover' : 'text-muted hover:(bg-hover text-strong)'" type="button" :aria-label="t('desktop.context.closeTab', { name: tab.title })" @click="emit('closeTab', tab.id)">
              <DesktopIcon :component="Dismiss16Regular" />
            </button>
          </div>
        </div>
      </div>
      <NPopover v-if="tabs.length" v-model:show="menuOpen" trigger="click" placement="bottom-start" :show-arrow="false" :theme-overrides="{ padding: '4px' }">
        <template #trigger>
          <button class="desktop-task-context-panel__add grid w-8 h-8 flex-none self-center place-items-center border-0 rounded-icon bg-transparent text-muted cursor-pointer" :class="{ 'is-open': menuOpen }" type="button" data-testid="context-add-tab" :aria-label="t('desktop.context.addTab')" :aria-expanded="menuOpen" aria-haspopup="menu">
            <DesktopIcon :component="Add20Regular" />
          </button>
        </template>
        <div class="desktop-task-context-panel__menu grid min-w-40" role="menu">
          <button v-for="entry in actions" :key="entry.id" type="button" role="menuitem" @click="open(entry.id)">
            <DesktopIcon :component="entry.icon" /><span>{{ entry.label }}</span>
          </button>
        </div>
      </NPopover>
      <div v-if="$slots['header-actions']" class="flex flex-none items-center mt-0 mr-[0.375rem] mb-0 ml-auto">
        <slot name="header-actions" />
      </div>
    </header>
    <div v-if="$slots.toolbar" class="flex min-w-0 flex-none min-h-[var(--buddy-context-toolbar-height)] items-center border-b-1 border-b-solid border-b-border">
      <slot name="toolbar" />
    </div>
    <div v-show="activeTabId" :id="panelId" class="flex flex-1 min-w-0 min-h-0 overflow-hidden" role="tabpanel" :aria-labelledby="activeTabId ? `${panelId}-${activeTabId}` : undefined">
      <slot />
    </div>
    <div v-if="!activeTabId" class="grid min-w-0 min-h-0 flex-1 place-items-center">
      <div class="desktop-task-context-panel__launchers grid w-[min(70%,_26rem)] gap-[0.375rem]">
        <button v-for="entry in actions" :key="entry.id" type="button" :data-testid="`task-context-open-${entry.id}`" @click="open(entry.id)">
          <DesktopIcon :component="entry.icon" /><span>{{ entry.label }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-task-context-panel__tabs-scroll {
  flex: 0 1 calc(var(--tab-count) * 11rem);
  scrollbar-width: none;
}

:deep(.desktop-task-context-panel__tabs-scrollbar) {
  width: 100%;
  height: 100%;
}

.desktop-task-context-panel__tab {
  flex: 0 1 11rem;
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
}

.desktop-task-context-panel__tab-select span {
  overflow: hidden;
  font-size: 0.76rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-task-context-panel__tab.is-active .desktop-task-context-panel__tab-select span {
  font-weight: 600;
}

.desktop-task-context-panel__tab-close :deep(.n-icon) {
  width: 0.875rem;
  height: 0.875rem;
  font-size: 0.875rem;
}
.desktop-task-context-panel__add:hover, .desktop-task-context-panel__add.is-open { background: var(--buddy-state-hover); color: var(--buddy-text-strong); }
.desktop-task-context-panel__add :deep(.n-icon) { transition: transform 150ms var(--buddy-motion-state-easing); }
.desktop-task-context-panel__add.is-open :deep(.n-icon) { transform: rotate(45deg); }
.desktop-task-context-panel__launchers button, .desktop-task-context-panel__menu button { display: flex; align-items: center; gap: 0.75rem; border: 0; border-radius: var(--buddy-icon-button-radius); background: transparent; color: var(--buddy-text-primary); cursor: pointer; padding: 0.75rem; font: inherit; text-align: left; }
.desktop-task-context-panel__launchers button:hover, .desktop-task-context-panel__menu button:hover { background: var(--buddy-state-hover); }
.desktop-task-context-panel__launchers :deep(.n-icon) { color: var(--buddy-text-secondary); }
.desktop-task-context-panel__menu button { min-height: 1.875rem; gap: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.75rem; line-height: 1.125rem; }
.desktop-task-context-panel__add:focus-visible, .desktop-task-context-panel__launchers button:focus-visible, .desktop-task-context-panel__menu button:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) { .desktop-task-context-panel__add :deep(.n-icon) { transition: none; } }
</style>

<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ContextPanelTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { Add20Regular, Code16Regular, Dismiss16Regular, Folder20Regular, Globe16Regular } from '@vicons/fluent'
import { NPopover } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  activeTabId: string | null
  canAddChanges: boolean
  canAddFiles: boolean
  language: BuddyLocale
  tabs: readonly ContextPanelTab[]
}>()
const emit = defineEmits<{
  add: [kind: 'changes' | 'files' | 'browser']
  closeTab: [tabId: string]
  selectTab: [tabId: string]
}>()
defineSlots<{ default?: () => unknown, toolbar?: () => unknown }>()
const { t } = useBuddyI18n(() => props.language)
const menuOpen = shallowRef(false)
const tabsScrollRoot = useTemplateRef<HTMLElement>('tabsScrollRoot')
const entries = computed(() => [
  ...(props.canAddChanges ? [{ kind: 'changes' as const, label: t('desktop.context.changes'), icon: Code16Regular }] : []),
  ...(props.canAddFiles ? [{ kind: 'files' as const, label: t('desktop.context.files'), icon: Folder20Regular }] : []),
  { kind: 'browser' as const, label: t('desktop.context.browser'), icon: Globe16Regular },
])
function open(kind: 'changes' | 'files' | 'browser') {
  menuOpen.value = false
  emit('add', kind)
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
watch(() => [props.activeTabId, props.tabs.length], async () => {
  await nextTick()
  tabsScrollRoot.value?.querySelector('[aria-selected="true"]')?.closest('.desktop-task-context-panel__tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})
</script>

<template>
  <section class="desktop-task-context-panel" data-testid="task-context-panel">
    <header class="desktop-task-context-panel__header" :style="{ '--tab-count': tabs.length }">
      <div v-if="tabs.length" ref="tabsScrollRoot" class="desktop-task-context-panel__tabs-scroll" @wheel="handleTabsWheel">
        <div class="desktop-task-context-panel__tabs" role="tablist" :aria-label="t('desktop.context.tabCount', { count: tabs.length })">
          <div v-for="tab in tabs" :key="tab.id" class="desktop-task-context-panel__tab" :class="{ 'is-active': tab.id === activeTabId }">
            <button class="desktop-task-context-panel__tab-select" role="tab" type="button" :aria-selected="tab.id === activeTabId" @click="emit('selectTab', tab.id)">
              <FileIcon v-if="tab.icon === 'file'" :name="tab.fileName ?? tab.title" />
              <FolderIcon v-else-if="tab.icon === 'folder'" class="desktop-task-context-panel__folder-icon" />
              <DesktopIcon v-else :component="tab.icon === 'browser' ? Globe16Regular : Code16Regular" />
              <span>{{ tab.title }}</span>
            </button>
            <button class="desktop-task-context-panel__tab-close" type="button" :aria-label="t('desktop.context.closeTab', { name: tab.title })" @click="emit('closeTab', tab.id)">
              <DesktopIcon :component="Dismiss16Regular" />
            </button>
          </div>
        </div>
      </div>
      <NPopover v-if="tabs.length" v-model:show="menuOpen" trigger="click" placement="bottom-start" :show-arrow="false" :theme-overrides="{ padding: '4px' }">
        <template #trigger>
          <button class="desktop-task-context-panel__add" :class="{ 'is-open': menuOpen }" type="button" data-testid="context-add-tab" :aria-label="t('desktop.context.addTab')" :aria-expanded="menuOpen" aria-haspopup="menu">
            <DesktopIcon :component="Add20Regular" />
          </button>
        </template>
        <div class="desktop-task-context-panel__menu" role="menu">
          <button v-for="entry in entries" :key="entry.kind" type="button" role="menuitem" @click="open(entry.kind)">
            <DesktopIcon :component="entry.icon" /><span>{{ entry.label }}</span>
          </button>
        </div>
      </NPopover>
    </header>
    <div v-if="$slots.toolbar" class="desktop-task-context-panel__toolbar">
      <slot name="toolbar" />
    </div>
    <div v-if="activeTabId" class="desktop-task-context-panel__body">
      <slot />
    </div>
    <div v-else class="desktop-task-context-panel__empty">
      <div class="desktop-task-context-panel__launchers">
        <button v-for="entry in entries" :key="entry.kind" type="button" :data-testid="`task-context-open-${entry.kind}`" @click="open(entry.kind)">
          <DesktopIcon :component="entry.icon" /><span>{{ entry.label }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.desktop-task-context-panel {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: none;
  flex-direction: column;
  background: var(--buddy-surface-base);
}

.desktop-task-context-panel__header {
  display: flex;
  height: var(--buddy-region-header-height);
  min-width: 0;
  flex: none;
  align-items: stretch;
  border-bottom: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-base);
}

.desktop-task-context-panel__tabs-scroll {
  min-width: 0;
  flex: 0 1 calc(var(--tab-count) * 11rem);
  overflow-x: auto;
  scrollbar-width: none;
}

:deep(.desktop-task-context-panel__tabs-scrollbar) {
  width: 100%;
  height: 100%;
}

.desktop-task-context-panel__tabs {
  display: flex;
  width: 100%;
  min-width: calc(var(--tab-count) * 7.5rem);
  height: 100%;
  align-items: stretch;
  gap: 0.25rem;
  padding: 0.5625rem 0.25rem;
}

.desktop-task-context-panel__tab {
  position: relative;
  display: flex;
  height: 2.5rem;
  min-width: 7.5rem;
  max-width: 14rem;
  flex: 0 1 11rem;
  align-items: center;
  overflow: hidden;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--buddy-text-secondary);
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
}

.desktop-task-context-panel__tab:hover {
  background: var(--buddy-nav-hover);
  color: var(--buddy-text-strong);
}

.desktop-task-context-panel__tab.is-active {
  background: var(--buddy-nav-hover);
  color: var(--buddy-nav-foreground);
}

.desktop-task-context-panel__tab:active,
.desktop-task-context-panel__tab.is-active:hover {
  background: var(--buddy-nav-selected);
}

.desktop-task-context-panel__tab.is-active:active {
  background: var(--buddy-nav-pressed);
}

.desktop-task-context-panel__tab-select {
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1;
  align-items: center;
  gap: 0.375rem;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0 0.2rem 0 0.625rem;
  text-align: left;
}

.desktop-task-context-panel__folder-icon {
  width: 1rem;
  height: 1rem;
  flex: none;
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

.desktop-task-context-panel__tab-select:focus-visible,
.desktop-task-context-panel__tab-close:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -2px;
}

.desktop-task-context-panel__tab-close {
  display: grid;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: var(--buddy-icon-button-radius);
  background: transparent;
  color: var(--buddy-text-secondary);
  cursor: pointer;
}

.desktop-task-context-panel__tab-close {
  width: 1.5rem;
  height: 1.5rem;
  margin-right: 0.25rem;
}

.desktop-task-context-panel__tab-close :deep(.n-icon) {
  width: 0.875rem;
  height: 0.875rem;
  font-size: 0.875rem;
}

.desktop-task-context-panel__tab-close:hover {
  background: var(--buddy-state-hover);
  color: var(--buddy-text-strong);
}

.desktop-task-context-panel__empty {
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1;
  place-items: center;
}

.desktop-task-context-panel__toolbar { display: flex; min-width: 0; flex: none; min-height: var(--buddy-context-toolbar-height); align-items: center; border-bottom: 1px solid var(--buddy-border-subtle); }
.desktop-task-context-panel__body { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.desktop-task-context-panel__add { display: grid; width: 2rem; height: 2rem; flex: none; align-self: center; place-items: center; border: 0; border-radius: var(--buddy-icon-button-radius); background: transparent; color: var(--buddy-text-secondary); cursor: pointer; }
.desktop-task-context-panel__add:hover, .desktop-task-context-panel__add.is-open { background: var(--buddy-state-hover); color: var(--buddy-text-strong); }
.desktop-task-context-panel__add :deep(.n-icon) { transition: transform 150ms var(--buddy-motion-state-easing); }
.desktop-task-context-panel__add.is-open :deep(.n-icon) { transform: rotate(45deg); }
.desktop-task-context-panel__launchers { display: grid; width: min(70%, 26rem); gap: 0.375rem; }
.desktop-task-context-panel__launchers button, .desktop-task-context-panel__menu button { display: flex; align-items: center; gap: 0.75rem; border: 0; border-radius: var(--buddy-icon-button-radius); background: transparent; color: var(--buddy-text-primary); cursor: pointer; padding: 0.75rem; font: inherit; text-align: left; }
.desktop-task-context-panel__launchers button:hover, .desktop-task-context-panel__menu button:hover { background: var(--buddy-state-hover); }
.desktop-task-context-panel__launchers :deep(.n-icon) { color: var(--buddy-text-secondary); }
.desktop-task-context-panel__menu { display: grid; min-width: 10rem; }
.desktop-task-context-panel__menu button { min-height: 1.875rem; gap: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.75rem; line-height: 1.125rem; }
.desktop-task-context-panel__add:focus-visible, .desktop-task-context-panel__launchers button:focus-visible, .desktop-task-context-panel__menu button:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) { .desktop-task-context-panel__add :deep(.n-icon) { transition: none; } }
</style>

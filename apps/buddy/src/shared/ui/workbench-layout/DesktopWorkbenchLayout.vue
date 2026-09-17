<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, nextTick, onBeforeUnmount, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useDesktopWorkbenchResize } from './useDesktopWorkbenchResize'

const props = withDefaults(defineProps<{
  language: BuddyLocale
  contextVisible?: boolean
  sidebarCollapsible?: boolean
  sidebarResizable?: boolean
  workspaceMinimumWidth?: number
}>(), {
  contextVisible: true,
  sidebarCollapsible: false,
  sidebarResizable: false,
  workspaceMinimumWidth: 288,
})
const slots = defineSlots<{
  context?: () => unknown
  default: () => unknown
  sidebar?: () => unknown
}>()
const sidebarCollapsed = defineModel<boolean>('sidebarCollapsed', { default: false })
const sidebarWidthPreference = defineModel<number | null>('sidebarWidth', { default: null })
const { t } = useBuddyI18n(() => props.language)
const container = useTemplateRef<HTMLElement>('container')
const context = useTemplateRef<HTMLElement>('context')
const sidebar = useTemplateRef<HTMLElement>('sidebar')
const sidebarVisible = computed(() => Boolean(slots.sidebar) && (!props.sidebarCollapsible || !sidebarCollapsed.value))
const sidebarTransitioning = shallowRef(false)
const sidebarToggleTop = shallowRef<string | null>(null)
const sidebarToggleStyle = computed(() => sidebarToggleTop.value
  ? { top: sidebarToggleTop.value }
  : undefined)
const {
  activePanel,
  beginResize,
  contextRange,
  contextStyle,
  contextWidth,
  handleResizeKeydown,
  layoutStyle,
  sidebarRange,
  sidebarWidth,
} = useDesktopWorkbenchResize({
  container,
  context,
  contextVisible: () => props.contextVisible,
  workspaceMinimumWidth: () => props.workspaceMinimumWidth,
  onSidebarWidthCommit: (width) => {
    sidebarWidthPreference.value = width
  },
  sidebar,
  sidebarPreferredWidth: () => sidebarWidthPreference.value,
  sidebarResizable: () => props.sidebarResizable,
  sidebarVisible: () => sidebarVisible.value,
})

let sidebarTransitionTimer: number | null = null

async function toggleSidebar(): Promise<void> {
  if (sidebarTransitioning.value)
    return

  sidebarTransitioning.value = true
  await nextTick()
  requestAnimationFrame(() => {
    sidebarCollapsed.value = !sidebarCollapsed.value
    sidebarTransitionTimer = window.setTimeout(finishSidebarTransition, 280)
  })
}

function finishSidebarTransition(event?: TransitionEvent): void {
  if (event && (event.target !== sidebar.value || event.propertyName !== 'width'))
    return
  if (sidebarTransitionTimer !== null)
    window.clearTimeout(sidebarTransitionTimer)
  sidebarTransitionTimer = null
  sidebarTransitioning.value = false
}

function updateSidebarTogglePosition(event: PointerEvent): void {
  const bounds = container.value?.getBoundingClientRect()
  if (!bounds)
    return
  const halfToggleHeight = 16
  const maximum = Math.max(halfToggleHeight, bounds.height - halfToggleHeight)
  const offset = Math.min(maximum, Math.max(halfToggleHeight, event.clientY - bounds.top))
  sidebarToggleTop.value = `${offset}px`
}

onBeforeUnmount(() => {
  if (sidebarTransitionTimer !== null)
    window.clearTimeout(sidebarTransitionTimer)
})
</script>

<template>
  <section
    ref="container"
    class="desktop-workbench-layout"
    :class="{
      'is-resizing': activePanel !== null,
      'is-sidebar-transitioning': sidebarTransitioning,
    }"
    :style="layoutStyle"
  >
    <div
      v-if="$slots.sidebar"
      ref="sidebar"
      class="desktop-workbench-layout__sidebar"
      :class="{ 'is-collapsed': !sidebarVisible }"
      :aria-hidden="!sidebarVisible"
      :inert="!sidebarVisible"
      @transitionend="finishSidebarTransition"
    >
      <slot name="sidebar" />
    </div>
    <div
      v-if="sidebarResizable && sidebarVisible"
      class="desktop-workbench-layout__resizer desktop-workbench-layout__sidebar-resizer"
      :class="{ 'is-active': activePanel === 'sidebar' }"
      data-testid="workbench-sidebar-resizer"
      role="separator"
      :aria-label="t('desktop.layout.resizeTaskSidebar')"
      aria-orientation="vertical"
      :aria-valuemax="Math.round(sidebarRange.maximum)"
      :aria-valuemin="Math.round(sidebarRange.minimum)"
      :aria-valuenow="Math.round(sidebarWidth)"
      tabindex="0"
      @keydown="handleResizeKeydown('sidebar', $event)"
      @pointerenter="updateSidebarTogglePosition"
      @pointerdown="beginResize('sidebar', $event)"
      @pointermove="updateSidebarTogglePosition"
    />
    <div
      v-else-if="sidebarResizable && sidebarCollapsible"
      class="desktop-workbench-layout__sidebar-collapsed-boundary"
      @pointerenter="updateSidebarTogglePosition"
      @pointermove="updateSidebarTogglePosition"
    />
    <button
      v-if="sidebarResizable && sidebarCollapsible"
      class="desktop-workbench-layout__sidebar-toggle"
      :class="{ 'is-collapsed': !sidebarVisible }"
      :style="sidebarToggleStyle"
      data-testid="workbench-sidebar-toggle"
      type="button"
      :aria-label="t(sidebarVisible ? 'desktop.layout.collapseTaskSidebar' : 'desktop.layout.expandTaskSidebar')"
      :aria-expanded="sidebarVisible"
      @click="toggleSidebar"
      @pointermove="updateSidebarTogglePosition"
    >
      <DesktopIcon class="desktop-workbench-layout__sidebar-chevron" name="sidebarChevron" />
    </button>
    <main class="desktop-workbench-layout__workspace">
      <slot />
    </main>
    <div
      v-if="$slots.context && contextVisible"
      class="desktop-workbench-layout__resizer"
      :class="{ 'is-active': activePanel === 'context' }"
      data-testid="workbench-context-resizer"
      role="separator"
      :aria-label="t('desktop.layout.resizeContext')"
      aria-orientation="vertical"
      :aria-valuemax="Math.round(contextRange.maximum)"
      :aria-valuemin="Math.round(contextRange.minimum)"
      :aria-valuenow="Math.round(contextWidth)"
      tabindex="0"
      @keydown="handleResizeKeydown('context', $event)"
      @pointerdown="beginResize('context', $event)"
    />
    <aside v-if="$slots.context" v-show="contextVisible" ref="context" class="desktop-workbench-layout__context" :style="contextStyle" :inert="!contextVisible" :aria-hidden="!contextVisible">
      <slot name="context" />
    </aside>
    <div v-if="activePanel" class="desktop-workbench-layout__resize-shield" />
  </section>
</template>

<style scoped>
.desktop-workbench-layout {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  background: var(--buddy-surface-base);
}

.desktop-workbench-layout__sidebar {
  display: flex;
  width: var(--buddy-workspace-sidebar-width);
  min-width: 0;
  min-height: 0;
  flex: none;
  overflow: hidden;
  opacity: 1;
  transition:
    width 240ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 100ms ease,
    visibility 0s linear;
  will-change: width, opacity;
}

.desktop-workbench-layout__sidebar.is-collapsed {
  width: 0;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition-delay: 0ms, 0ms, 240ms;
}

.desktop-workbench-layout__workspace {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.desktop-workbench-layout__context {
  display: flex;
  width: var(--buddy-context-panel-width);
  min-width: 0;
  min-height: 0;
  flex: none;
  border-left: 1px solid var(--buddy-border-subtle);
}

.desktop-workbench-layout__resizer {
  position: relative;
  z-index: 11;
  width: 1px;
  height: 100%;
  flex: 0 0 1px;
  cursor: col-resize;
  margin-right: -1px;
  outline: 0;
  touch-action: none;
}

.desktop-workbench-layout__resizer::before,
.desktop-workbench-layout__sidebar-collapsed-boundary::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  width: 9px;
  content: '';
}

.desktop-workbench-layout__sidebar-resizer::before {
  width: 1.25rem;
}

.desktop-workbench-layout__sidebar-collapsed-boundary {
  position: relative;
  z-index: 12;
  width: 1px;
  height: 100%;
  flex: 0 0 1px;
  margin-right: -1px;
}

.desktop-workbench-layout__sidebar-collapsed-boundary::before {
  left: 0;
  width: 2rem;
}

.desktop-workbench-layout__sidebar-toggle {
  position: absolute;
  z-index: 12;
  top: 50%;
  left: calc(var(--buddy-workspace-sidebar-width) + 0.25rem);
  display: grid;
  width: 1.5rem;
  height: 2rem;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--buddy-accent-solid);
  cursor: pointer;
  opacity: 0;
  outline: 0;
  padding: 0;
  pointer-events: none;
  transform: translate(-0.125rem, -50%);
  transition:
    opacity 220ms ease-out 80ms,
    transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1) 80ms,
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
}

.desktop-workbench-layout__sidebar-toggle::before {
  position: absolute;
  top: 0;
  right: -0.75rem;
  bottom: 0;
  left: 0;
  content: '';
}

.desktop-workbench-layout__sidebar-toggle.is-collapsed {
  left: 0.25rem;
}

.desktop-workbench-layout__sidebar-resizer:hover + .desktop-workbench-layout__sidebar-toggle,
.desktop-workbench-layout__sidebar-collapsed-boundary:hover + .desktop-workbench-layout__sidebar-toggle,
.desktop-workbench-layout__sidebar-toggle:hover,
.desktop-workbench-layout__sidebar-toggle:focus-visible {
  opacity: 1;
  pointer-events: auto;
  transform: translate(0, -50%);
  transition-delay: 0ms;
}

.desktop-workbench-layout__sidebar-toggle:hover,
.desktop-workbench-layout__sidebar-toggle:focus-visible {
  color: var(--buddy-accent-solid-hover);
}

.desktop-workbench-layout__sidebar-toggle:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 1px;
}

.desktop-workbench-layout.is-sidebar-transitioning .desktop-workbench-layout__sidebar-toggle {
  opacity: 1;
  pointer-events: auto;
  transform: translate(0, -50%);
  transition:
    left 240ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 220ms ease-out,
    transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
}

.desktop-workbench-layout__sidebar-chevron {
  position: relative;
  left: -0.4rem;
  width: 1.25rem;
  height: 1.25rem;
  pointer-events: none;
  transform-origin: center;
  transition: transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.desktop-workbench-layout__sidebar-toggle.is-collapsed .desktop-workbench-layout__sidebar-chevron {
  transform: rotate(180deg);
}

.desktop-workbench-layout.is-resizing .desktop-workbench-layout__sidebar {
  transition: none;
}

.desktop-workbench-layout__resizer::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  background: transparent;
  content: '';
  transform: translateX(-0.5px);
  transition: background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
}

.desktop-workbench-layout__resizer:hover::after,
.desktop-workbench-layout__resizer:focus-visible::after,
.desktop-workbench-layout__resizer.is-active::after {
  background: var(--buddy-accent-solid);
}

.desktop-workbench-layout__resize-shield {
  position: absolute;
  z-index: 10;
  inset: 0;
  cursor: col-resize;
}

.desktop-workbench-layout.is-resizing,
.desktop-workbench-layout.is-resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .desktop-workbench-layout__sidebar,
  .desktop-workbench-layout__sidebar-toggle,
  .desktop-workbench-layout__sidebar-chevron {
    transition: none;
  }
}
</style>

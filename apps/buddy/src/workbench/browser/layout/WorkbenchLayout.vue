<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useWorkbenchAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { DESKTOP_WORKBENCH_WIDTH_LIMITS } from '../../common/workbenchPanelLayout'
import { useWorkbenchPanelResize } from './useWorkbenchPanelResize'
import { useWorkbenchSidebarToggle } from './useWorkbenchSidebarToggle'

const props = withDefaults(defineProps<{
  language: BuddyLocale
  contextVisible?: boolean
  contextOnLeft?: boolean
  contextMaximized?: boolean
  sidebarCollapsible?: boolean
  sidebarResizable?: boolean
  workspaceMinimumWidth?: number
}>(), {
  contextVisible: true,
  contextOnLeft: false,
  contextMaximized: false,
  sidebarCollapsible: false,
  sidebarResizable: false,
  workspaceMinimumWidth: 288,
})
const slots = defineSlots<{
  context?: () => unknown
  workspace: () => unknown
  sidebar?: () => unknown
}>()
const sidebarCollapsed = defineModel<boolean>('sidebarCollapsed', { default: false })
const sidebarWidthPreference = defineModel<number | null>('sidebarWidth', { default: null })
const { t } = useBuddyI18n(() => props.language)
const container = useTemplateRef<HTMLElement>('container')
const context = shallowRef<HTMLElement | null>(null)
function setContextElement(element: Element | ComponentPublicInstance | null) {
  context.value = element instanceof HTMLElement ? element : null
}
const sidebar = useTemplateRef<HTMLElement>('sidebar')
const maximized = computed(() => props.contextVisible && props.contextMaximized)
const regions = computed(() => props.contextOnLeft ? ['context', 'workspace'] as const : ['workspace', 'context'] as const)
useWorkbenchAnchor('workbench.sidebar', () => sidebar.value)
function sidebarVisible() {
  const collapsible = props.sidebarCollapsible
  const collapsed = sidebarCollapsed.value
  return Boolean(slots.sidebar) && (!collapsible || !collapsed)
}
const { sidebarTransitioning, sidebarToggleStyle, toggleSidebar, finishSidebarTransition, updateSidebarTogglePosition } = useWorkbenchSidebarToggle({ container, sidebar, collapsed: sidebarCollapsed })
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
} = useWorkbenchPanelResize({
  container,
  context,
  contextOnLeft: () => props.contextOnLeft,
  contextVisible: () => props.contextVisible && !maximized.value,
  workspaceMinimumWidth: () => maximized.value ? DESKTOP_WORKBENCH_WIDTH_LIMITS.context.minimum : props.workspaceMinimumWidth,
  onSidebarWidthCommit: (width) => {
    sidebarWidthPreference.value = width
  },
  sidebar,
  sidebarPreferredWidth: () => sidebarWidthPreference.value,
  sidebarResizable: () => props.sidebarResizable,
  sidebarVisible,
})
</script>

<template>
  <section
    ref="container"
    class="desktop-workbench-layout relative flex w-full h-full min-w-0 min-h-0 flex-1 bg-surface"
    :class="{
      'is-resizing': activePanel !== null,
      'is-sidebar-transitioning': sidebarTransitioning,
      'is-context-on-left': contextOnLeft,
      'is-context-maximized': maximized,
    }"
    :style="layoutStyle"
  >
    <div
      v-if="$slots.sidebar"
      ref="sidebar"
      class="desktop-workbench-layout__sidebar flex min-w-0 min-h-0 flex-none overflow-hidden"
      :class="sidebarVisible() ? 'w-workspace-sidebar opacity-100' : 'is-collapsed w-0 opacity-0 pointer-events-none invisible'"
      :aria-hidden="!sidebarVisible()"
      :inert="!sidebarVisible()"
      @transitionend="finishSidebarTransition"
    >
      <slot name="sidebar" />
    </div>
    <div
      v-if="sidebarResizable && sidebarVisible()"
      class="desktop-workbench-layout__resizer desktop-workbench-layout__sidebar-resizer relative z-11 w-[1px] h-full cursor-col-resize mr-[-1px] flex-[0_0_1px] outline-0 touch-none after:bg-transparent hover:after:bg-accent focus-visible:after:bg-accent"
      :class="{ 'is-active after:bg-accent': activePanel === 'sidebar' }"
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
      class="desktop-workbench-layout__sidebar-collapsed-boundary relative z-12 w-[1px] h-full mr-[-1px]"
      @pointerenter="updateSidebarTogglePosition"
      @pointermove="updateSidebarTogglePosition"
    />
    <button
      v-if="sidebarResizable && sidebarCollapsible"
      class="desktop-workbench-layout__sidebar-toggle absolute z-12 top-[50%] left-[calc(var(--buddy-workspace-sidebar-width)_+_0.25rem)] grid w-6 h-8 place-items-center border-0 bg-transparent text-accent cursor-pointer opacity-0 outline-0 p-0 pointer-events-none hover:text-accent-hover focus-visible:(text-accent-hover outline-solid outline-2 outline-focus outline-offset-1)"
      :class="{ 'is-collapsed': !sidebarVisible() }"
      :style="sidebarToggleStyle"
      data-testid="workbench-sidebar-toggle"
      type="button"
      :aria-label="t(sidebarVisible() ? 'desktop.layout.collapseTaskSidebar' : 'desktop.layout.expandTaskSidebar')"
      :aria-expanded="sidebarVisible()"
      @click="toggleSidebar"
      @pointermove="updateSidebarTogglePosition"
    >
      <DesktopIcon class="desktop-workbench-layout__sidebar-chevron" name="sidebarChevron" />
    </button>
    <template v-for="(region, index) in regions" :key="region">
      <main
        v-if="region === 'workspace'" v-show="!maximized" class="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden"
        :inert="maximized" :aria-hidden="maximized"
      >
        <slot name="workspace" />
      </main>
      <aside
        v-else-if="$slots.context" v-show="contextVisible" :ref="setContextElement" class="desktop-workbench-layout__context flex w-[var(--buddy-context-panel-width)] min-w-0 min-h-0"
        :class="maximized ? 'flex-1 border-0' : ['flex-none', contextOnLeft ? 'border-r border-r-solid border-r-border border-l-0' : 'border-l border-l-solid border-l-border']"
        :style="contextStyle" :inert="!contextVisible" :aria-hidden="!contextVisible"
      >
        <slot name="context" />
      </aside>
      <div
        v-if="index === 0 && $slots.context && contextVisible && !maximized"
        class="desktop-workbench-layout__resizer relative z-11 w-[1px] h-full cursor-col-resize mr-[-1px] flex-[0_0_1px] outline-0 touch-none after:bg-transparent hover:after:bg-accent focus-visible:after:bg-accent"
        :class="{ 'is-active after:bg-accent': activePanel === 'context' }"
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
    </template>
    <div v-if="activePanel" class="absolute z-10 inset-0 cursor-col-resize" />
  </section>
</template>

<style scoped lang="scss">
.desktop-workbench-layout__sidebar {
  transition:
    width 240ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 100ms ease,
    visibility 0s linear;
  will-change: width, opacity;

  &.is-collapsed {
    transition-delay: 0ms, 0ms, 240ms;
  }
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
  flex: 0 0 1px;
}

.desktop-workbench-layout__sidebar-collapsed-boundary::before {
  left: 0;
  width: 0.5rem;
}

.desktop-workbench-layout__sidebar-toggle {
  transform: translate(-0.125rem, -50%);
  transition:
    opacity 220ms ease-out 80ms,
    transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1) 80ms,
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &::before {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    content: '';
  }

  &.is-collapsed {
    left: 0.25rem;
  }
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

.desktop-workbench-layout__resizer {
  &::after {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 2px;
    content: '';
    transform: translateX(-0.5px);
    transition: background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
  }
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

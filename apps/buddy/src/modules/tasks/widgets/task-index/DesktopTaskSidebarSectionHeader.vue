<script setup lang="ts">
import { Add16Regular, ChevronDown20Regular, ChevronRight20Regular } from '@vicons/fluent'

import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

defineProps<{
  expanded: boolean
  label: string
  showAdd?: boolean
}>()
const emit = defineEmits<{
  add: []
  toggle: []
}>()
</script>

<template>
  <div class="desktop-task-sidebar__section-heading flex h-[var(--buddy-task-sidebar-section-header-size,_2rem)] min-w-0 flex-none items-center rounded-[4px] text-muted my-0 mx-[var(--buddy-task-sidebar-scrollbar-gutter,_0.5rem)] hover:bg-nav-hover hover:text-nav-foreground focus-within:text-nav-foreground">
    <button
      class="desktop-task-sidebar__section-toggle flex min-w-0 flex-1 items-center gap-1 py-0 px-[0.375rem] text-left focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-focus focus-visible:outline-offset-[-1px]"
      type="button"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <DesktopIcon :component="expanded ? ChevronDown20Regular : ChevronRight20Regular" />
      <span class="overflow-hidden text-[length:var(--buddy-task-sidebar-section-font-size,_var(--buddy-sidebar-section-font-size))] [font-weight:var(--buddy-sidebar-section-font-weight)] leading-[20px] text-ellipsis whitespace-nowrap">{{ label }}</span>
    </button>
    <div class="desktop-task-sidebar__section-actions flex flex-none items-center gap-[var(--buddy-task-sidebar-action-gap,_0.125rem)] opacity-0 pr-[0.125rem] pointer-events-none">
      <button
        v-if="showAdd"
        class="desktop-task-sidebar__section-add grid w-[var(--buddy-task-sidebar-action-size,_1.75rem)] h-[var(--buddy-task-sidebar-action-size,_1.75rem)] place-items-center p-0 rounded-icon text-muted leading-[1] hover:bg-nav-hover hover:text-strong ui-focus-ring"
        type="button"
        @click="emit('add')"
      >
        <DesktopIcon :component="Add16Regular" />
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-task-sidebar__section-heading {
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing)
}

button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.desktop-task-sidebar__section-toggle {
  .n-icon {
    flex: none;
    font-size: 14px;
  }
}

.desktop-task-sidebar__section-heading:hover .desktop-task-sidebar__section-actions,
.desktop-task-sidebar__section-heading:has(:focus-visible) .desktop-task-sidebar__section-actions {
  opacity: 1;
  pointer-events: auto;
}

.desktop-task-sidebar__section-add {
  .n-icon {
    display: flex;
    font-size: 16px;
  }
}
</style>

<script setup lang="ts">
defineProps<{
  label: string
  spaceTask?: boolean
}>()
const emit = defineEmits<{
  expand: []
}>()
</script>

<template>
  <div
    class="desktop-task-sidebar-expand-row"
    :class="{ 'is-space-task': spaceTask }"
  >
    <button
      class="desktop-task-sidebar-expand-row__button"
      type="button"
      @click="emit('expand')"
    >
      {{ label }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.desktop-task-sidebar-expand-row {
  height: var(--buddy-task-sidebar-row-size, 2.5rem);
  min-width: 0;
  padding-right: var(--buddy-task-sidebar-scrollbar-gutter, 0);
  padding-bottom: calc(var(--buddy-task-sidebar-row-size, 2.5rem) - var(--buddy-task-sidebar-row-height, 2.25rem));
  padding-left: var(--buddy-task-sidebar-scrollbar-gutter, 0);

  &.is-space-task {
    padding-left: 1.75rem;
  }
}

.desktop-task-sidebar-expand-row__button {
  display: flex;
  width: 100%;
  height: var(--buddy-task-sidebar-row-height, 2.25rem);
  align-items: center;
  border: 0;
  border-radius: var(--buddy-task-sidebar-state-radius, 8px);
  background: transparent;
  color: var(--buddy-text-muted);
  cursor: pointer;
  font-size: var(--buddy-task-sidebar-item-font-size, var(--buddy-sidebar-item-font-size));
  font-weight: var(--buddy-sidebar-item-font-weight);
  line-height: 20px;
  padding: 0 0.5rem 0 6px;
  text-align: left;
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &:hover {
    background: var(--buddy-state-hover);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}
</style>

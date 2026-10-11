<script setup lang="ts">
import { ArrowDown16Regular } from '@vicons/fluent'

import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

defineProps<{
  label: string
}>()

const emit = defineEmits<{
  activate: []
}>()
</script>

<template>
  <button
    :aria-label="label"
    class="buddy-chat-return-to-latest inline-flex w-7 min-w-7 h-7 min-h-7 items-center justify-center border-1 border-solid border-border rounded-micro bg-raised shadow-soft text-muted cursor-pointer p-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
    type="button"
    @click="emit('activate')"
  >
    <DesktopIcon
      aria-hidden="true"
      :component="ArrowDown16Regular"
      class="buddy-chat-return-to-latest__icon"
    />
  </button>
</template>

<style scoped lang="scss">
.buddy-chat-return-to-latest {
  transition:
    border-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &:hover {
    border-color: var(--buddy-accent-border);
    background: color-mix(
      in srgb,
      var(--buddy-accent-text) 8%,
      var(--buddy-surface-raised) 92%
    );
    color: var(--buddy-accent-text);
  }

  &:active {
    background: color-mix(
      in srgb,
      var(--buddy-accent-text) 14%,
      var(--buddy-surface-raised) 86%
    );
  }
}

.buddy-chat-return-to-latest__icon {
  width: 1rem;
  height: 1rem;
  flex: 0 0 auto;
  font-size: 1rem;
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-return-to-latest {
    transition: none;
  }
}
</style>

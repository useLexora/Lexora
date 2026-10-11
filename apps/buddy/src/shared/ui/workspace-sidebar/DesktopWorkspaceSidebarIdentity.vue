<script setup lang="ts">
defineProps<{
  label: string
  visible: boolean
}>()
</script>

<template>
  <div class="desktop-workspace-sidebar-identity flex min-w-0 flex-1 items-center">
    <Transition name="desktop-workspace-sidebar-identity">
      <div v-if="visible" class="desktop-workspace-sidebar-identity__content flex min-w-0 items-center text-nav-foreground">
        <strong class="desktop-workspace-sidebar-identity__label overflow-hidden text-sidebar-header [font-weight:var(--buddy-sidebar-header-font-weight)] text-ellipsis whitespace-nowrap">{{ label }}</strong>
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
.desktop-workspace-sidebar-identity__content {
  transition:
    opacity 220ms ease-out,
    transform 360ms cubic-bezier(0.16, 1, 0.3, 1);
  transition-delay: 70ms;
}

.desktop-workspace-sidebar-identity__label {
  transition:
    opacity 180ms ease-out,
    transform 300ms cubic-bezier(0.16, 1, 0.3, 1);
  transition-delay: 150ms;
}

.desktop-workspace-sidebar-identity-enter-active {
  will-change: opacity, transform;
}

.desktop-workspace-sidebar-identity-enter-from {
  opacity: 0;
  transform: translateX(-2rem);
}

.desktop-workspace-sidebar-identity-enter-from .desktop-workspace-sidebar-identity__label {
  opacity: 0;
  transform: translateX(-0.625rem);
}

.desktop-workspace-sidebar-identity-leave-active {
  transition-delay: 0ms;
  transition-duration: 100ms, 140ms;
  transition-timing-function: ease-in, cubic-bezier(0.4, 0, 1, 1);
  will-change: opacity, transform;
}

.desktop-workspace-sidebar-identity-leave-to {
  opacity: 0;
  transform: translateX(-0.5rem);
}

@media (prefers-reduced-motion: reduce) {
  .desktop-workspace-sidebar-identity__content,
  .desktop-workspace-sidebar-identity__label {
    transition: none;
  }
}
</style>

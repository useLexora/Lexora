<template>
  <span class="desktop-ring-spinner block h-3 w-3 flex-none rounded-full" aria-hidden="true" />
</template>

<style scoped lang="scss">
.desktop-ring-spinner {
  border: 1.5px solid var(--buddy-border-strong);
  border-top-color: var(--buddy-text-secondary);
  animation: desktop-ring-spin 900ms linear infinite;
}

@keyframes desktop-ring-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-ring-spinner {
    animation: none;
  }
}
</style>

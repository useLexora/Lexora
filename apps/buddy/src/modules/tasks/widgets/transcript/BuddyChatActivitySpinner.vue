<template>
  <span class="buddy-chat-activity-spinner block w-[10px] h-[10px] flex-none rounded-full" aria-hidden="true" />
</template>

<style scoped lang="scss">
.buddy-chat-activity-spinner {
  border: 1.5px solid var(--buddy-border-strong);
  border-top-color: var(--buddy-text-secondary);
  animation: buddy-chat-activity-spin 900ms linear infinite;
}

@keyframes buddy-chat-activity-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-activity-spinner { animation: none; }
}
</style>

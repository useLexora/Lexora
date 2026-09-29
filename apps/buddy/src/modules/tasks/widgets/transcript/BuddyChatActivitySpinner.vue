<template>
  <span class="buddy-chat-activity-spinner" aria-hidden="true" />
</template>

<style scoped>
.buddy-chat-activity-spinner {
  display: block;
  width: 10px;
  height: 10px;
  flex: none;
  border: 1.5px solid var(--buddy-border-strong);
  border-top-color: var(--buddy-text-secondary);
  border-radius: 50%;
  animation: buddy-chat-activity-spin 900ms linear infinite;
}

@keyframes buddy-chat-activity-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-activity-spinner { animation: none; }
}
</style>

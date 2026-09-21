<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="conversation-status__section">
    <h3 class="conversation-status__section-title">
      {{ title }}
    </h3>
    <slot />
  </section>
</template>

<style scoped lang="scss">
.conversation-status__section {
  & + & {
    margin-top: 8px;
    border-top: 1px solid var(--buddy-border-subtle);
    padding-top: 8px;
  }
}

.conversation-status__section-title {
  margin: 0 0 4px;
  color: var(--buddy-text-primary);
  padding: 0 2px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
}
</style>

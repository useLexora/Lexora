<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="conversation-status__section">
    <h3 class="mt-0 mr-0 mb-[4px] ml-0 text-fg py-0 px-[2px] text-[12px] font-500 leading-[1.5]">
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
</style>

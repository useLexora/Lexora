<script setup lang="ts">
import BuddyChatActivityLoader from './BuddyChatActivityLoader.vue'
import BuddyChatShimmerText from './BuddyChatShimmerText.vue'

defineProps<{
  active?: boolean
  label: string
  detail?: string
  warning?: boolean
}>()
</script>

<template>
  <div class="buddy-chat-activity-status flex min-w-0 min-h-[var(--buddy-chat-activity-row-height)] items-center gap-[var(--buddy-chat-activity-row-gap)] text-muted text-[length:var(--buddy-chat-process-font-size)] leading-[22px]" :class="{ 'is-warning': warning }" role="status">
    <BuddyChatActivityLoader v-if="active" />
    <slot v-else name="icon" />
    <BuddyChatShimmerText class="buddy-chat-activity-status__label" :mode="active && !warning ? 'continuous' : 'static'">
      {{ label }}
    </BuddyChatShimmerText>
    <span v-if="detail" class="min-w-0 text-muted text-[length:var(--buddy-chat-tool-font-size)]">{{ detail }}</span>
    <slot />
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-activity-status {
  --buddy-shimmer-base: var(--buddy-text-secondary);

  &.is-warning { --buddy-shimmer-base: var(--buddy-status-warning-text); color: var(--buddy-status-warning-text); }
}

.buddy-chat-activity-status__label {
  flex: none;
  max-width: 75%;
  overflow: hidden;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

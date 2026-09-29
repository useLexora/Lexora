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
  <div class="buddy-chat-activity-status" :class="{ 'is-warning': warning }" role="status">
    <BuddyChatActivityLoader v-if="active" />
    <slot v-else name="icon" />
    <BuddyChatShimmerText class="buddy-chat-activity-status__label" :mode="active && !warning ? 'continuous' : 'static'">
      {{ label }}
    </BuddyChatShimmerText>
    <span v-if="detail" class="buddy-chat-activity-status__detail">{{ detail }}</span>
    <slot />
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-activity-status {
  --buddy-shimmer-base: var(--buddy-text-secondary);
  display: flex;
  min-width: 0;
  min-height: var(--buddy-chat-activity-row-height);
  align-items: center;
  gap: var(--buddy-chat-activity-row-gap);
  color: var(--buddy-text-secondary);
  font-size: var(--buddy-chat-process-font-size);
  line-height: 22px;

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

.buddy-chat-activity-status__detail {
  min-width: 0;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-chat-tool-font-size);
}
</style>

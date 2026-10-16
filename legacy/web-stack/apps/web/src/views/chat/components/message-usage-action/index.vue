<script setup lang="ts">
import type { ChatMessage } from '@/apis/chat'
import { DataAnalysis } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { createChatMessageUsageView } from '../../utils/chat-usage-display'

const props = defineProps<{
  message: ChatMessage
}>()

const { locale, t } = useI18n({ useScope: 'global' })
const usageView = computed(() => {
  readReactiveLocale(locale.value)
  return createChatMessageUsageView(props.message)
})

function readReactiveLocale(value: string): string {
  return value
}
</script>

<template>
  <ElPopover
    v-if="usageView"
    trigger="hover"
    placement="bottom"
    :width="300"
    :hide-after="0"
  >
    <template #reference>
      <ElButton
        text
        class="chat-message-usage-action__button h-7 min-w-7 w-7 rounded-lg p-0"
        :aria-label="usageView.title"
      >
        <ElIcon><DataAnalysis /></ElIcon>
      </ElButton>
    </template>

    <section class="chat-message-usage-action">
      <header class="chat-message-usage-action__header">
        <div>
          <div class="chat-message-usage-action__title">
            {{ usageView.title }}
          </div>
          <div class="chat-message-usage-action__summary" :class="{ 'is-estimated': usageView.estimated }">
            {{ usageView.summary }}
          </div>
        </div>
        <ElTag v-if="usageView.estimated" size="small" type="warning" effect="plain">
          {{ t('chat.usage.estimate') }}
        </ElTag>
      </header>

      <div class="chat-message-usage-action__rows">
        <div
          v-for="row in usageView.rows"
          :key="row.label"
          class="chat-message-usage-action__row"
          :class="row.tone ? `is-${row.tone}` : ''"
        >
          <span>{{ row.label }}</span>
          <span>{{ row.value }}</span>
        </div>
      </div>

      <footer v-if="usageView.notes.length" class="chat-message-usage-action__notes">
        <div v-for="note in usageView.notes" :key="note">
          {{ note }}
        </div>
      </footer>
    </section>
  </ElPopover>
</template>

<style scoped lang="scss">
.chat-message-usage-action__button {
  color: var(--brand-text-secondary);
  background: color-mix(in srgb, var(--brand-fill-light) 34%, transparent);

  &:hover,
  &:focus-visible {
    color: var(--brand-primary);
    background-color: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
  }
}

.chat-message-usage-action {
  color: var(--brand-text-primary);
}

.chat-message-usage-action__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.625rem;
}

.chat-message-usage-action__title {
  color: var(--brand-text-secondary);
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1.45;
}

.chat-message-usage-action__summary {
  margin-top: 0.125rem;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;

  &.is-estimated {
    color: color-mix(in srgb, var(--brand-text-primary) 84%, var(--el-color-warning));
  }
}

.chat-message-usage-action__rows {
  display: grid;
  gap: 0.25rem;
}

.chat-message-usage-action__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 1.5rem;
  color: var(--brand-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.45;

  span:last-child {
    color: var(--brand-text-primary);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  &.is-muted {
    color: var(--brand-text-tertiary);

    span:last-child {
      color: var(--brand-text-tertiary);
    }
  }

  &.is-warning span:last-child {
    color: var(--el-color-warning);
  }
}

.chat-message-usage-action__notes {
  margin-top: 0.625rem;
  padding-top: 0.625rem;
  border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 52%, transparent);
  color: var(--brand-text-tertiary);
  font-size: 0.75rem;
  line-height: 1.5;
}
</style>

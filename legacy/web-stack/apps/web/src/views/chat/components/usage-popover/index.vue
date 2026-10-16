<script setup lang="ts">
import type { ChatConversationUsageView } from '../../utils/chat-usage-display'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  usage: ChatConversationUsageView
}>()

const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <ElPopover
    trigger="hover"
    placement="bottom-end"
    :width="360"
    :hide-after="0"
    popper-class="chat-usage-popover-popper"
  >
    <template #reference>
      <ElButton
        text
        class="chat-usage-popover__trigger h-8 min-w-8 w-8 rounded-lg p-0"
        :aria-label="t('chat.usage.open')"
      >
        <SvgIcon category="ui" icon="usage-window" size="1rem" />
      </ElButton>
    </template>

    <section class="chat-usage-popover">
      <header class="chat-usage-popover__header">
        <div class="chat-usage-popover__title">
          {{ t('chat.usage.conversationInfo') }}
        </div>
        <div class="chat-usage-popover__subtitle">
          {{ t('chat.usage.conversationInfoSubtitle') }}
        </div>
      </header>

      <section v-if="props.usage.budget" class="chat-usage-popover__section is-budget">
        <div class="chat-usage-popover__section-head">
          <span>{{ t('chat.usage.contextBudget') }}</span>
          <span>{{ props.usage.budget.usedText }}</span>
        </div>
        <div class="chat-usage-popover__budget-track">
          <div
            class="chat-usage-popover__budget-fill"
            :class="{
              'is-empty': props.usage.budget.fillPercent <= 0,
              'is-warning': props.usage.budget.usedPercent >= 90,
            }"
            :style="{ width: `${props.usage.budget.fillPercent}%` }"
          />
        </div>
        <div class="chat-usage-popover__source">
          {{ props.usage.budget.sourceText }}
        </div>
        <div class="chat-usage-popover__rows">
          <div
            v-for="row in props.usage.budget.rows"
            :key="row.label"
            class="chat-usage-popover__row"
            :class="row.tone ? `is-${row.tone}` : ''"
          >
            <span>{{ row.label }}</span>
            <span>{{ row.value }}</span>
          </div>
        </div>
      </section>

      <section class="chat-usage-popover__section" :class="{ 'is-first': !props.usage.budget }">
        <div class="chat-usage-popover__section-head">
          <span>{{ t('chat.usage.conversationTotal') }}</span>
        </div>
        <div class="chat-usage-popover__rows">
          <div
            v-for="row in props.usage.summaryRows"
            :key="row.label"
            class="chat-usage-popover__row"
            :class="row.tone ? `is-${row.tone}` : ''"
          >
            <span>{{ row.label }}</span>
            <span>{{ row.value }}</span>
          </div>
        </div>
      </section>

      <section v-if="props.usage.latestRows.length" class="chat-usage-popover__section">
        <div class="chat-usage-popover__section-head">
          <span>{{ t('chat.usage.latestReply') }}</span>
        </div>
        <div class="chat-usage-popover__rows">
          <div
            v-for="row in props.usage.latestRows"
            :key="row.label"
            class="chat-usage-popover__row"
            :class="row.tone ? `is-${row.tone}` : ''"
          >
            <span>{{ row.label }}</span>
            <span>{{ row.value }}</span>
          </div>
        </div>
      </section>

      <footer class="chat-usage-popover__notes">
        <div v-for="note in props.usage.notes" :key="note">
          {{ note }}
        </div>
      </footer>
    </section>
  </ElPopover>
</template>

<style scoped lang="scss">
.chat-usage-popover__trigger {
  color: var(--brand-text-secondary);
  background: color-mix(in srgb, var(--brand-bg-surface) 92%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  box-shadow: var(--brand-shadow-hairline);

  &:hover,
  &:focus-visible {
    color: var(--brand-primary);
    background: var(--brand-bg-surface);
  }
}

.chat-usage-popover {
  color: var(--brand-text-primary);
}

.chat-usage-popover__header {
  margin-bottom: 0.75rem;
}

.chat-usage-popover__title {
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.45;
}

.chat-usage-popover__subtitle,
.chat-usage-popover__source,
.chat-usage-popover__notes {
  color: var(--brand-text-tertiary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.chat-usage-popover__section {
  padding-top: 0.875rem;
  border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 62%, transparent);

  &.is-budget {
    padding-top: 0;
    border-top: 0;
  }

  &.is-first {
    padding-top: 0;
    border-top: 0;
  }

  & + & {
    margin-top: 0.875rem;
  }
}

.chat-usage-popover__section-head,
.chat-usage-popover__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.chat-usage-popover__section-head {
  margin-bottom: 0.5rem;
  color: var(--brand-text-secondary);
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1.45;
}

.chat-usage-popover__source {
  margin-top: 0.375rem;
}

.chat-usage-popover__budget-track {
  --chat-usage-popover-budget-radius: 0.25rem;

  height: 0.5rem;
  overflow: hidden;
  border-radius: var(--chat-usage-popover-budget-radius);
  background: color-mix(in srgb, var(--brand-fill-light) 64%, transparent);
}

.chat-usage-popover__budget-fill {
  height: 100%;
  min-width: 0.75rem;
  border-radius: var(--chat-usage-popover-budget-radius);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--brand-primary) 92%, #6fd6c4),
    color-mix(in srgb, var(--brand-primary) 70%, #91d96c)
  );
  box-shadow: 0 0 0.625rem color-mix(in srgb, var(--brand-primary) 22%, transparent);

  &.is-warning {
    background: linear-gradient(90deg, var(--el-color-warning), var(--el-color-danger));
    box-shadow: 0 0 0.625rem color-mix(in srgb, var(--el-color-warning) 28%, transparent);
  }

  &.is-empty {
    min-width: 0;
    box-shadow: none;
  }
}

.chat-usage-popover__rows {
  margin-top: 0.5rem;
}

.chat-usage-popover__row {
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

.chat-usage-popover__notes {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 52%, transparent);
}
</style>

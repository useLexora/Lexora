<script setup lang="ts">
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { summarizeRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ language: BuddyLocale, usage: LocalRunTokenUsage }>()
const { t } = useBuddyI18n(() => props.language)
const number = computed(() => new Intl.NumberFormat(props.language, { maximumFractionDigits: 1 }))
const percent = computed(() => new Intl.NumberFormat(props.language, { style: 'percent', maximumFractionDigits: 1 }))
const rows = computed(() => {
  const usage = props.usage
  const summary = summarizeRunTokenUsage(usage)
  return [
    { key: 'input', value: count(summary.inputTokens) },
    { key: 'output', value: count(summary.outputTokens) },
    { key: 'cacheWrite', value: count(usage.cacheWriteTokens) },
    { key: 'cache', value: `${count(summary.cachedTokens)} / ${summary.cacheHitRate === null ? '—' : percent.value.format(summary.cacheHitRate)}` },
  ] as const
})

function count(value: number | null | undefined): string {
  return value == null ? '—' : number.value.format(value)
}
</script>

<template>
  <div class="buddy-chat-usage-details">
    <dl class="buddy-chat-usage-details__rows">
      <div v-for="row in rows" :key="row.key" :data-usage-detail="row.key">
        <dt>{{ t(`desktop.chat.usage.${row.key}`) }}</dt>
        <dd>{{ row.value }}</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-usage-details {
  width: max-content;
  max-width: calc(100vw - 48px);
  font-size: 12px;
  line-height: 1.6;
}

.buddy-chat-usage-details__rows {
  margin: 0;

  > div {
    display: flex;
    justify-content: space-between;
    gap: 20px;
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
}
</style>

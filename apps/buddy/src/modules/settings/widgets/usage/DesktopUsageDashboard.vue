<script setup lang="ts">
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { UsageAnalyticsState } from '../../state/useUsageAnalytics'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { summarizeRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import { NAlert, NButton, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatUsageNumber } from '../../model/usageAnalytics'
import DesktopUsageHeatmap from './DesktopUsageHeatmap.vue'
import DesktopUsageModels from './DesktopUsageModels.vue'
import DesktopUsageTasks from './DesktopUsageTasks.vue'
import DesktopUsageTrend from './DesktopUsageTrend.vue'

const props = defineProps<{
  analytics: UsageAnalyticsState
  language: BuddyLocale
  providers: readonly LocalProvider[]
  catalog: readonly LocalRuntimeModelOption[]
}>()
const emit = defineEmits<{ openTask: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const metrics = computed(() => [
  { key: 'tokens', label: t('usageAnalytics.totalTokens'), value: props.analytics.overview.value.totals.totalTokens },
  { key: 'calls', label: t('usageAnalytics.calls'), value: props.analytics.overview.value.totals.recordCount },
  { key: 'days', label: t('usageAnalytics.activeDays'), value: props.analytics.overview.value.activeDays },
])
const tokenBuckets = computed(() => {
  const { totals } = props.analytics.overview.value
  return [
    ['usageAnalytics.uncachedInput', totals.inputTokens],
    ['usageAnalytics.output', totals.outputTokens],
    ['usageAnalytics.cacheRead', totals.cacheReadTokens],
    ['usageAnalytics.cacheWrite', totals.cacheWriteTokens],
  ] as const
})
const cacheRate = computed(() => summarizeRunTokenUsage(props.analytics.overview.value.totals).cacheHitRate)
const cacheLabel = computed(() => cacheRate.value === null ? '—' : new Intl.NumberFormat(props.language, { style: 'percent', maximumFractionDigits: 1 }).format(cacheRate.value))
</script>

<template>
  <div class="usage-dashboard grid min-w-0 gap-[24px]">
    <NAlert v-if="analytics.error.value" type="error" :show-icon="false">
      {{ analytics.error.value }}
      <NButton size="small" @click="analytics.refresh">
        {{ t('desktop.loading.retry') }}
      </NButton>
    </NAlert>
    <template v-else>
      <div class="usage-dashboard__overview flex items-center gap-[28px]">
        <dl class="usage-summary grid min-w-0 flex-1 grid-cols-[repeat(4,_minmax(0,_1fr))] gap-[20px] m-0 pt-[2px] pr-0 pb-[4px] pl-0">
          <div v-for="metric in metrics" :key="metric.key" class="usage-summary__metric min-w-0" :data-metric="metric.key">
            <dt>{{ metric.label }}</dt>
            <dd>
              <NTooltip v-if="analytics.overview.value.totals.recordCount">
                <template #trigger>
                  <strong>{{ formatUsageNumber(metric.value, language) }}</strong>
                </template>
                {{ new Intl.NumberFormat(language).format(metric.value) }}
                <div v-if="metric.key === 'tokens'" class="usage-summary__breakdown grid max-w-[290px] gap-[8px] mt-[12px]">
                  <div v-for="[key, value] in tokenBuckets" :key="key" class="usage-summary__bucket flex justify-between gap-[24px]">
                    <span>{{ t(key) }}</span><span>{{ new Intl.NumberFormat(language).format(value) }}</span>
                  </div>
                  <p>{{ t('usageAnalytics.compositionNote') }}</p>
                </div>
              </NTooltip>
              <strong v-else>—</strong>
            </dd>
          </div>
          <div class="usage-summary__metric min-w-0" data-metric="cache">
            <dt>
              <NTooltip>
                <template #trigger>
                  <span>{{ t('usageAnalytics.cacheRate') }}</span>
                </template>
                {{ t('usageAnalytics.cacheRateNote') }}
              </NTooltip>
            </dt>
            <dd><strong>{{ cacheLabel }}</strong></dd>
          </div>
        </dl>
      </div>
      <DesktopUsageHeatmap
        :start-date="analytics.range.value.startDate" :end-date="analytics.range.value.endDate"
        :days="analytics.overview.value.days" :total-tokens="analytics.overview.value.totals.totalTokens"
        :record-count="analytics.overview.value.totals.recordCount" :language="language"
        :period="analytics.period.value" :years="analytics.years.value" :loading="analytics.loading.value"
        @update:period="analytics.setPeriod"
      />
      <div v-if="!analytics.overview.value.totals.recordCount" class="usage-dashboard__empty py-[20px] px-0 text-center">
        <strong>{{ t('usageAnalytics.empty') }}</strong><p>{{ t('usageAnalytics.emptyDescription') }}</p>
      </div>
      <template v-else>
        <div class="usage-dashboard__annual grid min-w-0 grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)] gap-[20px]">
          <DesktopUsageTasks :tasks="analytics.tasks.value" :loading="analytics.tasksLoading.value" :error="analytics.tasksError.value" :language="language" @open-task="emit('openTask', $event)" @retry="analytics.refresh" />
          <DesktopUsageModels :models="analytics.overview.value.models" :providers="providers" :catalog="catalog" :language="language" />
        </div>
        <DesktopUsageTrend :trend="analytics.trend" :language="language" />
      </template>
    </template>
    <footer class="border-t-1 border-t-solid border-t-border pt-[16px] text-muted text-[11px] leading-[1.7]">
      {{ t('usageAnalytics.deletedNote') }}
    </footer>
  </div>
</template>

<style scoped lang="scss">
.usage-dashboard { container: usage / inline-size; }
.usage-summary dt { margin-bottom: 8px; color: var(--buddy-text-secondary); font-size: 12px; }
.usage-summary dd { margin: 0; }
.usage-summary strong { color: var(--buddy-text-strong); font-size: clamp(21px, 2.8cqi, 30px); font-variant-numeric: tabular-nums; font-weight: 550; line-height: 1.2; letter-spacing: -0.6px; }
.usage-summary__metric:first-child strong { color: var(--buddy-accent-text); }
.usage-summary__breakdown { font-size: 12px; font-variant-numeric: tabular-nums; }
.usage-summary__bucket > span:first-child { color: var(--buddy-text-secondary); }
.usage-summary__breakdown p { margin: 4px 0 0; color: var(--buddy-text-secondary); font-size: 11px; line-height: 1.6; }
.usage-dashboard__empty strong { color: var(--buddy-text-primary); font-size: 14px; font-weight: 500; }
.usage-dashboard__empty p { color: var(--buddy-text-secondary); font-size: 12px; line-height: 1.6; }
@container usage (max-width: 760px) {
  .usage-dashboard__overview { flex-wrap: wrap; gap: 20px; }
  .usage-summary { flex-basis: 100%; gap: 14px; }
  .usage-dashboard__annual { grid-template-columns: minmax(0, 1fr); }
}
</style>

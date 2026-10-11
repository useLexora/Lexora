<script setup lang="ts">
import type { UsageChartOption } from '../../model/usageCharts'
import type { UsageTrendState } from '../../state/useUsageTrend'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NDatePicker, NRadioButton, NRadioGroup, useThemeVars } from 'naive-ui'
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopPaneBoundary from '@/shared/ui/loading/DesktopPaneBoundary.vue'
import { localUsageDate } from '../../model/usageAnalytics'
import { createUsageTrendChart } from '../../model/usageCharts'
import { useUsageChart } from './useUsageChart'

const props = defineProps<{ trend: UsageTrendState, language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const headingId = useId()
const helpId = useId()
const chart = useTemplateRef<HTMLDivElement>('chart')
const theme = useThemeVars()
const views = computed(() => [
  { value: 'day', label: t('usageAnalytics.daily') },
  { value: 'week', label: t('usageAnalytics.weekly') },
  { value: 'month', label: t('usageAnalytics.monthly') },
  { value: 'year', label: t('usageAnalytics.yearly') },
])
const buckets = computed(() => props.trend.buckets.value)
const hasRecords = computed(() => buckets.value.some(bucket => bucket.recordCount > 0))
const labels = computed(() => {
  const timeZone = props.trend.request.value.timeZone
  const hourly = props.trend.view.value === 'day'
  const number = new Intl.NumberFormat(props.language)
  const date = new Intl.DateTimeFormat(props.language, { dateStyle: 'medium', timeZone })
  const hour = new Intl.DateTimeFormat(props.language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset', timeZone })
  return buckets.value.map((bucket) => {
    const label = `${date.format(new Date(bucket.startAt))}${hourly ? ` · ${hour.format(new Date(bucket.startAt))} — ${hour.format(new Date(bucket.endAt))}` : ''}`
    return bucket.totalTokens === null
      ? `${label}\n${t('usageAnalytics.noRecord')}`
      : `${label}\n${number.format(bucket.totalTokens)} tokens\n${t('usageAnalytics.modelCalls', { count: number.format(bucket.recordCount) })}`
  })
})
const option = computed<UsageChartOption>(() => {
  const base = createUsageTrendChart(buckets.value)
  const colors = theme.value
  const number = new Intl.NumberFormat(props.language, { notation: 'compact', maximumFractionDigits: 1 })
  const date = new Intl.DateTimeFormat(props.language, {
    timeZone: props.trend.request.value.timeZone,
    ...(props.trend.view.value === 'day' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : { month: 'short', day: 'numeric' }),
  })
  const axisLabels = new Map(buckets.value.map(bucket => [bucket.startAt, date.format(new Date(bucket.startAt))]))
  return {
    ...base,
    color: [colors.primaryColor],
    grid: { left: 4, right: 16, top: 14, bottom: 4, outerBoundsMode: 'same' },
    xAxis: {
      ...base.xAxis,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: colors.textColor3, fontSize: 10, margin: 14, hideOverlap: true, showMinLabel: true, showMaxLabel: true, formatter: (value: string) => axisLabels.get(value) ?? value },
      axisPointer: { show: true, snap: true, animation: false, lineStyle: { color: colors.primaryColor, type: 'dashed', opacity: 0.5 } },
    },
    yAxis: {
      ...base.yAxis,
      axisLabel: { color: colors.textColor3, fontSize: 10, formatter: (value: number) => number.format(value) },
      splitLine: { lineStyle: { color: colors.borderColor, type: 'dashed', opacity: 0.6 } },
    },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const item = Array.isArray(params) ? params[0] : params
        return item ? labels.value[item.dataIndex] ?? '' : ''
      },
    },
  }
})
const activeIndex = shallowRef<number | null>(null)
const { showTip, hideTip } = useUsageChart(chart, option)
watch(buckets, () => activeIndex.value = null)
function isDateDisabled(timestamp: number) {
  const date = localUsageDate(new Date(timestamp))
  return date < props.trend.annual.value.startDate || date > props.trend.annual.value.endDate
}
function inspect(index: number) {
  if (!buckets.value.length)
    return
  activeIndex.value = Math.max(0, Math.min(buckets.value.length - 1, index))
  showTip(activeIndex.value)
}
function dismiss() {
  activeIndex.value = null
  hideTip()
}
function navigate(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    dismiss()
    return
  }
  const current = activeIndex.value ?? buckets.value.length - 1
  const next = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: buckets.value.length - 1 }[event.key]
  if (next === undefined)
    return
  event.preventDefault()
  inspect(next)
}
</script>

<template>
  <section class="usage-trend relative min-w-0 border border-solid border-border rounded-[8px] p-[18px]" :data-view="trend.view.value">
    <header class="usage-trend__heading flex flex-wrap items-center justify-between gap-[12px] mb-[20px]">
      <div>
        <h3 :id="headingId">
          {{ t('usageAnalytics.trend') }}
        </h3>
        <p class="usage-trend__range mt-[5px] mr-0 mb-0 ml-0 text-muted">
          {{ trend.request.value.startDate }}<template v-if="trend.request.value.startDate !== trend.request.value.endDate">
            — {{ trend.request.value.endDate }}
          </template>
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-[12px]">
        <label v-if="trend.view.value !== 'year'" class="w-[132px]">
          <span class="usage-trend__accessible absolute top-0 left-0 w-[1px] h-[1px] overflow-hidden whitespace-nowrap">{{ t('usageAnalytics.trendDate') }}</span>
          <NDatePicker
            :formatted-value="trend.date.value" type="date" size="small" value-format="yyyy-MM-dd"
            :is-date-disabled="isDateDisabled" @update:formatted-value="trend.setDate"
          />
        </label>
        <NRadioGroup :value="trend.view.value" class="usage-trend__views" size="small" @update:value="trend.setView">
          <NRadioButton v-for="view in views" :key="view.value" :value="view.value">
            {{ view.label }}
          </NRadioButton>
        </NRadioGroup>
      </div>
    </header>
    <DesktopPaneBoundary :loading="trend.loading.value" :error="trend.error.value" :label="t('desktop.loading.pane')" :retry-label="t('desktop.loading.retry')" @retry="trend.retry">
      <div class="relative min-w-0">
        <div
          ref="chart" class="usage-trend__chart relative w-full h-[242px] overflow-hidden rounded-[4px] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" role="group" tabindex="0" :aria-labelledby="headingId" :aria-describedby="helpId"
          @focus="inspect(buckets.length - 1)" @blur="dismiss" @keydown="navigate" @pointerleave="dismiss"
        />
        <p v-if="!hasRecords" class="usage-trend__empty absolute grid m-0 place-items-center bg-surface text-muted text-[12px] pointer-events-none">
          {{ t('usageAnalytics.empty') }}
        </p>
        <span :id="helpId" class="usage-trend__accessible absolute top-0 left-0 w-[1px] h-[1px] overflow-hidden whitespace-nowrap">{{ t('usageAnalytics.trendKeyboard') }}</span>
        <span class="usage-trend__accessible absolute top-0 left-0 w-[1px] h-[1px] overflow-hidden whitespace-nowrap" aria-live="polite">{{ activeIndex === null ? '' : labels[activeIndex] }}</span>
      </div>
    </DesktopPaneBoundary>
  </section>
</template>

<style scoped lang="scss">
.usage-trend__heading h3 { margin: 0; color: var(--buddy-text-strong); font-size: 14px; font-weight: 600; }
.usage-trend__range { font-size: 11px; font-variant-numeric: tabular-nums; }

.usage-trend__views { flex: none; }
.usage-trend__empty { inset: 60px 20px 60px 52px; }
.usage-trend__accessible { clip-path: inset(50%); }
</style>

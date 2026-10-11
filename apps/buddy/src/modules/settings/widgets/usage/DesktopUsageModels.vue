<script setup lang="ts">
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { UsageModelTotals } from '../../model/usageAnalytics'
import type { UsageChartOption } from '../../model/usageCharts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useThemeVars } from 'naive-ui'
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { createUsageModelDistribution, usageModelKey } from '../../model/usageAnalytics'
import { createUsagePieChart } from '../../model/usageCharts'
import { useUsageChart } from './useUsageChart'

const props = defineProps<{
  models: readonly UsageModelTotals[]
  providers: readonly LocalProvider[]
  catalog: readonly LocalRuntimeModelOption[]
  language: BuddyLocale
}>()
const { t } = useBuddyI18n(() => props.language)
const headingId = useId()
const helpId = useId()
const chart = useTemplateRef<HTMLDivElement>('chart')
const theme = useThemeVars()
const activeIndex = shallowRef<number | null>(null)
const modelColors = ['#5479B5', '#D69B4C', '#439B8C', '#9472B7', '#CE788C', '#889CA6']
const rows = computed(() => {
  const providers = new Map(props.providers.map(provider => [provider.id, provider.displayName]))
  const catalog = new Map(props.catalog.map(model => [usageModelKey(model), model.displayName]))
  const number = new Intl.NumberFormat(props.language)
  const percent = new Intl.NumberFormat(props.language, { style: 'percent', maximumFractionDigits: 1 })
  return createUsageModelDistribution(props.models).map((group) => {
    const members = group.members.map(model => ({
      ...model,
      name: catalog.get(usageModelKey(model)) ?? model.modelId,
      provider: providers.get(model.providerId) ?? model.providerId,
    }))
    const name = members.length === 1 ? members[0]!.name : t('usageAnalytics.otherModels', { count: members.length })
    const share = percent.format(group.share)
    return {
      ...group,
      name,
      label: `${name}\n${share}${members.length === 1 ? ` · ${members[0]!.provider}` : ''}`,
      detail: [
        `${name} · ${share}`,
        ...members.map(member => `${member.name} · ${member.provider}\n${number.format(member.totalTokens)} tokens · ${t('usageAnalytics.modelCalls', { count: number.format(member.recordCount) })}`),
      ].join('\n\n'),
    }
  }).filter(row => row.totalTokens > 0)
})
const option = computed<UsageChartOption>(() => {
  const base = createUsagePieChart(rows.value)
  const colors = theme.value
  return {
    ...base,
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        const item = Array.isArray(params) ? params[0] : params
        return item ? rows.value[item.dataIndex]?.detail ?? '' : ''
      },
    },
    series: base.series.map(series => ({
      ...series,
      label: { ...series.label, color: colors.textColor2 },
      labelLine: { ...series.labelLine, lineStyle: { color: colors.textColorDisabled, width: 1 } },
      emptyCircleStyle: { color: colors.actionColor },
      data: series.data.map((item, index) => ({
        ...item,
        itemStyle: { color: modelColors[index % modelColors.length] },
        labelLine: { lineStyle: { color: modelColors[index % modelColors.length] } },
      })),
    })),
  }
})
const { showTip, hideTip } = useUsageChart(chart, option)
watch(rows, () => activeIndex.value = null)
function inspect(index: number) {
  if (!rows.value.length)
    return
  activeIndex.value = Math.max(0, Math.min(rows.value.length - 1, index))
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
  const current = activeIndex.value ?? 0
  const next = { ArrowLeft: current - 1, ArrowUp: current - 1, ArrowRight: current + 1, ArrowDown: current + 1, Home: 0, End: rows.value.length - 1 }[event.key]
  if (next === undefined)
    return
  event.preventDefault()
  inspect(next)
}
</script>

<template>
  <section class="usage-models relative flex min-w-0 flex-col gap-[12px] border border-solid border-border rounded-[8px] p-[18px]">
    <header class="usage-models__heading flex items-center justify-between gap-[12px]">
      <h3 :id="headingId">
        {{ t('usageAnalytics.models') }}
      </h3>
      <span>{{ t('usageAnalytics.modelsCount', { count: models.length }) }}</span>
    </header>
    <div
      ref="chart" class="usage-models__chart relative w-full h-[300px] min-h-[280px] flex-1 overflow-hidden rounded-[4px] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" role="group" tabindex="0" :aria-labelledby="headingId" :aria-describedby="helpId"
      @focus="inspect(0)" @blur="dismiss" @keydown="navigate" @pointerleave="dismiss"
    />
    <span :id="helpId" class="usage-models__accessible absolute top-0 left-0 w-[1px] h-[1px] overflow-hidden whitespace-nowrap">{{ t('usageAnalytics.modelsKeyboard') }}</span>
    <span class="usage-models__accessible absolute top-0 left-0 w-[1px] h-[1px] overflow-hidden whitespace-nowrap" aria-live="polite">{{ activeIndex === null ? '' : rows[activeIndex]?.detail }}</span>
    <span v-if="!rows.length" class="absolute inset-[calc(50%_+_16px)_0_auto] text-muted text-[13px] text-center pointer-events-none">0 tokens</span>
  </section>
</template>

<style scoped lang="scss">
.usage-models__heading h3 { margin: 0; color: var(--buddy-text-strong); font-size: 14px; font-weight: 600; }
.usage-models__heading > span { color: var(--buddy-text-secondary); font-size: 11px; }
.usage-models__accessible { clip-path: inset(50%); }
</style>

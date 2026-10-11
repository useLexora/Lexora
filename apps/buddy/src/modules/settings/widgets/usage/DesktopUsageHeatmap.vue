<script setup lang="ts">
import type { UsageCalendarCell, UsageDay } from '../../model/usageAnalytics'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useEventListener } from '@vueuse/core'
import { NPopover, NSelect } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopUsageHeatmapGrid from './DesktopUsageHeatmapGrid.vue'

const props = defineProps<{
  startDate: string
  endDate: string
  days: readonly UsageDay[]
  totalTokens: number
  recordCount: number
  period: 'recent' | number
  years: readonly number[]
  loading: boolean
  language: BuddyLocale
}>()
const emit = defineEmits<{ 'update:period': [period: 'recent' | number] }>()
const { t } = useBuddyI18n(() => props.language)
const headingId = useId()
const periodOptions = computed(() => [
  { label: t('usageAnalytics.recentYear'), value: 'recent' },
  ...props.years.map(year => ({ label: String(year), value: year })),
])
const hovered = shallowRef<{ cell: UsageCalendarCell, x: number, y: number } | null>(null)
const dateFormat = computed(() => new Intl.DateTimeFormat(props.language, { dateStyle: 'long', timeZone: 'UTC' }))
const numberFormat = computed(() => new Intl.NumberFormat(props.language))
useEventListener(window, ['scroll', 'resize'], () => hovered.value = null, { capture: true, passive: true })
function inspect(cell: UsageCalendarCell | null, x: number, y: number) {
  hovered.value = cell ? { cell, x, y } : null
}
</script>

<template>
  <section class="usage-heatmap relative grid min-w-0 gap-[16px] border-1 border-solid border-border rounded-[8px] p-[18px]" :aria-labelledby="headingId">
    <header class="usage-heatmap__heading">
      <h2 :id="headingId">
        <strong>{{ recordCount ? numberFormat.format(totalTokens) : '—' }}</strong>
        <span>{{ period === 'recent' ? t('usageAnalytics.heatmapRecentSuffix') : t('usageAnalytics.heatmapYearSuffix', { year: period }) }}</span>
      </h2>
      <label class="w-[126px] flex-none">
        <span class="usage-heatmap__accessible absolute top-0 left-0 w-[1px] h-[1px] overflow-hidden whitespace-nowrap">{{ t('usageAnalytics.period') }}</span>
        <NSelect :value="period" :options="periodOptions" size="small" :disabled="loading" @update:value="emit('update:period', $event)" />
      </label>
    </header>
    <DesktopUsageHeatmapGrid :start-date="startDate" :end-date="endDate" :days="days" :language="language" @inspect="inspect" />
    <footer class="usage-heatmap__footer justify-end text-muted text-[11px]">
      <div class="usage-heatmap__legend flex-nowrap gap-[8px]">
        <span>{{ t('usageAnalytics.less') }}</span>
        <span class="usage-heatmap__scale flex gap-[4px]" aria-hidden="true">
          <i v-for="level in [-1, 1, 2, 3, 4]" :key="level" class="usage-heatmap__cell" :style="{ background: `var(--usage-level-${level})` }" />
        </span>
        <span>{{ t('usageAnalytics.more') }}</span>
      </div>
    </footer>
    <NPopover :show="!!hovered" :x="hovered?.x ?? 0" :y="hovered?.y ?? 0" trigger="manual" placement="top" :show-arrow="false" :animated="false" :keep-alive-on-hover="false" display-directive="show" :content-style="{ pointerEvents: 'none' }">
      <div v-if="hovered" class="usage-day-tooltip grid gap-[6px] min-w-[180px]">
        <strong>{{ dateFormat.format(new Date(hovered.cell.date)) }}</strong>
        <span>{{ hovered.cell.usage ? t('usageAnalytics.dayTokens', { tokens: numberFormat.format(hovered.cell.usage.totalTokens), calls: numberFormat.format(hovered.cell.usage.recordCount) }) : t('usageAnalytics.noDayRecord') }}</span>
        <template v-if="hovered.cell.usage">
          <div
            v-for="entry in [
              ['usageAnalytics.uncachedInput', hovered.cell.usage.inputTokens],
              ['usageAnalytics.output', hovered.cell.usage.outputTokens],
              ['usageAnalytics.cacheRead', hovered.cell.usage.cacheReadTokens],
              ['usageAnalytics.cacheWrite', hovered.cell.usage.cacheWriteTokens],
            ] as const" :key="entry[0]" class="flex justify-between gap-[24px] text-muted"
          >
            <span>{{ t(entry[0]) }}</span><span>{{ numberFormat.format(entry[1]) }}</span>
          </div>
        </template>
      </div>
    </NPopover>
  </section>
</template>

<style scoped lang="scss">
.usage-heatmap {
  --usage-level--1: var(--buddy-surface-subtle);
  --usage-level-0: var(--buddy-border-subtle);
  --usage-level-1: color-mix(in srgb, var(--buddy-accent-solid) 24%, var(--buddy-surface-base));
  --usage-level-2: color-mix(in srgb, var(--buddy-accent-solid) 45%, var(--buddy-surface-base));
  --usage-level-3: color-mix(in srgb, var(--buddy-accent-solid) 70%, var(--buddy-surface-base));
  --usage-level-4: var(--buddy-accent-solid);
}
.usage-heatmap__heading, .usage-heatmap__footer, .usage-heatmap__legend { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.usage-heatmap__heading h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin: 0; color: var(--buddy-text-primary); font-size: 13px; font-weight: 400; }
.usage-heatmap__heading h2 strong { color: var(--buddy-accent-text); font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.usage-heatmap__scale > i { width: 13px; height: 13px; border: 1px solid transparent; border-radius: 4px; }
.usage-heatmap__scale > i:first-child { border-color: var(--buddy-border-subtle); }
.usage-heatmap__accessible { clip-path: inset(50%); }
.usage-day-tooltip { font-size: 12px; font-variant-numeric: tabular-nums; }
.usage-day-tooltip > span { margin-bottom: 4px; }
</style>

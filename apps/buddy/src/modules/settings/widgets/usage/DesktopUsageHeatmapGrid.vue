<script setup lang="ts">
import type { UsageCalendarCell, UsageDay } from '../../model/usageAnalytics'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useElementSize } from '@vueuse/core'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { createUsageCalendar, shiftUsageDate, usageCalendarColumns } from '../../model/usageAnalytics'

const props = defineProps<{ startDate: string, endDate: string, days: readonly UsageDay[], language: BuddyLocale }>()
const emit = defineEmits<{ inspect: [cell: UsageCalendarCell | null, x: number, y: number] }>()
const { t } = useBuddyI18n(() => props.language)
const calendar = useTemplateRef<HTMLDivElement>('calendar')
const { width } = useElementSize(calendar)
const focusedDate = shallowRef<string | null>(null)
const weeks = computed(() => {
  const date = new Intl.DateTimeFormat(props.language, { dateStyle: 'long', timeZone: 'UTC' })
  const number = new Intl.NumberFormat(props.language)
  return createUsageCalendar(props.startDate, props.endDate, props.days).map(week => week.map(cell => ({
    ...cell,
    label: `${date.format(new Date(cell.date))} · ${cell.usage
      ? t('usageAnalytics.dayTokens', { tokens: number.format(cell.usage.totalTokens), calls: number.format(cell.usage.recordCount) })
      : t('usageAnalytics.noDayRecord')}`,
  })))
})
const cells = computed(() => new Map(weeks.value.flat().map(cell => [cell.date, cell])))
const columns = computed(() => usageCalendarColumns(width.value, weeks.value.length))
const bands = computed(() => {
  const format = new Intl.DateTimeFormat(props.language, { month: 'short', timeZone: 'UTC' })
  const result = []
  for (let index = 0; index < weeks.value.length; index += columns.value) {
    const band = weeks.value.slice(index, index + columns.value)
    const months = band.map((week, column) => {
      const first = week.find(cell => cell.inRange && cell.date.endsWith('-01')) ?? (column === 0 ? week.find(cell => cell.inRange) : undefined)
      return first ? format.format(new Date(first.date)) : ''
    })
    result.push({ key: band[0]![0]!.date, weeks: band, months })
  }
  return result
})
const weekdayLabels = computed(() => {
  const format = new Intl.DateTimeFormat(props.language, { weekday: 'short', timeZone: 'UTC' })
  return [1, 3, 5].map(day => ({ row: day + 2, label: format.format(new Date(Date.UTC(2024, 0, 7 + day))) }))
})
const tabDate = computed(() => {
  const date = focusedDate.value ?? props.endDate
  return date < props.startDate || date > props.endDate ? props.endDate : date
})
watch(bands, dismiss)
function dismiss() {
  emit('inspect', null, 0, 0)
}
function inspect(event: Event) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-date]')
  const cell = cells.value.get(button?.dataset.date ?? '')
  if (!button || !cell)
    return
  if (event.type === 'focusin')
    focusedDate.value = cell.date
  const rect = button.getBoundingClientRect()
  emit('inspect', cell, rect.left + rect.width / 2, rect.top - 6)
}
function navigate(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    dismiss()
    return
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-date]')
  const date = button?.dataset.date
  if (!date)
    return
  const offsets: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }
  let next: string
  if (event.key === 'Home')
    next = props.startDate
  else if (event.key === 'End')
    next = props.endDate
  else if (event.key in offsets)
    next = shiftUsageDate(date, offsets[event.key]!)
  else
    return
  event.preventDefault()
  next = next < props.startDate ? props.startDate : next > props.endDate ? props.endDate : next
  calendar.value?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus()
}
</script>

<template>
  <div ref="calendar" class="grid w-full min-w-0 gap-[16px]" @pointerover="inspect" @pointerleave="dismiss" @focusin="inspect" @focusout="dismiss" @click="inspect" @keydown="navigate">
    <div v-for="band in bands" :key="band.key" class="relative grid min-w-0 grid-rows-[22px_repeat(7,_auto)] gap-[3px] p-[2px]" :style="{ gridTemplateColumns: `2.5rem repeat(${columns}, minmax(0, 1fr))` }">
      <span v-for="weekday in weekdayLabels" :key="weekday.row" class="usage-heatmap__weekday col-[1] self-center" :style="{ gridRow: weekday.row }">{{ weekday.label }}</span>
      <template v-for="(week, column) in band.weeks" :key="week[0]!.date">
        <span class="usage-heatmap__month self-start pt-[2px]" :style="{ gridColumn: column + 2, gridRow: 1 }">{{ band.months[column] }}</span>
        <template v-for="(cell, row) in week" :key="cell.date">
          <button
            v-if="cell.inRange" type="button" class="usage-heatmap__cell focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[1px]" :data-date="cell.date" :data-level="cell.level"
            :style="{ gridColumn: column + 2, gridRow: row + 2, background: `var(--usage-level-${cell.level})` }"
            :tabindex="tabDate === cell.date ? 0 : -1"
          >
            <span class="usage-heatmap__accessible absolute top-0 left-0 w-[1px] h-[1px] overflow-hidden whitespace-nowrap">{{ cell.label }}</span>
          </button>
          <span v-else class="usage-heatmap__cell usage-heatmap__padding focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[1px]" :style="{ gridColumn: column + 2, gridRow: row + 2 }" aria-hidden="true" />
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.usage-heatmap__weekday, .usage-heatmap__month { color: var(--buddy-text-secondary); font-size: 10px; line-height: 1; white-space: nowrap; }
.usage-heatmap__cell { display: block; width: 100%; min-width: 0; aspect-ratio: 1; border: 1px solid transparent; border-radius: 3px; padding: 0; }
.usage-heatmap__cell[data-level='-1'] { border-color: var(--buddy-border-subtle); }
.usage-heatmap__cell[data-level='0'] { border-color: var(--buddy-border-strong); }
.usage-heatmap__padding { visibility: hidden; }
button.usage-heatmap__cell { cursor: pointer; }
button.usage-heatmap__cell:hover { outline: 1.5px solid var(--buddy-accent-text); outline-offset: 1px; }
.usage-heatmap__accessible { clip-path: inset(50%); }
</style>

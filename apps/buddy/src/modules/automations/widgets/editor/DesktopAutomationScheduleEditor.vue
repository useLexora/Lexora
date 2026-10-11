<script setup lang="ts">
import type { AutomationScheduleForm } from '../../model/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Temporal } from '@buddy-shared/automation/temporal'
import {
  NCheckbox,
  NCheckboxGroup,
  NDatePicker,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NTimePicker,
} from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  language: BuddyLocale
  value: Readonly<AutomationScheduleForm>
}>()

const emit = defineEmits<{
  update: [patch: Partial<AutomationScheduleForm>]
}>()

const { t } = useBuddyI18n(() => props.language)
const cadenceOptions = computed(() => [
  { label: t('desktop.automations.editor.daily'), value: 'daily' },
  { label: t('desktop.automations.editor.weekly'), value: 'weekly' },
  { label: t('desktop.automations.editor.monthly'), value: 'monthly' },
  { label: t('desktop.automations.editor.yearly'), value: 'yearly' },
])
const intervalUnitOptions = computed(() => [
  { label: t('desktop.automations.editor.hour'), value: 'hour' },
  { label: t('desktop.automations.editor.dayUnit'), value: 'day' },
])
const monthOptions = computed(() => Array.from({ length: 12 }, (_, index) => ({
  label: String(index + 1),
  value: index + 1,
})))
const dayOptions = computed(() => Array.from({ length: 31 }, (_, index) => ({
  label: String(index + 1),
  value: index + 1,
})))
const weekdayOptions = computed(() => {
  const monday = Temporal.PlainDate.from('2026-08-24')
  const formatter = new Intl.DateTimeFormat(props.language, {
    timeZone: 'UTC',
    weekday: 'short',
  })
  return Array.from({ length: 7 }, (_, index) => ({
    label: formatter.format(new Date(`${monday.add({ days: index }).toString()}T12:00:00Z`)),
    value: index + 1,
  }))
})
const activeRange = computed<[string, string] | null>(() => (
  props.value.activeFrom && props.value.activeUntil
    ? [props.value.activeFrom, props.value.activeUntil]
    : null
))

function update(key: keyof AutomationScheduleForm, value: unknown): void {
  emit('update', { [key]: value } as Partial<AutomationScheduleForm>)
}

function updateEvery(value: number | null): void {
  if (value !== null)
    emit('update', { every: value })
}

function updateIntervalUnit(value: 'hour' | 'day'): void {
  emit('update', {
    every: value === 'day' ? Math.max(1, Math.round(props.value.every)) : props.value.every,
    intervalUnit: value,
  })
}

function updateActiveRange(value: string | [string, string] | null): void {
  emit('update', {
    activeFrom: Array.isArray(value) ? value[0] : null,
    activeUntil: Array.isArray(value) ? value[1] : null,
  })
}
</script>

<template>
  <section class="desktop-automation-schedule grid gap-[12px] border-t-1 border-t-solid border-t-border pt-[20px]">
    <div class="desktop-automation-schedule__heading grid gap-[3px]">
      <h2>{{ t('desktop.automations.editor.frequency') }}</h2>
    </div>

    <NRadioGroup
      :value="value.frequencyMode"
      name="automation-frequency-mode"
      @update:value="update('frequencyMode', $event)"
    >
      <NRadioButton value="calendar">
        {{ t('desktop.automations.editor.calendar') }}
      </NRadioButton>
      <NRadioButton value="interval">
        {{ t('desktop.automations.editor.interval') }}
      </NRadioButton>
      <NRadioButton value="once">
        {{ t('desktop.automations.editor.once') }}
      </NRadioButton>
    </NRadioGroup>

    <div class="flex items-center flex-wrap gap-[10px]">
      <template v-if="value.frequencyMode === 'calendar'">
        <NSelect
          class="desktop-automation-schedule__cadence"
          :aria-label="t('desktop.automations.editor.cadence')"
          :options="cadenceOptions"
          :value="value.cadence"
          @update:value="update('cadence', $event)"
        />
        <NTimePicker
          class="desktop-automation-schedule__time"
          :aria-label="t('desktop.automations.editor.localTime')"
          format="HH:mm"
          :formatted-value="value.localTime"
          value-format="HH:mm"
          @update:formatted-value="update('localTime', $event)"
        />
        <NSelect
          v-if="value.cadence === 'monthly'"
          class="desktop-automation-schedule__date"
          :aria-label="t('desktop.automations.editor.dayOfMonth')"
          :options="[
            ...dayOptions,
            { label: t('desktop.automations.editor.lastDay'), value: 'last' },
          ]"
          :value="value.dayOfMonth"
          @update:value="update('dayOfMonth', $event)"
        />
        <template v-if="value.cadence === 'yearly'">
          <NSelect
            class="desktop-automation-schedule__date"
            :aria-label="t('desktop.automations.editor.month')"
            :options="monthOptions"
            :value="value.month"
            @update:value="update('month', $event)"
          />
          <NSelect
            class="desktop-automation-schedule__date"
            :aria-label="t('desktop.automations.editor.day')"
            :options="dayOptions"
            :value="value.day"
            @update:value="update('day', $event)"
          />
        </template>
      </template>

      <template v-else-if="value.frequencyMode === 'interval'">
        <div class="desktop-automation-schedule__interval flex items-center gap-[10px]">
          <span>{{ t('desktop.automations.editor.every') }}</span>
          <NInputNumber
            class="desktop-automation-schedule__number"
            :aria-label="t('desktop.automations.editor.every')"
            :max="value.intervalUnit === 'hour' ? 168 : 365"
            :min="1"
            :precision="value.intervalUnit === 'hour' ? 1 : 0"
            :step="value.intervalUnit === 'hour' ? 0.1 : 1"
            :value="value.every"
            @update:value="updateEvery"
          />
          <NSelect
            class="desktop-automation-schedule__unit"
            :options="intervalUnitOptions"
            :value="value.intervalUnit"
            @update:value="updateIntervalUnit"
          />
        </div>
      </template>

      <NDatePicker
        v-else
        class="desktop-automation-schedule__datetime"
        :aria-label="t('desktop.automations.editor.runAt')"
        :formatted-value="value.onceLocal"
        type="datetime"
        value-format="yyyy-MM-dd HH:mm"
        @update:formatted-value="update('onceLocal', $event)"
      />
    </div>

    <div
      v-if="value.frequencyMode === 'calendar' && value.cadence === 'weekly'"
      class="desktop-automation-schedule__weekdays flex items-center gap-[12px]"
    >
      <span>{{ t('desktop.automations.editor.weekdays') }}</span>
      <NCheckboxGroup
        :value="value.weekdays"
        @update:value="update('weekdays', $event)"
      >
        <NCheckbox
          v-for="weekday in weekdayOptions"
          :key="weekday.value"
          :label="weekday.label"
          :value="weekday.value"
        />
      </NCheckboxGroup>
    </div>

    <section v-if="value.frequencyMode !== 'once'" class="desktop-automation-schedule__active grid gap-[10px] border-t-1 border-t-solid border-t-border mt-[6px] pt-[18px]">
      <div class="desktop-automation-schedule__heading grid gap-[3px]">
        <h2>{{ t('desktop.automations.editor.activeRange') }}</h2>
        <p>{{ t('desktop.automations.editor.activeRangeHint') }}</p>
      </div>
      <NDatePicker
        class="desktop-automation-schedule__active-range"
        clearable
        :end-placeholder="t('desktop.automations.editor.activeUntil')"
        :formatted-value="activeRange"
        :start-placeholder="t('desktop.automations.editor.activeFrom')"
        type="daterange"
        value-format="yyyy-MM-dd"
        @update:formatted-value="updateActiveRange"
      />
    </section>
  </section>
</template>

<style scoped lang="scss">
.desktop-automation-schedule__heading {
  h2,
  p {
    margin: 0;
  }

  h2 {
    color: var(--buddy-text-strong);
    font-size: 14px;
    font-weight: 660;
  }

  p {
    color: var(--buddy-text-muted);
    font-size: 11px;
    line-height: 1.5;
  }
}

.desktop-automation-schedule__interval {
  > span {
    flex: none;
    color: var(--buddy-text-secondary);
    font-size: 13px;
  }
}

.desktop-automation-schedule__cadence {
  width: 150px;
}

.desktop-automation-schedule__time,
.desktop-automation-schedule__date {
  width: 150px;
}

.desktop-automation-schedule__number {
  width: 110px;
}

.desktop-automation-schedule__unit {
  width: 100px;
}

.desktop-automation-schedule__datetime {
  width: min(100%, 300px);
}

.desktop-automation-schedule__weekdays > span {
  flex: none;
  color: var(--buddy-text-secondary);
  font-size: 12px;
}

.desktop-automation-schedule__weekdays :deep(.n-checkbox-group) {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.desktop-automation-schedule__active-range {
  width: 100%;
}

@media (max-width: 760px) {
  .desktop-automation-schedule__cadence,
  .desktop-automation-schedule__time,
  .desktop-automation-schedule__date,
  .desktop-automation-schedule__datetime {
    width: 100%;
  }

  .desktop-automation-schedule__interval {
    width: 100%;
  }
}
</style>

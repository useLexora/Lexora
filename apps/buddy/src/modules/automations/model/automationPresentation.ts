import type { LocalAutomation, LocalAutomationOccurrencePage } from '@buddy-shared/automation/automationApi'

import type { BuddyLocale, BuddyTranslate } from '@/i18n/buddyI18n'
import { Temporal } from '@buddy-shared/automation/temporal'

type AutomationOccurrenceView = LocalAutomationOccurrencePage['items'][number]
export type AutomationHistoryStatusIcon = 'approval' | 'completed' | 'failed' | 'loading' | 'neutral'

export function formatAutomationInstant(
  value: string | null,
  locale: BuddyLocale,
  timezone?: string,
): string {
  if (!value)
    return '-'
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(value))
}

export function formatAutomationSchedule(
  automation: LocalAutomation,
  locale: BuddyLocale,
  t: BuddyTranslate,
): string {
  const schedule = automation.timing.schedule
  if (schedule.kind === 'once') {
    return t('desktop.automations.schedule.once', {
      time: formatAutomationInstant(schedule.runAt, locale, automation.timing.timezone),
    })
  }
  if (schedule.kind === 'interval') {
    return t(
      schedule.unit === 'hour'
        ? 'desktop.automations.schedule.intervalHour'
        : 'desktop.automations.schedule.intervalDay',
      { every: schedule.every },
    )
  }
  if (schedule.cadence === 'daily')
    return t('desktop.automations.schedule.daily', { time: schedule.localTime })
  if (schedule.cadence === 'weekly') {
    return t('desktop.automations.schedule.weekly', {
      days: formatWeekdays(schedule.weekdays, locale),
      time: schedule.localTime,
    })
  }
  if (schedule.cadence === 'monthly') {
    return schedule.dayOfMonth === 'last'
      ? t('desktop.automations.schedule.monthlyLast', { time: schedule.localTime })
      : t('desktop.automations.schedule.monthly', {
          day: schedule.dayOfMonth,
          time: schedule.localTime,
        })
  }
  return t('desktop.automations.schedule.yearly', {
    day: schedule.day,
    month: schedule.month,
    time: schedule.localTime,
  })
}

export function automationEffectiveStatusKey(
  occurrence: AutomationOccurrenceView,
) {
  if (occurrence.errorCode === 'AUTOMATION_ACTOR_UNAVAILABLE')
    return 'desktop.automations.effectiveStatus.actorUnavailable' as const
  return `desktop.automations.effectiveStatus.${occurrence.effectiveStatus}` as const
}

export function automationHistoryStatusIcon(
  status: AutomationOccurrenceView['effectiveStatus'],
): AutomationHistoryStatusIcon {
  if (status === 'queued' || status === 'running')
    return 'loading'
  if (status === 'awaiting_approval')
    return 'approval'
  if (status === 'completed')
    return 'completed'
  if (status === 'failed' || status === 'expired')
    return 'failed'
  return 'neutral'
}

export function automationBlockedDescriptionKey(automation: LocalAutomation) {
  return automation.blockedReason === 'AUTOMATION_SPACE_UNAVAILABLE'
    ? 'desktop.automations.blocked.space' as const
    : 'desktop.automations.blocked.model' as const
}

function formatWeekdays(weekdays: readonly number[], locale: BuddyLocale): string {
  const monday = Temporal.PlainDate.from('2026-08-24')
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
  })
  return weekdays.map((weekday) => {
    const date = monday.add({ days: weekday - 1 })
    return formatter.format(new Date(`${date.toString()}T12:00:00.000Z`))
  }).join(locale === 'zh-CN' ? '、' : ', ')
}

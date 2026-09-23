import type { BuddyLocale } from '@/i18n/buddyI18n'
import dayjs from 'dayjs'
import { ensureBuddyDayjs, toDayjsLocale } from '@/i18n/buddyI18n'

ensureBuddyDayjs()

export function formatTaskRelativeTime(
  occurredAt: string | number | Date,
  now: number | string | Date,
  language?: BuddyLocale,
): string {
  const target = dayjs(occurredAt)
  if (!target.isValid())
    return ''

  const scoped = language ? target.locale(toDayjsLocale(language)) : target
  return scoped.from(now)
}

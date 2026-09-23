import { describe, expect, it } from 'vitest'
import { syncBuddyDayjsLocale } from '@/i18n/buddyI18n'
import { formatTaskRelativeTime } from '../taskRelativeTime'

describe('formatTaskRelativeTime with dayjs customization', () => {
  const baseNow = new Date('2026-03-30T12:00:00.000Z').getTime()

  it('handles invalid time gracefully', () => {
    expect(formatTaskRelativeTime('invalid-date', baseNow, 'en-US')).toBe('')
    expect(formatTaskRelativeTime('invalid-date', baseNow, 'zh-CN')).toBe('')
  })

  it('formats recent events within 1 minute', () => {
    expect(formatTaskRelativeTime(baseNow - 10_000, baseNow, 'en-US')).toBe('now')
    expect(formatTaskRelativeTime(baseNow - 10_000, baseNow, 'zh-CN')).toBe('刚刚')
    // Clock skew / slight future
    expect(formatTaskRelativeTime(baseNow + 5_000, baseNow, 'en-US')).toBe('now')
    expect(formatTaskRelativeTime(baseNow + 5_000, baseNow, 'zh-CN')).toBe('刚刚')
  })

  it('formats minute-level intervals compactly using dayjs relativeTime', () => {
    const thirteenMinutesAgo = baseNow - 13 * 60 * 1000
    expect(formatTaskRelativeTime(thirteenMinutesAgo, baseNow, 'en-US')).toBe('13m')
    expect(formatTaskRelativeTime(thirteenMinutesAgo, baseNow, 'zh-CN')).toBe('13分钟前')
  })

  it('formats hour-level intervals compactly using dayjs relativeTime', () => {
    const twentyOneHoursAgo = baseNow - 21 * 3600 * 1000
    expect(formatTaskRelativeTime(twentyOneHoursAgo, baseNow, 'en-US')).toBe('21h')
    expect(formatTaskRelativeTime(twentyOneHoursAgo, baseNow, 'zh-CN')).toBe('21小时前')
  })

  it('formats day-level intervals compactly using dayjs relativeTime', () => {
    const sixDaysAgo = baseNow - 6 * 86400 * 1000
    expect(formatTaskRelativeTime(sixDaysAgo, baseNow, 'en-US')).toBe('6d')
    expect(formatTaskRelativeTime(sixDaysAgo, baseNow, 'zh-CN')).toBe('6天前')
  })

  it('formats month-level intervals compactly using dayjs relativeTime', () => {
    const fortyDaysAgo = baseNow - 40 * 86400 * 1000
    expect(formatTaskRelativeTime(fortyDaysAgo, baseNow, 'en-US')).toBe('1mo')
    expect(formatTaskRelativeTime(fortyDaysAgo, baseNow, 'zh-CN')).toBe('1个月前')
  })

  it('formats year-level intervals compactly using dayjs relativeTime', () => {
    const oneYearAgo = baseNow - 400 * 86400 * 1000
    expect(formatTaskRelativeTime(oneYearAgo, baseNow, 'en-US')).toBe('1y')
    expect(formatTaskRelativeTime(oneYearAgo, baseNow, 'zh-CN')).toBe('1年前')
  })

  it('uses dayjs ambient locale when language argument is omitted', () => {
    const thirteenMinutesAgo = baseNow - 13 * 60 * 1000
    syncBuddyDayjsLocale('en-US')
    expect(formatTaskRelativeTime(thirteenMinutesAgo, baseNow)).toBe('13m')

    syncBuddyDayjsLocale('zh-CN')
    expect(formatTaskRelativeTime(thirteenMinutesAgo, baseNow)).toBe('13分钟前')
  })
})

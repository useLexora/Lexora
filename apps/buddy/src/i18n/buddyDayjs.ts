import type { BuddyLocale } from './buddyMessages'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import updateLocale from 'dayjs/plugin/updateLocale'
import 'dayjs/locale/zh-cn'

let initialized = false

export function toDayjsLocale(locale: BuddyLocale): 'zh-cn' | 'en' {
  return locale === 'zh-CN' ? 'zh-cn' : 'en'
}

export function ensureBuddyDayjs() {
  if (initialized)
    return dayjs

  dayjs.extend(relativeTime, {
    thresholds: [
      { l: 's', r: 59, d: 'second' },
      { l: 'm', r: 1 },
      { l: 'mm', r: 59, d: 'minute' },
      { l: 'h', r: 1 },
      { l: 'hh', r: 23, d: 'hour' },
      { l: 'd', r: 1 },
      { l: 'dd', r: 29, d: 'day' },
      { l: 'M', r: 1 },
      { l: 'MM', r: 11, d: 'month' },
      { l: 'y', r: 1 },
      { l: 'yy', d: 'year' },
    ],
    rounding: Math.floor,
  })
  dayjs.extend(updateLocale)

  dayjs.updateLocale('en', {
    relativeTime: {
      future: (text: string) => text === 'now' ? text : `in ${text}`,
      past: '%s',
      s: 'now',
      m: '1m',
      mm: '%dm',
      h: '1h',
      hh: '%dh',
      d: '1d',
      dd: '%dd',
      M: '1mo',
      MM: '%dmo',
      y: '1y',
      yy: '%dy',
    },
  })

  dayjs.updateLocale('zh-cn', {
    relativeTime: {
      future: (text: string) => text === '刚刚' ? text : `${text}内`,
      past: (text: string) => text === '刚刚' ? text : `${text}前`,
      s: '刚刚',
      m: '1分钟',
      mm: '%d分钟',
      h: '1小时',
      hh: '%d小时',
      d: '1天',
      dd: '%d天',
      M: '1个月',
      MM: '%d个月',
      y: '1年',
      yy: '%d年',
    },
  })

  dayjs.locale('zh-cn')
  initialized = true
  return dayjs
}

export function syncBuddyDayjsLocale(locale: BuddyLocale) {
  ensureBuddyDayjs()
  dayjs.locale(toDayjsLocale(locale))
}

export { dayjs }

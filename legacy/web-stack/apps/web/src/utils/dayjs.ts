import type { ResolvedLanguagePreference } from '@haohaoxue/lexora-contracts'
import type { ConfigType } from 'dayjs'
import { LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { translate } from '@/i18n'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
setDayjsLocale(LANGUAGE_PREFERENCE.EN_US)

export function setDayjsLocale(locale: ResolvedLanguagePreference): void {
  dayjs.locale(locale === LANGUAGE_PREFERENCE.ZH_CN ? 'zh-cn' : 'en')
}

export function formatMonthDayWeekday(value: ConfigType = dayjs()) {
  return dayjs(value).format(translate('date.monthDayWeekday'))
}

export function formatMonthDayTime(value: ConfigType) {
  return dayjs(value).format('M/D HH:mm')
}

export function formatDateTime(value: ConfigType) {
  return dayjs(value).format('YYYY/M/D HH:mm:ss')
}

export default dayjs

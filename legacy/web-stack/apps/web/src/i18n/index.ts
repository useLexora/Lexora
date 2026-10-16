import type { ResolvedLanguagePreference } from '@haohaoxue/lexora-contracts'
import { LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import en from 'element-plus/es/locale/lang/en'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { createI18n } from 'vue-i18n'
import { enUS } from './locales/en-US'
import { zhCN } from './locales/zh-CN'

export const DEFAULT_APP_LOCALE = LANGUAGE_PREFERENCE.EN_US

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_APP_LOCALE,
  fallbackLocale: DEFAULT_APP_LOCALE,
  messages: {
    [LANGUAGE_PREFERENCE.EN_US]: enUS,
    [LANGUAGE_PREFERENCE.ZH_CN]: zhCN,
  },
})

export function setI18nLocale(locale: ResolvedLanguagePreference): void {
  i18n.global.locale.value = locale
}

type TranslateParams = Record<string, unknown>

export function translate(key: string, fallback?: string): string
export function translate(key: string, params: TranslateParams, fallback?: string): string
export function translate(key: string, paramsOrFallback?: TranslateParams | string, fallback?: string): string {
  const params = typeof paramsOrFallback === 'string' ? undefined : paramsOrFallback
  const resolvedFallback = typeof paramsOrFallback === 'string' ? paramsOrFallback : fallback
  const message = params ? i18n.global.t(key, params) : i18n.global.t(key)

  return message === key ? resolvedFallback ?? key : message
}

export function resolveElementPlusLocale(locale: ResolvedLanguagePreference) {
  return locale === LANGUAGE_PREFERENCE.ZH_CN ? zhCn : en
}

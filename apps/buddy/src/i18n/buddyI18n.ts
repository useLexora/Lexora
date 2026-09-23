import type { MaybeRefOrGetter } from 'vue'
import type { BuddyTranslate } from './buddyMessages'
import { computed, toValue } from 'vue'
import { resolveBuddyLocale, translateBuddy } from './buddyMessages'

export { ensureBuddyDayjs, syncBuddyDayjsLocale, toDayjsLocale } from './buddyDayjs'
export type { BuddyI18nKey, BuddyLocale, BuddyTranslate } from './buddyMessages'
export { BUDDY_LOCALES, resolveBuddyLocale, translateBuddy } from './buddyMessages'

export function useBuddyI18n(language: MaybeRefOrGetter<string>) {
  const locale = computed(() => resolveBuddyLocale(toValue(language)))
  const languageOptions = computed(() => [
    {
      label: '中文',
      value: 'zh-CN',
    },
    {
      label: 'English',
      value: 'en-US',
    },
  ])
  const t: BuddyTranslate = (key, params) => translateBuddy(locale.value, key, params)

  return {
    languageOptions,
    locale,
    t,
  }
}

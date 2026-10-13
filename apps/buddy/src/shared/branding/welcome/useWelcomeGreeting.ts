import type { MaybeRefOrGetter } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { createSharedComposable, useIntervalFn, useNow } from '@vueuse/core'
import { computed, toValue } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { formatTimeGreeting, resolveTimeGreetingKey } from './timeGreeting'

const useWelcomeClock = createSharedComposable(() => useNow({ scheduler: update => useIntervalFn(update, 60_000) }))

export function useWelcomeGreeting(language: MaybeRefOrGetter<BuddyLocale>, enabled: MaybeRefOrGetter<boolean>) {
  const { userName } = useDesktopUi()
  const now = useWelcomeClock()
  return computed(() => {
    if (!toValue(enabled))
      return ''
    const locale = toValue(language)
    return formatTimeGreeting(translateBuddy(locale, resolveTimeGreetingKey(now.value.getHours())), userName.value, locale)
  })
}

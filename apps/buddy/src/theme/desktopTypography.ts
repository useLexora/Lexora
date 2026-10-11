import type { TypographyPreferences } from '@buddy-shared/typography/typographyPreferences'
import { DEFAULT_TYPOGRAPHY, resolveTypography } from '@buddy-shared/typography/typographyPreferences'
import { shallowReadonly, shallowRef, watch } from 'vue'

const current = shallowRef(resolveTypography(DEFAULT_TYPOGRAPHY))
export const desktopTypography = shallowReadonly(current)

export function applyDesktopTypography(preferences: Readonly<TypographyPreferences> = DEFAULT_TYPOGRAPHY) {
  const next = resolveTypography(preferences)
  current.value = next
  const variables = {
    '--buddy-font-ui': next.ui,
    '--buddy-font-body': next.body,
    '--buddy-font-mono': next.mono,
    '--buddy-chat-final-font-size': next.bodySize,
    '--buddy-chat-final-heading-font-size': next.bodySize,
    '--buddy-chat-final-line-height': next.bodyLineHeight,
    '--buddy-chat-user-font-size': next.bodySize,
  }
  for (const [name, value] of Object.entries(variables))
    document.documentElement.style.setProperty(name, value)
}

export function useDesktopTypography(preferences: () => Readonly<TypographyPreferences> | undefined) {
  watch(preferences, value => applyDesktopTypography(value), { immediate: true })
}

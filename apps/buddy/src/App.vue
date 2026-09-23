<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { usePreferredDark } from '@vueuse/core'
import {
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  zhCN,
} from 'naive-ui'
import { computed, shallowRef, watch, watchEffect } from 'vue'
import DesktopAppProvider from '@/app/bootstrap/DesktopAppProvider.vue'
import DesktopShell from '@/app/shell/DesktopShell.vue'
import { syncBuddyDayjsLocale } from '@/i18n/buddyI18n'
import {
  buddyColorThemes,
  createBuddyColorVariables,
  createBuddyNaiveThemeOverrides,
} from '@/theme/buddyTheme'

type DesktopThemePreference = 'system' | 'light' | 'dark'

const systemPrefersDark = usePreferredDark()
const themePreference = shallowRef<DesktopThemePreference>('system')
const language = shallowRef<BuddyLocale>('zh-CN')
const prefersDark = computed(() =>
  themePreference.value === 'dark'
  || (themePreference.value === 'system' && systemPrefersDark.value),
)
const colorTheme = computed(() => buddyColorThemes[prefersDark.value ? 'dark' : 'light'])
const themeOverrides = computed(() => createBuddyNaiveThemeOverrides(colorTheme.value))
const naiveLocale = computed(() => language.value === 'en-US' ? enUS : zhCN)
const naiveDateLocale = computed(() => language.value === 'en-US' ? dateEnUS : dateZhCN)

watch(language, syncBuddyDayjsLocale, { immediate: true })

watchEffect(() => {
  if (typeof document === 'undefined')
    return

  const root = document.documentElement
  root.dataset.buddyTheme = colorTheme.value.colorScheme

  for (const [name, value] of Object.entries(createBuddyColorVariables(colorTheme.value)))
    root.style.setProperty(name, value)
})
</script>

<template>
  <NConfigProvider
    :date-locale="naiveDateLocale"
    :locale="naiveLocale"
    :theme="prefersDark ? darkTheme : null"
    :theme-overrides="themeOverrides"
  >
    <NMessageProvider placement="top" closable :duration="6000">
      <NDialogProvider>
        <div class="buddy-app" :class="{ 'is-dark': prefersDark }">
          <DesktopAppProvider
            v-slot="{ shell }"
            :is-dark="prefersDark"
            @language-change="language = $event"
            @theme-change="themePreference = $event"
          >
            <DesktopShell :bindings="shell" />
          </DesktopAppProvider>
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

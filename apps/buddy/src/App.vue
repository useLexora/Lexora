<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
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
import { computed, shallowRef, watch } from 'vue'
import DesktopAppProvider from '@/app/bootstrap/DesktopAppProvider.vue'
import DesktopShell from '@/app/shell/DesktopShell.vue'
import { syncBuddyDayjsLocale } from '@/i18n/buddyI18n'
import { useProvideDesktopTheme } from '@/theme/useDesktopTheme'

const language = shallowRef<BuddyLocale>('zh-CN')
const { isDark: prefersDark, overrides: themeOverrides } = useProvideDesktopTheme()
const naiveLocale = computed(() => language.value === 'en-US' ? enUS : zhCN)
const naiveDateLocale = computed(() => language.value === 'en-US' ? dateEnUS : dateZhCN)

watch(language, syncBuddyDayjsLocale, { immediate: true })
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
            @language-change="language = $event"
          >
            <DesktopShell :bindings="shell" />
          </DesktopAppProvider>
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

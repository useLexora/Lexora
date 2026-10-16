<script setup lang="ts">
import { darkTheme, dateEnUS, dateZhCN, enUS, NConfigProvider, zhCN } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'
import { useTheme } from '@/composables/use-theme'

const { locale } = useI18n()
const { dark } = useTheme()
const themeOverrides = computed(() => ({ common: { primaryColor: dark.value ? '#83cbdb' : '#23627b', primaryColorHover: dark.value ? '#a9deea' : '#307e97', primaryColorPressed: '#20546a', borderRadius: '8px', fontFamily: 'inherit' } }))
</script>

<template>
  <NConfigProvider :theme="dark ? darkTheme : null" :theme-overrides="themeOverrides" :locale="locale === 'zh-CN' ? zhCN : enUS" :date-locale="locale === 'zh-CN' ? dateZhCN : dateEnUS">
    <RouterView />
  </NConfigProvider>
</template>

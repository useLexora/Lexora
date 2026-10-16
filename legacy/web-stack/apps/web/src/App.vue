<script setup lang="ts">
import { computed } from 'vue'
import { RouterView } from 'vue-router'
import { useAppSaveShortcut } from '@/composables/useAppSaveCommand'
import { resolveElementPlusLocale } from '@/i18n'
import { useUserStore } from '@/stores/user'

useAppSaveShortcut()

const userStore = useUserStore()
const elementPlusLocale = computed(() => resolveElementPlusLocale(userStore.resolvedLanguage))
</script>

<template>
  <ElConfigProvider :locale="elementPlusLocale">
    <RouterView />
  </ElConfigProvider>
</template>

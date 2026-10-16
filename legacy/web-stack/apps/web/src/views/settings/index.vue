<script setup lang="ts">
import { RouterView } from 'vue-router'
import PagePanel from '@/layouts/panels/page-panel'
import { useSettingsRouteTabs } from './composables/useSettingsRouteTabs'
import SettingsContextBarLayout from './layouts/context-bar'

const { activeTab } = useSettingsRouteTabs()
</script>

<template>
  <PagePanel>
    <template #header>
      <SettingsContextBarLayout v-model="activeTab" />
    </template>

    <RouterView />
  </PagePanel>
</template>

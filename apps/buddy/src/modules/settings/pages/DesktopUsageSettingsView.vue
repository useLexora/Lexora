<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import { useUsageAnalytics } from '../state/useUsageAnalytics'
import DesktopUsageDashboard from '../widgets/usage/DesktopUsageDashboard.vue'

const { applicationSettings, dataSettings, providerSettings, ready, openTask } = useSettingsContext()
const { language } = applicationSettings
const { providers, registeredModels } = providerSettings
const { t } = useBuddyI18n(language)
const analytics = useUsageAnalytics({ api: requireDesktopApi().localChat.usage, language, runtime: dataSettings.runtimeState, ready })
const { loading, refresh } = analytics
</script>

<template>
  <DesktopSettingsModuleLayout :loading="loading">
    <template #actions>
      <NButton size="small" secondary :loading="loading" @click="refresh">
        {{ t('usageAnalytics.refresh') }}
      </NButton>
    </template>
    <DesktopUsageDashboard :analytics="analytics" :language="language" :providers="providers" :catalog="registeredModels" @open-task="openTask" />
  </DesktopSettingsModuleLayout>
</template>

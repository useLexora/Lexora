<script setup lang="ts">
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopApplicationLogs from '../widgets/application-logs/DesktopApplicationLogs.vue'

const { applicationSettings } = useSettingsContext()
const { language } = applicationSettings
const api = requireDesktopApi().app.logs
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopApplicationLogs :api="api" :language="language" />
  </DesktopSettingsModuleLayout>
</template>

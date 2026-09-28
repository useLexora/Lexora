<script setup lang="ts">
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopNotificationsSettings from '../widgets/app/DesktopNotificationsSettings.vue'

const { applicationSettings } = useSettingsContext()
const { config, settingsError, language, updateSettings } = applicationSettings
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopNotificationsSettings :config="config" :error="settingsError" :language="language" :update-settings="updateSettings" />
  </DesktopSettingsModuleLayout>
</template>

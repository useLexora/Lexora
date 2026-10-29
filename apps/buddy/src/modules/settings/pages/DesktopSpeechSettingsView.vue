<script setup lang="ts">
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopSpeechSettings from '../widgets/app/DesktopSpeechSettings.vue'

const { applicationSettings } = useSettingsContext()
const { config, settingsError, language, updateSettings } = applicationSettings
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopSpeechSettings :config="config" :error="settingsError" :language="language" :update-settings="updateSettings" />
  </DesktopSettingsModuleLayout>
</template>

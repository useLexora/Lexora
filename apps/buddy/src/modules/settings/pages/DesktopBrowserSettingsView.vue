<script setup lang="ts">
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopBrowserSettings from '../widgets/browser/DesktopBrowserSettings.vue'

const { applicationSettings, browser } = useSettingsContext()
const { config, language, settingsError, updateSettings } = applicationSettings
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopBrowserSettings :config="config" :language="language" :error="settingsError" :update-settings="updateSettings" :browser="browser" />
  </DesktopSettingsModuleLayout>
</template>

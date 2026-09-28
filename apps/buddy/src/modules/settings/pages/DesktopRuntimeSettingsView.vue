<script setup lang="ts">
import DesktopSettingsModuleLayout from '@/modules/settings/layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import DesktopRuntimeSettings from '@/modules/settings/widgets/runtime/DesktopRuntimeSettings.vue'

const { applicationSettings } = useSettingsContext()
const { config, settingsError, language, updateSettings } = applicationSettings
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopRuntimeSettings
      :config="config"
      :error="settingsError"
      :language="language"
      :update-settings="updateSettings"
    />
  </DesktopSettingsModuleLayout>
</template>

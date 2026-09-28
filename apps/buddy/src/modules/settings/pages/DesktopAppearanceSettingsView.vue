<script setup lang="ts">
import DesktopSettingsModuleLayout from '@/modules/settings/layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import DesktopAppearanceSettings from '@/modules/settings/widgets/app/DesktopAppearanceSettings.vue'

const { applicationSettings } = useSettingsContext()
const { config, settingsError, language, updateSettings } = applicationSettings
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopAppearanceSettings
      :config="config"
      :error="settingsError"
      :language="language"
      :update-settings="updateSettings"
    />
  </DesktopSettingsModuleLayout>
</template>

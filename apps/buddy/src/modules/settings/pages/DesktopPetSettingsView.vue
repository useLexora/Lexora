<script setup lang="ts">
import DesktopSettingsModuleLayout from '@/modules/settings/layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import DesktopPetSettings from '@/modules/settings/widgets/pet/DesktopPetSettings.vue'

const { applicationSettings } = useSettingsContext()
const { config, settingsError, language, updateSettings } = applicationSettings
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopPetSettings :config="config" :error="settingsError" :language="language" :update-settings="updateSettings" />
  </DesktopSettingsModuleLayout>
</template>

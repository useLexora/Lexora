<script setup lang="ts">
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopFileOpeningSettings from '../widgets/file-opening/DesktopFileOpeningSettings.vue'

const { applicationSettings: { language } } = useSettingsContext()
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopFileOpeningSettings :language="language" />
  </DesktopSettingsModuleLayout>
</template>

<script setup lang="ts">
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopMcpManager from '../widgets/mcp/DesktopMcpManager.vue'

const { applicationSettings, mcpSettings, ready } = useSettingsContext()
</script>

<template>
  <DesktopSettingsModuleLayout :loading="!mcpSettings.loaded.value">
    <DesktopMcpManager :mcp="mcpSettings" :ready="ready" :codemode-enabled="applicationSettings.config.value?.runtime.codemode ?? false" />
  </DesktopSettingsModuleLayout>
</template>

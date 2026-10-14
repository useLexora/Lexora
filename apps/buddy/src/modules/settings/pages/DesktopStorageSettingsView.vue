<script setup lang="ts">
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import DesktopBackupSection from '../widgets/data/DesktopBackupSection.vue'
import DesktopStorageSettings from '../widgets/data/DesktopStorageSettings.vue'
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopStorageSettings />
    <DesktopBackupSection />
  </DesktopSettingsModuleLayout>
</template>

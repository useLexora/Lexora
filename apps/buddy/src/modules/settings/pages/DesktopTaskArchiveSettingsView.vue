<script setup lang="ts">
import { DesktopTaskArchiveManager } from '@/modules/tasks/ui'
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'

const { applicationSettings: { language }, taskArchive, taskArchiveSpaces, openTask } = useSettingsContext()
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopTaskArchiveManager :actions="taskArchive" :spaces="taskArchiveSpaces" :language="language" @view="openTask" />
  </DesktopSettingsModuleLayout>
</template>

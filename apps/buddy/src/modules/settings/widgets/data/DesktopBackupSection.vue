<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsContext } from '../../settingsContext'
import DesktopSyncSettings from '../sync/DesktopSyncSettings.vue'
import DesktopBackupSettings from './DesktopBackupSettings.vue'

const { applicationSettings } = useSettingsContext()
const english = computed(() => applicationSettings.language.value === 'en-US')
</script>

<template>
  <section class="grid gap-5 min-w-0">
    <h2 class="m-0 text-[0.92rem] font-600">
      {{ english ? 'Backup' : '备份' }}
    </h2>
    <DesktopBackupSettings />
    <DesktopSyncSettings />
  </section>
</template>

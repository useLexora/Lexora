<script setup lang="ts">
import { useRouter } from 'vue-router'
import { DesktopModelsSettings } from '@/modules/models/ui'
import DesktopSettingsModuleLayout from '@/modules/settings/layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

const router = useRouter()
const { providerSettings } = useSettingsContext()
</script>

<template>
  <DesktopSettingsModuleLayout :loading="providerSettings.isLoadingModelCatalog.value">
    <DesktopModelsSettings
      :provider-settings="providerSettings"
      @manage-provider="router.push(desktopRouteLocations.provider($event))"
    />
  </DesktopSettingsModuleLayout>
</template>

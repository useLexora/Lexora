<script setup lang="ts">
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSettingsPageLayout from '@/modules/settings/layouts/DesktopSettingsPageLayout.vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import DesktopRuntimeSettings from '@/modules/settings/widgets/runtime/DesktopRuntimeSettings.vue'

const { applicationSettings } = useSettingsContext()
const { t } = useBuddyI18n(applicationSettings.language)
const { config, settingsError, language, updateSettings } = applicationSettings
</script>

<template>
  <DesktopSettingsPageLayout :requires-runtime="false">
    <template #title>
      {{ t('desktop.settings.category.runtime') }}
    </template>
    <template #description>
      {{ t('desktop.settings.categoryDescription.runtime') }}
    </template>
    <DesktopRuntimeSettings
      :config="config"
      :error="settingsError"
      :language="language"
      :update-settings="updateSettings"
    />
  </DesktopSettingsPageLayout>
</template>

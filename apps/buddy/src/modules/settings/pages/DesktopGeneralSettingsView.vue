<script setup lang="ts">
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSettingsPageLayout from '@/modules/settings/layouts/DesktopSettingsPageLayout.vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import DesktopGeneralSettings from '@/modules/settings/widgets/app/DesktopGeneralSettings.vue'

const { applicationSettings } = useSettingsContext()
const { t } = useBuddyI18n(applicationSettings.language)
const { config, settingsError, language, updateSettings } = applicationSettings
</script>

<template>
  <DesktopSettingsPageLayout :requires-runtime="false">
    <template #title>
      {{ t('desktop.settings.category.general') }}
    </template>
    <template #description>
      {{ t('desktop.settings.categoryDescription.general') }}
    </template>
    <DesktopGeneralSettings
      :config="config"
      :error="settingsError"
      :language="language"
      :update-settings="updateSettings"
    />
  </DesktopSettingsPageLayout>
</template>

<script setup lang="ts">
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSettingsPageLayout from '../layouts/DesktopSettingsPageLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopProxySettings from '../widgets/app/DesktopProxySettings.vue'

const { applicationSettings } = useSettingsContext()
const { config, settingsError, language, updateSettings } = applicationSettings
const { t } = useBuddyI18n(language)
</script>

<template>
  <DesktopSettingsPageLayout :requires-runtime="false">
    <template #title>
      {{ t('desktop.settings.category.proxy') }}
    </template>
    <template #description>
      {{ t('desktop.settings.categoryDescription.proxy') }}
    </template>
    <DesktopProxySettings :config="config" :error="settingsError" :language="language" :update-settings="updateSettings" />
  </DesktopSettingsPageLayout>
</template>

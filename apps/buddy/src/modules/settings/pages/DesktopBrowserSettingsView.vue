<script setup lang="ts">
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSettingsPageLayout from '../layouts/DesktopSettingsPageLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopBrowserSettings from '../widgets/browser/DesktopBrowserSettings.vue'

const { applicationSettings, browser } = useSettingsContext()
const { config, language, settingsError, updateSettings } = applicationSettings
const { t } = useBuddyI18n(language)
</script>

<template>
  <DesktopSettingsPageLayout :requires-runtime="false">
    <template #title>
      {{ t('desktop.settings.category.browser') }}
    </template>
    <template #description>
      {{ t('desktop.settings.categoryDescription.browser') }}
    </template>
    <DesktopBrowserSettings :config="config" :language="language" :error="settingsError" :update-settings="updateSettings" :browser="browser" />
  </DesktopSettingsPageLayout>
</template>

<script setup lang="ts">
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopAboutSettings from '../widgets/app/DesktopAboutSettings.vue'
import DesktopApplicationToggle from '../widgets/app/DesktopApplicationToggle.vue'
import DesktopUpdateSettings from '../widgets/app/DesktopUpdateSettings.vue'

const { applicationSettings, appInfo } = useSettingsContext()
const { config, settingsError, language, updateSettings } = applicationSettings
const { t } = useBuddyI18n(language)
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopAboutSettings :app-info="appInfo" :language="language" />
    <DesktopUpdateSettings
      :config="config"
      :error="settingsError"
      :language="language"
      :update-settings="updateSettings"
      :capabilities="appInfo?.updateCapabilities"
    />
    <div class="desktop-about-preferences grid gap-[0.8rem]">
      <DesktopApplicationToggle
        field="launchAtLogin"
        :label="t('settings.autostart')"
        :description="t('desktop.settings.autostartDescription')"
        :config="config"
        :error="settingsError"
        :language="language"
        :update-settings="updateSettings"
      />
      <DesktopApplicationToggle
        field="developerToolsEnabled"
        :label="t('desktop.settings.developerTools')"
        :description="t('desktop.settings.developerToolsDescription')"
        :config="config"
        :error="settingsError"
        :language="language"
        :update-settings="updateSettings"
      />
    </div>
  </DesktopSettingsModuleLayout>
</template>

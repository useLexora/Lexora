<script setup lang="ts">
import DesktopSettingsModuleLayout from '@/modules/settings/layouts/DesktopSettingsModuleLayout.vue'
import { computed } from 'vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import { resolveUserProfile } from '@/modules/settings/widgets/account/userProfile'
import DesktopAgentIdentitySettings from '@/modules/settings/widgets/app/DesktopAgentIdentitySettings.vue'
import DesktopAppearanceSettings from '@/modules/settings/widgets/app/DesktopAppearanceSettings.vue'

const { agentProfile, appInfo, applicationSettings, profile } = useSettingsContext()
const { config, settingsError, language, updateSettings } = applicationSettings
const agentProfileConfig = computed(() => agentProfile.config.value)
const syncedProfile = computed(() => resolveUserProfile(profile.config.value, appInfo.value))
</script>

<template>
  <DesktopSettingsModuleLayout>
    <DesktopAppearanceSettings
      :config="config"
      :error="settingsError"
      :language="language"
      :update-settings="updateSettings"
    />
    <DesktopAgentIdentitySettings
      :language="language"
      :profile="agentProfileConfig"
      :synced-profile="syncedProfile"
      :update-profile="agentProfile.update"
    />
  </DesktopSettingsModuleLayout>
</template>

<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopAboutSettings from '../widgets/app/DesktopAboutSettings.vue'
import DesktopApplicationToggle from '../widgets/app/DesktopApplicationToggle.vue'
import DesktopUpdateSettings from '../widgets/app/DesktopUpdateSettings.vue'
import DesktopSettingRow from '../widgets/shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../widgets/shared/DesktopSettingsGroup.vue'

const { applicationSettings, appInfo, openOnboarding, featureDiscovery } = useSettingsContext()
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
    <section class="desktop-onboarding-settings grid gap-[0.8rem]">
      <h3 class="m-0 text-fg text-[0.85rem] font-600">
        {{ t('onboarding.settings') }}
      </h3>
      <DesktopSettingsGroup class="[container-type:inline-size] [--setting-row-py:0.9rem] [--setting-control-min:0px] [--setting-control-max:max-content]">
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('onboarding.reopen')" :description="t('onboarding.reopenDescription')" toggle>
          <NButton :aria-describedby="controlAttrs['aria-describedby']" size="small" @click="openOnboarding">
            {{ t('onboarding.open') }}
          </NButton>
        </DesktopSettingRow>
        <DesktopApplicationToggle
          field="featureAnnouncementsEnabled"
          :label="t('discovery.announcements')"
          :description="t('discovery.announcementsDescription')"
          :config="config"
          :error="settingsError"
          :language="language"
          :update-settings="updateSettings"
        />
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('discovery.title')" :description="t('discovery.aboutDescription')" toggle>
          <div class="flex items-center gap-3">
            <span v-if="featureDiscovery.unreadCount.value" class="text-[12px] text-accent-text">{{ t('discovery.unread', { count: featureDiscovery.unreadCount.value }) }}</span>
            <NButton :aria-describedby="controlAttrs['aria-describedby']" size="small" @click="featureDiscovery.open">
              {{ t('discovery.viewList') }}
            </NButton>
          </div>
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <DesktopSettingsGroup class="desktop-about-preferences [container-type:inline-size] [--setting-row-py:0.9rem] [--setting-control-min:0px] [--setting-control-max:max-content]">
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
    </DesktopSettingsGroup>
  </DesktopSettingsModuleLayout>
</template>

<script setup lang="ts">
import { NAlert, NButton } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import { usePromptCatalog } from '../state/usePromptCatalog'
import DesktopPromptSettings from '../widgets/prompts/DesktopPromptSettings.vue'

const { prompts, ready, applicationSettings: { language }, writeClipboardText } = useSettingsContext()
const { catalog, loading, error, load } = usePromptCatalog(prompts, ready, language)
const { t } = useBuddyI18n(language)
</script>

<template>
  <DesktopSettingsModuleLayout :loading="loading">
    <NAlert v-if="error" type="error" :show-icon="false">
      {{ error }}
      <NButton text @click="load">
        {{ t('desktop.agent.retry') }}
      </NButton>
    </NAlert>
    <DesktopPromptSettings
      v-if="catalog"
      :catalog="catalog"
      :language="language"
      :write-clipboard-text="writeClipboardText"
    />
  </DesktopSettingsModuleLayout>
</template>

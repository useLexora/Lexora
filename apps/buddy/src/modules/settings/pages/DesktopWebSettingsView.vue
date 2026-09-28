<script setup lang="ts">
import { onMounted } from 'vue'
import DesktopSettingsModuleLayout from '@/modules/settings/layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import DesktopWebSettings from '@/modules/settings/widgets/web/DesktopWebSettings.vue'

const { webSettings, ready } = useSettingsContext()
onMounted(() => {
  void ready.then(() => webSettings.load())
})
const { busy, error, language, snapshot, searchSources, load, setSearchEnabled, reorderSearch, setFetchEnabled, saveCredential, revealCredential } = webSettings
</script>

<template>
  <DesktopSettingsModuleLayout :loading="busy && !snapshot">
    <DesktopWebSettings
      :busy="busy"
      :error="error"
      :language="language"
      :snapshot="snapshot"
      :search-sources="searchSources"
      :load="load"
      :set-search-enabled="setSearchEnabled"
      :reorder-search="reorderSearch"
      :set-fetch-enabled="setFetchEnabled"
      :save-credential="saveCredential"
      :reveal-credential="revealCredential"
    />
  </DesktopSettingsModuleLayout>
</template>

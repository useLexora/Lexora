<script setup lang="ts">
import { computed } from 'vue'
import { supportsSettingsCategory } from '@/platform/desktop/desktopCapabilities'
import DesktopSettingsPageLayout from '../layouts/DesktopSettingsPageLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopSettingsModuleContent from './DesktopSettingsModuleContent.vue'

const props = defineProps<{ moduleId: string }>()
const { registry, platformCapabilities, applicationSettings } = useSettingsContext()
const module = computed(() => registry.modules.value.find(module => module.id === props.moduleId && (!module.category || supportsSettingsCategory(platformCapabilities.value, module.category))))
const english = computed(() => applicationSettings.language.value === 'en-US')
</script>

<template>
  <DesktopSettingsModuleContent v-if="module" :key="module.id" :module="module" />
  <DesktopSettingsPageLayout v-else :requires-runtime="false">
    <template #title>
      {{ english ? 'Settings' : '设置' }}
    </template>
    <p role="status">
      {{ english ? 'These settings are unavailable. Check that the plugin is installed and enabled.' : '此设置模块暂不可用，请检查插件是否已安装并启用。' }}
    </p>
  </DesktopSettingsPageLayout>
</template>

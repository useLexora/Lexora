<script setup lang="ts">
import { settingsText } from '../model/settingsRegistry'
import { useSettingsContext } from '../settingsContext'
import { useSettingsModule } from '../state/settingsModuleContext'
import DesktopPluginSettingsStatus from '../widgets/plugins/DesktopPluginSettingsStatus.vue'
import DesktopSettingsGroups from '../widgets/registry/DesktopSettingsGroups.vue'
import DesktopSettingsPageLayout from './DesktopSettingsPageLayout.vue'

defineProps<{ loading?: boolean }>()
defineSlots<{ default?: () => unknown, actions?: () => unknown }>()
const module = useSettingsModule()
const { applicationSettings: { language } } = useSettingsContext()
</script>

<template>
  <DesktopSettingsPageLayout :requires-runtime="module.requiresRuntime" :fill="module.fill" :loading="loading">
    <template #title>
      {{ settingsText(module.title, language) }}
    </template>
    <template v-if="module.description" #description>
      {{ settingsText(module.description, language) }}
    </template>
    <template v-if="$slots.actions" #actions>
      <slot name="actions" />
    </template>
    <DesktopSettingsGroups :groups="module.groups" :fill="module.fill">
      <template #status>
        <DesktopPluginSettingsStatus :groups="module.groups" />
      </template>
      <slot />
    </DesktopSettingsGroups>
  </DesktopSettingsPageLayout>
</template>

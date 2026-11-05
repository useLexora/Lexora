<script setup lang="ts">
import type { ExtensionSettingsHeaderAction } from '@buddy-shared/extensions/extensionSettingsHeaderActions'
import { shallowRef, useTemplateRef } from 'vue'
import { DesktopExtensionEmbeddedView, DesktopExtensionSettingsHeaderActions } from '@/modules/extensions/ui'
import DesktopSettingsPageLayout from '../layouts/DesktopSettingsPageLayout.vue'
import { settingsText } from '../model/settingsRegistry'
import { useSettingsContext } from '../settingsContext'
import { useSettingsModule } from '../state/settingsModuleContext'

const view = useTemplateRef<InstanceType<typeof DesktopExtensionEmbeddedView>>('view')
const actions = shallowRef<readonly ExtensionSettingsHeaderAction[]>([])
const module = useSettingsModule()
const { applicationSettings: { language } } = useSettingsContext()
</script>

<template>
  <DesktopSettingsPageLayout :requires-runtime="false" fill>
    <template #title>
      {{ settingsText(module.title, language) }}
    </template>
    <template v-if="actions.length" #actions>
      <DesktopExtensionSettingsHeaderActions :actions="actions" @activate="view?.activateSettingsHeaderAction($event)" />
    </template>
    <DesktopExtensionEmbeddedView v-if="module.view" ref="view" :extension-id="module.owner" :view-type="module.view" settings-header-actions @settings-header-actions="actions = $event" />
  </DesktopSettingsPageLayout>
</template>

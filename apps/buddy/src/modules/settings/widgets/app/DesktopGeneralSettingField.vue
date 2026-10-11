<script setup lang="ts">
import type { LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import type { GeneralSettingField } from '../../model/settingsRegistry'
import { NSelect, NSpin, NSwitch, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingsContext } from '../../settingsContext'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'

const props = defineProps<{ field: GeneralSettingField }>()
const { applicationSettings: { config, language, updateSettings } } = useSettingsContext()
const { languageOptions, t } = useBuddyI18n(language)
const message = useMessage()
const { pending: pendingFields, save: saveSetting } = useSettingMutation<GeneralSettingField>(updateSettings, () => message.error(t('desktop.settings.saveFailed')))
const pending = computed(() => pendingFields.value.has(props.field))
const contextPanelModes = computed(() => [
  { label: t('desktop.settings.contextPanelTask'), value: 'task' },
  { label: t('desktop.settings.contextPanelSpace'), value: 'space' },
  { label: t('desktop.settings.contextPanelIndependent'), value: 'independent' },
])
const labels = computed(() => ({
  language: { title: t('settings.language'), description: '', testId: undefined },
  contextPanelMode: { title: t('desktop.settings.contextPanelMode'), description: t('desktop.settings.contextPanelModeDescription'), testId: 'context-panel-mode-setting' },
  contextPanelGlobal: { title: t('desktop.settings.contextPanelGlobal'), description: t('desktop.settings.contextPanelGlobalDescription'), testId: 'context-panel-global-setting' },
  pasteTextAsAttachment: { title: t('desktop.settings.pasteTextAsAttachment'), description: t('desktop.settings.pasteTextAsAttachmentDescription'), testId: 'paste-text-as-attachment-setting' },
}))
const isToggle = computed(() => props.field === 'contextPanelGlobal' || props.field === 'pasteTextAsAttachment')
function save(patch: LexoraConfigPatch) {
  return saveSetting(props.field, patch)
}
</script>

<template>
  <DesktopSettingRow v-if="config" v-slot="{ controlAttrs }" :label="labels[field].title" :description="labels[field].description" :toggle="isToggle" :data-testid="labels[field].testId">
    <NSelect v-if="field === 'language'" v-bind="controlAttrs" :options="languageOptions" :value="config.desktop.language" :disabled="pending" @update:value="save({ desktop: { language: $event } })" />
    <NSelect v-else-if="field === 'contextPanelMode'" v-bind="controlAttrs" :options="contextPanelModes" :value="config.desktop.contextPanelMode" :disabled="pending" @update:value="save({ desktop: { contextPanelMode: $event } })" />
    <NSwitch v-else-if="field === 'contextPanelGlobal'" v-bind="controlAttrs" :aria-disabled="pending" :round="false" :value="config.desktop.contextPanelGlobal" :loading="pending" :disabled="pending" @update:value="save({ desktop: { contextPanelGlobal: $event } })" />
    <NSwitch v-else v-bind="controlAttrs" :round="false" :value="config.desktop.chat.pasteTextAsAttachment" :loading="pending" :disabled="pending" :aria-disabled="pending" @update:value="save({ desktop: { chat: { pasteTextAsAttachment: $event } } })" />
    <NSpin v-if="pending && !isToggle" size="small" />
  </DesktopSettingRow>
</template>

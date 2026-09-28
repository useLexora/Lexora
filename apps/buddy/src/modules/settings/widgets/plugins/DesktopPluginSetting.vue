<script setup lang="ts">
import type { ExtensionSettingValue } from '@buddy-shared/extensions/extensionSettings'
import type { PluginSettingField } from '../../model/settingsRegistry'
import { useMessage } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingsContext } from '../../settingsContext'
import DesktopPluginSettingField from './DesktopPluginSettingField.vue'

const props = defineProps<{ field: PluginSettingField }>()
const { pluginSettings, providerSettings, applicationSettings } = useSettingsContext()
const { configurations, invalidKeys, pending } = pluginSettings
const { t } = useBuddyI18n(applicationSettings.language)
const message = useMessage()
async function save(value: ExtensionSettingValue) {
  if (await pluginSettings.save(props.field, value) === 'failed')
    message.error(t('desktop.settings.saveFailed'))
}
</script>

<template>
  <DesktopPluginSettingField
    :item="field.item"
    :value="configurations[field.extensionId]?.[field.item.key] === undefined ? field.item.default : configurations[field.extensionId]![field.item.key]!"
    :disabled="pending.has(field.extensionId) || !configurations[field.extensionId]"
    :invalid="invalidKeys[field.extensionId]?.includes(field.item.key) ?? false"
    :models="providerSettings.models.value"
    :providers="providerSettings.providers.value"
    :language="applicationSettings.language.value"
    @change="save"
  />
</template>

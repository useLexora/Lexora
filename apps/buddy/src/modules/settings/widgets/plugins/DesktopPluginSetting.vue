<script setup lang="ts">
import type { ExtensionSettingValue } from '@buddy-shared/extensions/extensionSettings'
import type { PluginSettingField } from '../../model/settingsRegistry'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingsContext } from '../../settingsContext'
import DesktopPluginSettingField from './DesktopPluginSettingField.vue'

const props = defineProps<{ field: PluginSettingField, compact?: boolean }>()
const { pluginSettings, providerSettings, applicationSettings } = useSettingsContext()
const { conditions, configurations, invalidKeys, pending } = pluginSettings
const { t } = useBuddyI18n(applicationSettings.language)
const error = shallowRef<string | null>(null)
watch(() => props.field, (field, _old, cleanup) => cleanup(conditions.observe(field)), { immediate: true })
const condition = computed(() => props.field.item.enabledWhen ? conditions.states.value[conditions.key(props.field)] : { status: 'ready' as const, value: true })
const invalid = computed(() => invalidKeys.value[props.field.extensionId]?.includes(props.field.item.key) ?? false)
const saving = computed(() => pending.value.has(props.field.extensionId) || !configurations.value[props.field.extensionId])
const reason = computed(() => condition.value?.reason ?? (condition.value?.status === 'unavailable' ? (applicationSettings.language.value === 'zh-CN' ? '暂时无法判断此项是否可用，请重试。' : 'Availability could not be determined. Please retry.') : undefined))
async function save(value: ExtensionSettingValue) {
  error.value = null
  const result = await pluginSettings.save(props.field, value)
  if (result === 'failed')
    error.value = t('desktop.settings.saveFailed')
  return result
}
</script>

<template>
  <DesktopPluginSettingField
    :item="field.item"
    :compact="compact"
    :error="error"
    :value="configurations[field.extensionId]?.[field.item.key] === undefined ? field.item.default : configurations[field.extensionId]![field.item.key]!"
    :disabled="saving || (!invalid && condition?.value !== true)"
    :repair-disabled="saving"
    :saving="pending.has(field.extensionId)"
    :condition-reason="reason"
    :condition-unavailable="condition?.status === 'unavailable'"
    :invalid="invalid"
    :models="providerSettings.models.value"
    :providers="providerSettings.providers.value"
    :language="applicationSettings.language.value"
    @change="save"
    @draft="conditions.draft(field, $event)"
    @retry="conditions.refresh(field.extensionId)"
  >
    <template v-if="$slots.control" #control="control">
      <slot name="control" v-bind="control" :save="save" />
    </template>
  </DesktopPluginSettingField>
</template>

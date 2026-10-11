<script setup lang="ts">
import type { ExtensionSettingItem, ExtensionSettingValue } from '@buddy-shared/extensions/extensionSettings'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NInput, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import { shallowRef, watch } from 'vue'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopPluginModelSetting from './DesktopPluginModelSetting.vue'

const props = defineProps<{
  item: ExtensionSettingItem
  value: ExtensionSettingValue
  disabled: boolean
  saving?: boolean
  repairDisabled?: boolean
  conditionReason?: string
  conditionUnavailable?: boolean
  invalid: boolean
  models: readonly LocalRuntimeModelOption[]
  providers: readonly LocalProvider[]
  language: BuddyLocale
}>()
const emit = defineEmits<{ change: [value: ExtensionSettingValue], draft: [value: ExtensionSettingValue], retry: [] }>()
const draft = shallowRef(props.value)
watch([() => props.value, () => props.saving, () => props.item.id], ([value, saving]) => {
  if (!saving)
    draft.value = value
})
function commit(value: ExtensionSettingValue) {
  if (props.disabled)
    return
  draft.value = value
  if (value !== props.value)
    emit('change', value)
}
</script>

<template>
  <DesktopSettingRow class="plugin-setting-field" :label="item.title" :description="item.description" :toggle="item.type === 'boolean'" :data-setting-id="item.id">
    <template #hint>
      <small v-if="invalid" class="text-[0.7rem] text-warning leading-[1.5]" role="status">
        {{ language === 'zh-CN' ? '原值已保留，但不符合当前版本的要求。请修改此项或恢复默认值。' : 'The saved value is preserved but is incompatible with this version. Change this field or restore its default.' }}
        <NButton text size="tiny" :disabled="repairDisabled ?? disabled" @click="emit('change', item.default)">
          {{ language === 'zh-CN' ? '恢复默认值' : 'Restore default' }}
        </NButton>
      </small>
      <small v-if="conditionReason" class="text-[0.7rem] text-muted leading-[1.5]" role="status">
        {{ conditionReason }}
        <NButton v-if="conditionUnavailable" text size="tiny" :disabled="repairDisabled" @click="emit('retry')">
          {{ language === 'zh-CN' ? '重试' : 'Retry' }}
        </NButton>
      </small>
    </template>
    <template #default="{ labelId, controlAttrs }">
      <NSwitch v-if="item.type === 'boolean'" :value="value === true" :round="false" :disabled="disabled" :aria-disabled="disabled" v-bind="controlAttrs" @update:value="emit('change', $event)" />
      <DesktopPluginModelSetting v-else-if="item.type === 'model'" :value="value && typeof value === 'object' ? value : null" :models="models" :providers="providers" :language="language" :disabled="disabled" :label-id="labelId" :description-id="controlAttrs['aria-describedby']" @change="emit('change', $event)" />
      <NSelect v-else-if="item.type === 'select'" :value="typeof value === 'string' ? value : null" :options="item.options" :disabled="disabled" v-bind="controlAttrs" @update:value="emit('change', $event)" />
      <NInputNumber v-else-if="item.type === 'number'" :value="typeof draft === 'number' ? draft : null" :update-value-on-input="false" :min="item.min" :max="item.max" :disabled="disabled" v-bind="controlAttrs" @update:value="$event !== null && commit($event)" />
      <NInput v-else :value="String(draft ?? '')" :maxlength="8192" :disabled="disabled" v-bind="controlAttrs" @update:value="draft = $event; emit('draft', $event)" @change="commit" @keydown.enter="!$event.isComposing && commit(String(draft ?? ''))" />
    </template>
  </DesktopSettingRow>
</template>

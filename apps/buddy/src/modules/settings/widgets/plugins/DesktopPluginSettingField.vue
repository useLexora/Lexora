<script setup lang="ts">
import type { ExtensionSettingItem, ExtensionSettingValue } from '@buddy-shared/extensions/extensionSettings'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NInput, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import { shallowRef, useId, watch } from 'vue'
import DesktopPluginModelSetting from './DesktopPluginModelSetting.vue'

const props = defineProps<{
  item: ExtensionSettingItem
  value: ExtensionSettingValue
  disabled: boolean
  invalid: boolean
  models: readonly LocalRuntimeModelOption[]
  providers: readonly LocalProvider[]
  language: BuddyLocale
}>()
const emit = defineEmits<{ change: [value: ExtensionSettingValue] }>()
const labelId = useId()
const draft = shallowRef(props.value)
watch([() => props.value, () => props.disabled, () => props.item.id], ([value, disabled]) => {
  if (!disabled)
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
  <div class="plugin-setting-field" :data-setting-id="item.id">
    <div class="plugin-setting-field__copy">
      <strong :id="labelId">{{ item.title }}</strong>
      <small v-if="item.description">{{ item.description }}</small>
      <small v-if="invalid" class="plugin-setting-field__issue" role="status">
        {{ language === 'zh-CN' ? '原值已保留，但不符合当前版本的要求。请修改此项或恢复默认值。' : 'The saved value is preserved but is incompatible with this version. Change this field or restore its default.' }}
        <NButton text size="tiny" :disabled="disabled" @click="emit('change', item.default)">
          {{ language === 'zh-CN' ? '恢复默认值' : 'Restore default' }}
        </NButton>
      </small>
    </div>
    <div class="plugin-setting-field__control" :class="{ 'is-toggle': item.type === 'boolean' }">
      <NSwitch v-if="item.type === 'boolean'" :value="value === true" :round="false" :disabled="disabled" :aria-disabled="disabled" :aria-labelledby="labelId" @update:value="emit('change', $event)" />
      <DesktopPluginModelSetting v-else-if="item.type === 'model'" :value="value && typeof value === 'object' ? value : null" :models="models" :providers="providers" :language="language" :disabled="disabled" :label-id="labelId" @change="emit('change', $event)" />
      <NSelect v-else-if="item.type === 'select'" :value="typeof value === 'string' ? value : null" :options="item.options" :disabled="disabled" :aria-labelledby="labelId" @update:value="emit('change', $event)" />
      <NInputNumber v-else-if="item.type === 'number'" :value="typeof draft === 'number' ? draft : null" :update-value-on-input="false" :min="item.min" :max="item.max" :disabled="disabled" :aria-labelledby="labelId" @update:value="$event !== null && commit($event)" />
      <NInput v-else :value="String(draft ?? '')" :maxlength="8192" :disabled="disabled" :aria-labelledby="labelId" @update:value="draft = $event" @change="commit" @keydown.enter="!$event.isComposing && commit(String(draft ?? ''))" />
    </div>
  </div>
</template>

<style scoped>
.plugin-setting-field { display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, 19rem); align-items: center; gap: 2rem; min-height: 4rem; padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--buddy-border-subtle); }
.plugin-setting-field:last-child { border-bottom: 0; }
.plugin-setting-field__copy { display: grid; gap: 0.25rem; }
.plugin-setting-field__copy strong { font-size: 0.8rem; font-weight: 600; color: var(--buddy-text-primary); }
.plugin-setting-field__copy small { font-size: 0.7rem; line-height: 1.5; color: var(--buddy-text-secondary); }
.plugin-setting-field__copy .plugin-setting-field__issue { color: var(--buddy-warning-color, var(--buddy-text-secondary)); }
.plugin-setting-field__control { min-width: 0; }
.plugin-setting-field__control.is-toggle { justify-self: end; }
@container (max-width: 560px) { .plugin-setting-field { grid-template-columns: minmax(0, 1fr); gap: 0.7rem; } }
</style>

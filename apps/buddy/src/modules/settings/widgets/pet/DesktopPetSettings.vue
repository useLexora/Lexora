<script setup lang="ts">
import type { ApplicationSettingsProps } from '../app/typing'
import { NSpin, NSwitch } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

type SettingField = 'enabled' | 'alwaysOnTop' | 'rememberPosition'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const { pending: pendingFields, failed: failedFields, save } = useSettingMutation<SettingField>(patch => props.updateSettings(patch))
const behaviorDisabled = computed(() => !props.config?.pet.enabled || pendingFields.value.has('enabled'))
const behaviorFields = ['alwaysOnTop', 'rememberPosition'] as const
</script>

<template>
  <section v-if="config" class="desktop-pet-settings grid gap-[1.8rem] [container-type:inline-size] [--setting-label-min:9rem] [--setting-control-min:13rem]">
    <DesktopSettingsGroup>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.pet.enabled')" :description="t('desktop.settings.pet.enabledDescription')" :error="failedFields.has('enabled') ? error ?? t('desktop.settings.saveFailed') : null" toggle>
        <NSwitch v-bind="controlAttrs" :round="false" :value="config.pet.enabled" :disabled="pendingFields.size > 0" @update:value="save('enabled', { pet: { enabled: $event } })" />
        <NSpin v-if="pendingFields.has('enabled')" size="small" />
      </DesktopSettingRow>
    </DesktopSettingsGroup>
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.pet.behavior') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-for="field in behaviorFields" :key="field" v-slot="{ controlAttrs }" :label="t(`desktop.settings.pet.${field}`)" :description="t(`desktop.settings.pet.${field}Description`)" :disabled="behaviorDisabled" :error="failedFields.has(field) ? error ?? t('desktop.settings.saveFailed') : null" toggle>
          <NSwitch v-bind="controlAttrs" :round="false" :value="config.pet[field]" :disabled="behaviorDisabled || pendingFields.has(field)" :aria-disabled="behaviorDisabled || pendingFields.has(field)" @update:value="save(field, { pet: { [field]: $event } })" />
          <NSpin v-if="pendingFields.has(field)" size="small" />
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
  </section>
</template>

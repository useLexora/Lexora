<script setup lang="ts">
import type { ProviderRequestHeader } from '@buddy-shared/providers/providerHeaders'
import type { FormItemRule } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { providerHeaderNameSchema, providerHeaderValueSchema } from '@buddy-shared/providers/providerHeaders'
import { Add20Regular, Dismiss20Regular } from '@vicons/fluent'
import { NButton, NFormItem, NInput } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: BuddyLocale, disabled?: boolean }>()
const headers = defineModel<ProviderRequestHeader[]>('value', { required: true })
const { t } = useBuddyI18n(() => props.language)

function nameRule(index: number): FormItemRule {
  return {
    trigger: ['input', 'blur'],
    validator: (_rule, value) => {
      const parsed = providerHeaderNameSchema.safeParse(value)
      if (!parsed.success)
        return new Error(t('desktop.providers.invalidHeaderName'))
      return !headers.value.some((header, other) => other !== index && header.name.trim().toLowerCase() === parsed.data.toLowerCase())
        || new Error(t('desktop.providers.duplicateHeaderName'))
    },
  }
}

const valueRule: FormItemRule = {
  trigger: ['input', 'blur'],
  validator: (_rule, value) => providerHeaderValueSchema.safeParse(value).success || new Error(t('desktop.providers.invalidHeaderValue')),
}

function update(index: number, field: keyof ProviderRequestHeader, value: string) {
  headers.value = headers.value.map((header, other) => other === index ? { ...header, [field]: value } : header)
}
</script>

<template>
  <div class="desktop-provider-headers-editor">
    <div class="flex items-center justify-between gap-[0.6rem] mb-[0.65rem]">
      <span>{{ t('desktop.providers.requestHeaders') }}</span>
      <NButton size="small" :disabled="disabled || headers.length >= 32" @click="headers = [...headers, { name: '', value: '' }]">
        <template #icon>
          <DesktopIcon :component="Add20Regular" />
        </template>
        {{ t('desktop.providers.addHeader') }}
      </NButton>
    </div>
    <div v-for="(header, index) in headers" :key="index" class="desktop-provider-headers-editor__row grid grid-cols-[minmax(7rem,_1fr)_minmax(9rem,_2fr)_auto] gap-2 items-start">
      <NFormItem :path="`requestHeaders.${index}.name`" :rule="nameRule(index)" :show-label="false">
        <NInput :value="header.name" :disabled="disabled" :placeholder="t('desktop.providers.headerName')" @update:value="update(index, 'name', $event)" />
      </NFormItem>
      <NFormItem :path="`requestHeaders.${index}.value`" :rule="valueRule" :show-label="false">
        <NInput :value="header.value" :disabled="disabled" :placeholder="t('desktop.providers.headerValue')" @update:value="update(index, 'value', $event)" />
      </NFormItem>
      <NButton class="buddy-icon-button" quaternary :disabled="disabled" :aria-label="t('desktop.providers.removeHeader')" @click="headers = headers.filter((_, other) => other !== index)">
        <template #icon>
          <DesktopIcon :component="Dismiss20Regular" />
        </template>
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@media (max-width: 600px) {
  .desktop-provider-headers-editor__row { grid-template-columns: minmax(0, 1fr) auto; }
  .desktop-provider-headers-editor__row > :first-child { grid-column: 1 / -1; }
}
</style>

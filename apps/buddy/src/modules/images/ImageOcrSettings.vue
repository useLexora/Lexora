<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NSwitch } from 'naive-ui'
import { shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopSettingRow } from '@/modules/settings/ui'
import ImageOcrServiceDialog from './ImageOcrServiceDialog.vue'

const props = defineProps<{ language: BuddyLocale, enabled: boolean, configured: boolean, disabled: boolean }>()
const emit = defineEmits<{ enabled: [value: boolean], configured: [] }>()
const { t } = useBuddyI18n(() => props.language)
const configuring = shallowRef(false)
function handleSaved() {
  configuring.value = false
  emit('configured')
}
</script>

<template>
  <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('images.ocrEnabled')" :description="t('images.ocrHint')" toggle data-image-ocr-enabled>
    <NSwitch v-bind="controlAttrs" :round="false" :value="enabled" :disabled="disabled" @update:value="emit('enabled', $event)" />
  </DesktopSettingRow>
  <DesktopSettingRow :label="t('images.ocrService')" :description="configured ? 'PaddleOCR' : t('images.ocrUnconfigured')" data-image-operation="extract">
    <NButton class="justify-self-end" size="small" :disabled="disabled" @click="configuring = true">
      {{ t('images.manageOcr') }}
    </NButton>
  </DesktopSettingRow>
  <ImageOcrServiceDialog v-if="configuring" :language="language" @close="configuring = false" @saved="handleSaved" />
</template>

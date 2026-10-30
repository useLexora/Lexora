<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NCard, NCheckbox, NInput, NModal, NSelect } from 'naive-ui'
import { useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useOcrServiceForm } from './useOcrServiceForm'

const props = defineProps<{ language: BuddyLocale }>()
const emit = defineEmits<{ close: [], saved: [] }>()
const { t } = useBuddyI18n(() => props.language)
const formId = useId()
const interfaceOptions = [{ label: 'PaddleOCR', value: 'paddleocr' }]
const { status, interfaceType, endpoint, credential, clearCredential, loading, saving, failed, valid, needsCredential, load, save } = useOcrServiceForm()
async function submit() {
  if (await save())
    emit('saved')
}
</script>

<template>
  <NModal show :mask-closable="!saving" :close-on-esc="!saving" @update:show="!$event && emit('close')">
    <NCard class="w-[min(30rem,calc(100vw-2rem))]" :title="t('images.manageOcr')" :closable="!saving" role="dialog" aria-modal="true" :aria-label="t('images.manageOcr')" @close="emit('close')">
      <form class="grid gap-4" data-ocr-service-form @submit.prevent="submit">
        <div class="grid gap-2 text-sm">
          <span :id="`${formId}-api`">{{ t('images.ocrApi') }}</span>
          <NSelect v-model:value="interfaceType" :options="interfaceOptions" :disabled="loading || saving || failed === 'load'" :aria-labelledby="`${formId}-api`" />
        </div>
        <div class="grid gap-2 text-sm">
          <label :for="`${formId}-endpoint`">{{ t('images.ocrEndpoint') }}</label>
          <NInput v-model:value="endpoint" :disabled="loading || saving || failed === 'load'" placeholder="http://localhost:8080/ocr" :input-props="{ id: `${formId}-endpoint` }" />
        </div>
        <div class="grid gap-2 text-sm">
          <label :for="`${formId}-credential`">{{ t('images.ocrCredential') }}</label>
          <NInput v-model:value="credential" type="password" show-password-on="click" :disabled="loading || saving || clearCredential || failed === 'load'" :placeholder="t(status.hasCredential ? 'images.ocrCredentialSaved' : 'images.ocrCredentialOptional')" :input-props="{ id: `${formId}-credential` }" />
        </div>
        <NCheckbox v-if="status.hasCredential" v-model:checked="clearCredential" :disabled="loading || saving">
          {{ t('images.ocrRemoveCredential') }}
        </NCheckbox>
        <p v-if="needsCredential" class="m-0 text-xs text-danger" role="alert">
          {{ t('images.ocrEndpointChanged') }}
        </p>
        <div v-if="failed" class="flex items-center gap-2 text-sm text-danger" role="alert">
          {{ t(failed === 'load' ? 'images.ocrLoadFailed' : 'images.saveFailed') }}
          <NButton v-if="failed === 'load'" size="tiny" @click="load">
            {{ t('images.retry') }}
          </NButton>
        </div>
        <div class="flex justify-end gap-2">
          <NButton :disabled="saving" @click="emit('close')">
            {{ t('images.cancel') }}
          </NButton>
          <NButton type="primary" attr-type="submit" :disabled="!valid" :loading="saving">
            {{ t('images.save') }}
          </NButton>
        </div>
      </form>
    </NCard>
  </NModal>
</template>

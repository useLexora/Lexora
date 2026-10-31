<script setup lang="ts">
import type { ImageOperation } from '@buddy-shared/images/imagePreferences'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopSettingsGroup } from '@/modules/settings/ui'
import ImageLegacyPolicy from './ImageLegacyPolicy.vue'
import ImageOcrSettings from './ImageOcrSettings.vue'
import ImagePolicySettings from './ImagePolicySettings.vue'
import { useImageSettings } from './useImageSettings'

const props = defineProps<{ language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const { candidates, ocrEnabled, ocrConfigured, loading, failed, failedOperations, refresh, change, changeOcrEnabled, inherit, legacy, retry, policy } = useImageSettings()
const legacyDocument = computed(() => legacy('document'))
const legacyEdit = computed(() => legacy('edit'))
const legacyOcr = computed(() => legacy('extract'))
const readingFailures = computed(() => [...failedOperations.value].filter(operation => operation === 'understand' || operation === 'document'))
const generationFailures = computed(() => [...failedOperations.value].filter(operation => operation === 'generate' || operation === 'edit'))
function failureLabel(operation: ImageOperation) {
  return t(operation === 'extract' ? 'images.ocr' : operation === 'edit' || operation === 'document' ? `images.legacy.${operation}` : `images.${operation}`)
}
</script>

<template>
  <section class="grid gap-[0.8rem]" data-image-settings>
    <h2 class="m-0 w-fit text-[0.92rem] font-600">
      {{ t('images.title') }}
    </h2>
    <div v-if="failed" class="flex items-center gap-2 text-danger text-[0.75rem]" role="alert">
      {{ t('images.loadFailed') }}
      <NButton size="small" @click="refresh">
        {{ t('images.retry') }}
      </NButton>
    </div>
    <DesktopSettingsGroup data-image-models>
      <ImagePolicySettings :policy="policy('understand')" operation="understand" :candidates="candidates" :language="language" :disabled="loading" @change="change('understand', $event)">
        <ImageLegacyPolicy v-if="legacyDocument" operation="document" :policy="legacyDocument" :candidates="candidates" :language="language" :disabled="loading" @inherit="inherit('document')" />
        <div v-for="operation in readingFailures" :key="operation" class="flex items-center justify-end gap-2 px-4 py-2 text-[0.7rem] text-danger" role="alert">
          <span>{{ failureLabel(operation) }}：{{ t('images.saveFailed') }}</span>
          <NButton size="tiny" @click="retry(operation)">
            {{ t('images.retry') }}
          </NButton>
        </div>
      </ImagePolicySettings>
      <ImagePolicySettings :policy="policy('generate')" operation="generate" :candidates="candidates" :language="language" :disabled="loading" @change="change('generate', $event)">
        <ImageLegacyPolicy v-if="legacyEdit" operation="edit" :policy="legacyEdit" :candidates="candidates" :language="language" :disabled="loading" @inherit="inherit('edit')" />
        <div v-for="operation in generationFailures" :key="operation" class="flex items-center justify-end gap-2 px-4 py-2 text-[0.7rem] text-danger" role="alert">
          <span>{{ failureLabel(operation) }}：{{ t('images.saveFailed') }}</span>
          <NButton size="tiny" @click="retry(operation)">
            {{ t('images.retry') }}
          </NButton>
        </div>
      </ImagePolicySettings>
    </DesktopSettingsGroup>
    <DesktopSettingsGroup data-image-ocr>
      <ImageOcrSettings :language="language" :enabled="ocrEnabled" :configured="ocrConfigured" :disabled="loading" @enabled="changeOcrEnabled" @configured="refresh" />
      <ImageLegacyPolicy v-if="legacyOcr" operation="extract" :policy="legacyOcr" :candidates="candidates" :language="language" :disabled="loading || !ocrEnabled" @inherit="inherit('extract')" />
      <div v-if="failedOperations.has('extract')" class="flex items-center justify-end gap-2 px-4 py-2 text-[0.7rem] text-danger" role="alert">
        <span>{{ t('images.ocr') }}：{{ t('images.saveFailed') }}</span>
        <NButton size="tiny" @click="retry('extract')">
          {{ t('images.retry') }}
        </NButton>
      </div>
    </DesktopSettingsGroup>
  </section>
</template>

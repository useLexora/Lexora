<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NModal, NSpin } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopDocumentToolbar from '@/shared/ui/files/DesktopDocumentToolbar.vue'
import DesktopMonacoFile from '@/shared/ui/files/DesktopMonacoFile.vue'

const props = defineProps<{
  disabled: boolean
  language: BuddyLocale
  preview: { name: string, text?: string, failed: boolean } | null
}>()
const emit = defineEmits<{
  close: []
  restore: []
  retry: []
}>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <NModal
    :show="Boolean(preview)"
    preset="card"
    class="composer-text-preview"
    :style="{ width: 'min(48rem, calc(100vw - 3rem))' }"
    :bordered="false"
    @update:show="show => !show && emit('close')"
  >
    <template #header>
      <DesktopDocumentToolbar v-if="preview" :model-value="null" :name="preview.name" :modes="[]" :language="language" embedded />
    </template>
    <template v-if="preview">
      <div v-if="preview.text !== undefined" class="h-[min(60vh,_40rem)] overflow-hidden border-1 border-solid border-border rounded-micro">
        <DesktopMonacoFile :text="preview.text" :path="preview.name" :wrap="true">
          <template #error>
            {{ t('chat.attachmentReadFailed') }}
          </template>
        </DesktopMonacoFile>
      </div>
      <NAlert v-else-if="preview.failed" type="error" :show-icon="false">
        {{ t('chat.attachmentReadFailed') }}
        <NButton size="small" @click="emit('retry')">
          {{ t('desktop.chat.retryAttachment') }}
        </NButton>
      </NAlert>
      <NSpin v-else size="small" />
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton @click="emit('close')">
          {{ t('common.close') }}
        </NButton>
        <NButton type="primary" :disabled="disabled || preview?.text === undefined" @click="emit('restore')">
          {{ t('desktop.chat.restorePastedText') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

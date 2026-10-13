<script setup lang="ts">
import type { ExtensionIncompatibleReview } from '@buddy-shared/extensions/extensionCompatibility'
import { NButton, NModal } from 'naive-ui'
import DesktopExtensionCompatibilityNotice from './DesktopExtensionCompatibilityNotice.vue'

defineProps<{ review: ExtensionIncompatibleReview, language: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <NModal show preset="card" :title="language === 'en-US' ? 'Plugin unavailable' : '插件暂不可用'" class="extension-incompatible-review" :style="{ width: 'min(500px, calc(100vw - 32px))' }" @update:show="!$event && emit('close')">
    <p class="mt-0 text-strong text-[14px] font-600">
      {{ review.manifest.name }} {{ review.manifest.version }}
    </p>
    <DesktopExtensionCompatibilityNotice :issue="review.incompatibility" :language="language" />
    <template #footer>
      <div class="flex justify-end">
        <NButton @click="emit('close')">
          {{ language === 'en-US' ? 'Close' : '关闭' }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NModal } from 'naive-ui'
import { watch } from 'vue'
import BuddyImageViewer from './BuddyImageViewer.vue'

const props = defineProps<{
  language: BuddyLocale
  sources: readonly string[]
  names?: readonly string[]
  referenceImage?: (index: number) => Promise<boolean>
  referenced?: boolean
}>()
const current = defineModel<number>('current', { default: 0 })
const show = defineModel<boolean>('show', { default: false })
watch(() => props.sources.length, (length) => {
  if (!length)
    show.value = false
})
</script>

<template>
  <NModal v-model:show="show" :close-on-esc="true" :mask-closable="false">
    <BuddyImageViewer
      v-if="show && sources.length"
      v-model:current="current"
      :language="language" :sources="sources" :names="names" :reference-image="referenceImage" :referenced="referenced"
      @close="show = false"
    />
  </NModal>
</template>

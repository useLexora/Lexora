<script setup lang="ts">
import type { ChangeFilePresentation } from './changeContextPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useTemplateRef } from 'vue'
import DesktopChangeFileBlock from './DesktopChangeFileBlock.vue'
import { useChangeFileViewport } from './useChangeFileViewport'

defineProps<{
  files: readonly ChangeFilePresentation[]
  collapsedFiles: ReadonlySet<string>
  language: BuddyLocale
  wrap: boolean
  sideBySide: boolean
}>()
defineEmits<{ toggle: [fileId: string] }>()
const root = useTemplateRef<HTMLElement>('root')
const observe = useChangeFileViewport(root)

function reveal(id: string) {
  const element = [...root.value?.querySelectorAll<HTMLElement>('[data-change-id]') ?? []].find(item => item.dataset.changeId === id)
  element?.scrollIntoView({ block: 'start' })
}
defineExpose({ reveal })
</script>

<template>
  <div ref="root" class="context-change-list flex w-full h-full flex-col gap-[12px] overflow-auto p-[12px]">
    <DesktopChangeFileBlock v-for="file in files" :key="file.id" :file="file" :language="language" :collapsed="collapsedFiles.has(file.id)" :observe="observe" :wrap="wrap" :side-by-side="sideBySide" @toggle="$emit('toggle', file.id)" />
  </div>
</template>

<style scoped lang="scss">
.context-change-list {
  scroll-padding-block: 12px;
}
</style>

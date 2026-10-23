<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ArtifactViewMode } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { resolveBuiltinFileOpening } from '@buddy-shared/files/fileOpening'
import { computed } from 'vue'
import { fileOpeningHandler } from '@/modules/files'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import DesktopDocumentToolbar from '@/shared/ui/files/DesktopDocumentToolbar.vue'
import { fileDocumentModes, resolveFileDocumentMode } from '@/shared/ui/files/fileDocumentPresentation'
import { formatDate, resolveFileType } from './artifactContextPresentation'

const props = defineProps<{ artifact: LocalArtifact, language: BuddyLocale, textAvailable: boolean, previewAvailable?: boolean }>()
const viewMode = defineModel<ArtifactViewMode>('viewMode', { required: true })
const modes = computed(() => fileDocumentModes({
  preview: props.previewAvailable ?? !!fileOpeningHandler(resolveBuiltinFileOpening(props.artifact.name, 'standalone').provider)?.preview,
  source: props.textAvailable,
  edit: false,
}))
const mode = computed({
  get: () => resolveFileDocumentMode(viewMode.value, modes.value),
  set: (value) => {
    if (value === 'source' || value === 'preview')
      viewMode.value = value
  },
})
const detail = computed(() => props.artifact.kind === 'directory'
  ? ''
  : [resolveFileType(props.artifact), formatFileSize(props.artifact.sizeBytes), formatDate(props.artifact.updatedAt, props.language)].join(' · '))
</script>

<template>
  <DesktopDocumentToolbar v-model="mode" :name="artifact.name" :path="artifact.path" :detail="detail" :modes="modes" :language="language" />
</template>

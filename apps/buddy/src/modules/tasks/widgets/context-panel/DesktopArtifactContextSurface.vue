<script setup lang="ts">
import type { LocalArtifact, LocalArtifactText } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ArtifactViewMode } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { NSpin } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import DesktopDocumentContent from '@/shared/ui/files/DesktopDocumentContent.vue'
import BuddyImagePreview from '@/shared/ui/media/BuddyImagePreview.vue'
import { isMarkdownArtifact } from './artifactContextPresentation'
import DesktopArtifactToolbar from './DesktopArtifactToolbar.vue'
import { useArtifactPreview } from './useArtifactPreview'

const props = defineProps<{
  artifact: LocalArtifact
  language: BuddyLocale
  readArtifactText: (artifactId: string) => Promise<LocalArtifactText>
  writeClipboardText: (text: string) => Promise<void>
}>()
const viewMode = defineModel<ArtifactViewMode>('viewMode', { required: true })

const markdown = computed(() => isMarkdownArtifact(props.artifact))
const { t } = useBuddyI18n(() => props.language)
const { failImage, openPreview, previewIndex, previewOpen, previewSources, previewUrl, textPreview, textPreviewFailed, textPreviewLoading } = useArtifactPreview({
  artifact: () => props.artifact,
  readText: () => props.readArtifactText,
})
</script>

<template>
  <section class="desktop-artifact-context-surface flex min-w-0 min-h-0 flex-1 flex-col bg-surface">
    <DesktopArtifactToolbar v-model:view-mode="viewMode" :artifact="artifact" :language="language" :text-available="!!textPreview" />
    <BuddyImagePreview
      v-model:current="previewIndex"
      v-model:show="previewOpen"
      :language="language"
      :sources="previewSources"
    />

    <div class="desktop-artifact-context-surface__viewport grid min-w-0 min-h-0 flex-1 overflow-auto bg-subtle p-4 place-items-center" :class="{ 'desktop-artifact-context-surface__viewport--document': textPreview }">
      <button
        v-if="previewUrl"
        class="desktop-artifact-context-surface__preview-trigger grid max-w-full max-h-full place-items-center border-0 bg-transparent p-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[3px]"
        type="button"
        :aria-label="t('desktop.imagePreview.open', { name: artifact.name })"
        @click="openPreview"
      >
        <img
          :key="previewUrl"
          :alt="artifact.name"
          :src="previewUrl"
          @error="failImage"
        >
      </button>
      <div v-else-if="textPreviewLoading" class="desktop-artifact-context-surface__fallback grid max-w-96 gap-2 text-muted text-center">
        <NSpin size="small" />
        <span>{{ t('common.loading') }}</span>
      </div>
      <DesktopDocumentContent v-else-if="textPreview" :mode="markdown ? viewMode : 'source'" :name="artifact.name" :text="textPreview.text" :language="language" :write-clipboard-text="writeClipboardText" />
      <div v-else class="desktop-artifact-context-surface__fallback grid max-w-96 gap-2 text-muted text-center">
        <FolderIcon
          v-if="artifact.kind === 'directory'"
          class="desktop-artifact-context-surface__folder-icon"
        />
        <FileIcon v-else :name="artifact.name" size="preview" />
        <strong>{{ artifact.name }}</strong>
        <span v-if="artifact.kind === 'directory'" class="desktop-artifact-context-surface__path">
          {{ artifact.path }}
        </span>
        <span v-else>{{ t(textPreviewFailed ? 'desktop.context.previewLoadFailed' : 'desktop.context.previewUnavailable') }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-artifact-context-surface__viewport--document {
  display: flex;
  align-items: stretch;
  overflow: hidden;
  background: var(--buddy-surface-base);
  padding: 0;
}

.desktop-artifact-context-surface__preview-trigger {
  cursor: zoom-in;
}

.desktop-artifact-context-surface__folder-icon {
  width: 4rem;
  height: 4rem;
  object-fit: contain;
}

.desktop-artifact-context-surface__preview-trigger img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.desktop-artifact-context-surface__fallback {
  justify-items: center;
}

.desktop-artifact-context-surface__fallback strong {
  color: var(--buddy-text-primary);
  font-size: 0.82rem;
}

.desktop-artifact-context-surface__fallback span {
  font-size: 0.75rem;
}

.desktop-artifact-context-surface__fallback .desktop-artifact-context-surface__path {
  max-width: 100%;
  font-family: var(--buddy-font-mono, ui-monospace, monospace);
  overflow-wrap: anywhere;
}
</style>

<script setup lang="ts">
import type { LocalArtifact, LocalArtifactText } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ArtifactViewMode } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { NSpin } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import DesktopMonacoFile from '@/shared/ui/files/DesktopMonacoFile.vue'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import BuddyImagePreview from '@/shared/ui/media/BuddyImagePreview.vue'
import { isMarkdownArtifact } from './artifactContextPresentation'
import { useArtifactPreview } from './useArtifactPreview'

const props = defineProps<{
  artifact: LocalArtifact
  language: BuddyLocale
  viewMode: ArtifactViewMode
  readArtifactText: (artifactId: string) => Promise<LocalArtifactText>
  writeClipboardText: (text: string) => Promise<void>
}>()

const markdown = computed(() => isMarkdownArtifact(props.artifact))
const { t } = useBuddyI18n(() => props.language)
const { failImage, openPreview, previewIndex, previewOpen, previewSources, previewUrl, textPreview, textPreviewFailed, textPreviewLoading } = useArtifactPreview({
  artifact: () => props.artifact,
  readText: () => props.readArtifactText,
})
</script>

<template>
  <section class="desktop-artifact-context-surface">
    <BuddyImagePreview
      v-model:current="previewIndex"
      v-model:show="previewOpen"
      :language="language"
      :sources="previewSources"
    />

    <div class="desktop-artifact-context-surface__viewport" :class="{ 'desktop-artifact-context-surface__viewport--document': markdown && textPreview }">
      <button
        v-if="previewUrl"
        class="desktop-artifact-context-surface__preview-trigger"
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
      <div v-else-if="textPreviewLoading" class="desktop-artifact-context-surface__fallback">
        <NSpin size="small" />
        <span>{{ t('common.loading') }}</span>
      </div>
      <article v-else-if="markdown && textPreview && viewMode === 'preview'" class="desktop-artifact-context-surface__markdown">
        <DesktopMarkdownContent :content="textPreview.text" code-overflow="scroll" :language="language" :write-clipboard-text="writeClipboardText" />
      </article>
      <DesktopMonacoFile v-else-if="markdown && textPreview" :text="textPreview.text" :path="artifact.path" :wrap="true">
        <template #error>
          {{ t('desktop.context.sourceLoadFailed') }}
        </template>
      </DesktopMonacoFile>
      <pre
        v-else-if="textPreview"
        class="desktop-artifact-context-surface__text"
      ><code>{{ textPreview.text }}</code></pre>
      <div v-else class="desktop-artifact-context-surface__fallback">
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

<style scoped>
.desktop-artifact-context-surface {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--buddy-surface-base);
}

.desktop-artifact-context-surface__viewport {
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  background: var(--buddy-surface-subtle);
  padding: 1rem;
  place-items: center;
}

.desktop-artifact-context-surface__viewport--document {
  display: block;
  overflow: hidden;
  background: var(--buddy-surface-base);
  padding: 0;
}

.desktop-artifact-context-surface__markdown {
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 1.25rem 1.5rem 2rem;
  color: var(--buddy-text-primary);
  font-family: var(--buddy-font-ui);
  overflow-wrap: anywhere;
  --buddy-chat-final-font-size: 0.875rem;
  --buddy-chat-final-line-height: 1.75;
}

.desktop-artifact-context-surface__preview-trigger {
  display: grid;
  max-width: 100%;
  max-height: 100%;
  place-items: center;
  border: 0;
  background: transparent;
  cursor: zoom-in;
  padding: 0;
}

.desktop-artifact-context-surface__preview-trigger:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 3px;
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
  display: grid;
  max-width: 24rem;
  justify-items: center;
  gap: 0.5rem;
  color: var(--buddy-text-muted);
  text-align: center;
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

.desktop-artifact-context-surface__text {
  align-self: stretch;
  justify-self: stretch;
  min-width: 0;
  margin: 0;
  overflow: auto;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: var(--buddy-radius-micro);
  background: var(--buddy-surface-base);
  color: var(--buddy-text-primary);
  font-family: var(--buddy-font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.65;
  padding: 0.875rem;
  tab-size: 2;
  white-space: pre;
}
</style>

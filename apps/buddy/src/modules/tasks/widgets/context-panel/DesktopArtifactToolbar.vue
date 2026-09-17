<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ArtifactViewMode } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { Code20Regular, Document20Regular, Eye20Regular, Folder20Regular } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { formatDate, isMarkdownArtifact, resolveArtifactDisplayMode, resolveFileType } from './artifactContextPresentation'

const props = defineProps<{ artifact: LocalArtifact, language: BuddyLocale }>()
const viewMode = defineModel<ArtifactViewMode>('viewMode', { required: true })
const { t } = useBuddyI18n(() => props.language)
const canToggle = computed(() => isMarkdownArtifact(props.artifact))
const displayMode = computed(() => resolveArtifactDisplayMode(props.artifact, viewMode.value))
const modePresentation = {
  preview: { icon: Eye20Regular, label: 'desktop.context.preview' },
  source: { icon: Code20Regular, label: 'desktop.context.source' },
  file: { icon: Document20Regular, label: 'desktop.context.previewUnavailable' },
  directory: { icon: Folder20Regular, label: 'desktop.context.directory' },
} as const
const modeLabel = computed(() => canToggle.value
  ? t(displayMode.value === 'preview' ? 'desktop.context.previewSwitchToSource' : 'desktop.context.sourceSwitchToPreview')
  : t(modePresentation[displayMode.value].label))
const detail = computed(() => props.artifact.kind === 'directory'
  ? t('desktop.context.directory')
  : [
      resolveFileType(props.artifact),
      formatFileSize(props.artifact.sizeBytes),
      formatDate(props.artifact.updatedAt, props.language),
    ].join(' · '))
</script>

<template>
  <header class="desktop-artifact-context-surface__toolbar">
    <div class="desktop-artifact-context-surface__heading">
      <strong>{{ artifact.name }}</strong>
      <NTooltip trigger="hover" :delay="350">
        <template #trigger>
          <NButton v-if="canToggle" class="desktop-artifact-context-surface__mode" quaternary :aria-label="modeLabel" @click="viewMode = viewMode === 'preview' ? 'source' : 'preview'">
            <template #icon>
              <DesktopIcon :component="modePresentation[displayMode].icon" :size="16" aria-hidden="true" />
            </template>
          </NButton>
          <span v-else class="desktop-artifact-context-surface__mode" role="img" :aria-label="modeLabel">
            <DesktopIcon :component="modePresentation[displayMode].icon" :size="16" aria-hidden="true" />
          </span>
        </template>
        {{ modeLabel }}
      </NTooltip>
    </div>
    <div class="desktop-artifact-context-surface__metadata">
      <small>{{ artifact.path }}</small>
      <span class="desktop-artifact-context-surface__detail">{{ detail }}</span>
    </div>
  </header>
</template>

<style scoped>
.desktop-artifact-context-surface__toolbar {
  display: flex;
  width: 100%;
  min-width: 0;
  height: var(--buddy-context-toolbar-height);
  flex: none;
  flex-direction: column;
  justify-content: center;
  padding: 0 0.75rem;
}

.desktop-artifact-context-surface__heading,
.desktop-artifact-context-surface__metadata {
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.desktop-artifact-context-surface__heading { height: 24px; }
.desktop-artifact-context-surface__metadata { height: 14px; }

.desktop-artifact-context-surface__heading strong,
.desktop-artifact-context-surface__metadata small {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-artifact-context-surface__heading strong {
  color: var(--buddy-text-strong);
  font-size: 0.8rem;
  font-weight: 600;
}

.desktop-artifact-context-surface__mode {
  display: inline-grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  border-radius: 6px;
  color: var(--buddy-text-secondary);
  padding: 0;
}

.desktop-artifact-context-surface__mode:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -1px;
}

.desktop-artifact-context-surface__metadata small {
  color: var(--buddy-text-muted);
  font-family: var(--buddy-font-mono, ui-monospace, monospace);
  font-size: 0.68rem;
}

.desktop-artifact-context-surface__detail {
  min-width: 0;
  max-width: 65%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--buddy-text-muted);
  font-size: 0.7rem;
  white-space: nowrap;
}
</style>

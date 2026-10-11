<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Open20Regular } from '@vicons/fluent'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatArtifactFileSize, resolveArtifactFileType } from '@/modules/tasks/model/artifacts/artifactPresentation'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  artifact: LocalArtifact
  language: BuddyLocale
  compact?: boolean
}>()
const emit = defineEmits<{
  openArtifact: [artifactId: string]
}>()
const { t } = useBuddyI18n(() => props.language)
const failedPreviewUrl = shallowRef<string | null>(null)
const previewUrl = computed(() => props.artifact.kind === 'file' && props.artifact.mimeType.startsWith('image/')
  ? `lexora-artifact://preview/${encodeURIComponent(props.artifact.artifactId)}?v=${encodeURIComponent(props.artifact.updatedAt)}`
  : null)
const previewable = computed(() => previewUrl.value !== null && failedPreviewUrl.value !== previewUrl.value)
const fileType = computed(() => props.artifact.kind === 'directory'
  ? t('desktop.context.directory')
  : resolveArtifactFileType(props.artifact))
const detail = computed(() => props.artifact.kind === 'directory'
  ? props.artifact.path
  : `${formatArtifactFileSize(props.artifact.sizeBytes)} · ${props.artifact.path}`)
</script>

<template>
  <button
    class="buddy-artifact-collection__item grid overflow-hidden min-w-0 border-1 border-solid border-accent-border rounded-micro bg-raised shadow-soft text-inherit cursor-pointer p-0 text-left hover:border-accent hover:bg-accent-subtle hover:shadow-raised focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
    :class="{ 'is-directory': artifact.kind === 'directory', 'is-compact': compact }"
    type="button"
    :title="artifact.name"
    @click="emit('openArtifact', artifact.artifactId)"
  >
    <div
      class="buddy-artifact-collection__preview grid h-28 place-items-center overflow-hidden border-b-1 border-b-solid border-b-border bg-accent-subtle text-muted"
      :class="{
        'is-contain': artifact.mimeType === 'image/svg+xml',
      }"
    >
      <FolderIcon
        v-if="artifact.kind === 'directory'"
        class="buddy-artifact-collection__directory-icon"
      />
      <img
        v-else-if="previewable"
        :alt="artifact.name"
        class="buddy-artifact-collection__image"
        loading="lazy"
        draggable="false"
        :src="previewUrl ?? undefined"
        @error="failedPreviewUrl = previewUrl"
      >
      <FileIcon v-else :name="artifact.name" size="preview" />
    </div>
    <div class="buddy-artifact-collection__meta grid min-w-0 grid-cols-[auto_minmax(0,_1fr)_auto] items-center py-2 px-[0.625rem]">
      <span class="buddy-artifact-collection__type [grid-area:type] text-accent-text text-[length:var(--buddy-chat-caption-font-size)] font-650">{{ fileType }}</span>
      <span class="buddy-artifact-collection__name overflow-hidden [grid-area:name] text-strong text-[length:var(--buddy-chat-caption-font-size)] text-ellipsis whitespace-nowrap">{{ artifact.name }}</span>
      <span class="buddy-artifact-collection__detail overflow-hidden [grid-area:detail] text-muted text-ellipsis whitespace-nowrap">{{ detail }}</span>
      <DesktopIcon :component="Open20Regular" class="buddy-artifact-collection__open" />
    </div>
  </button>
</template>

<style scoped lang="scss">
.buddy-artifact-collection__preview {
  .buddy-artifact-collection__image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  &.is-contain .buddy-artifact-collection__image {
    object-fit: contain;
    padding: 0.5rem;
  }
}

.buddy-artifact-collection__directory-icon {
  width: 3.25rem;
  height: 3.25rem;
  object-fit: contain;
}

.buddy-artifact-collection__meta {
  grid-template-areas:
    'type name open'
    'detail detail open';
  gap: 0.2rem 0.45rem;
}

.buddy-artifact-collection__detail {
  font-family: var(--buddy-font-mono, ui-monospace, monospace);
  font-size: var(--buddy-chat-caption-font-size);
}

.buddy-artifact-collection__open {
  width: 1rem;
  height: 1rem;
  grid-area: open;
  color: var(--buddy-chat-meta-color);
}

.buddy-artifact-collection__item.is-compact {
  flex: 0 1 96px;
  width: 96px;
  max-width: 96px;
  height: 68px;
  grid-template-rows: 40px minmax(0, 1fr);

  .buddy-artifact-collection__preview {
    height: auto;

    :deep(.buddy-file-icon),
    .buddy-artifact-collection__directory-icon {
      width: 1.75rem;
      height: 1.75rem;
    }
  }

  .buddy-artifact-collection__meta {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'name';
    padding: 3px 6px;
  }

  .buddy-artifact-collection__name {
    font-size: 10px;
  }

  .buddy-artifact-collection__type,
  .buddy-artifact-collection__detail,
  .buddy-artifact-collection__open {
    display: none;
  }
}
</style>

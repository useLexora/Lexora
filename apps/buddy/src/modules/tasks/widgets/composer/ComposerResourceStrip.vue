<script setup lang="ts">
import type { ComposerResourceCard } from './typing'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Dismiss16Regular } from '@vicons/fluent'
import { NButton, NScrollbar, NSpin } from 'naive-ui'
import { computed, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyImagePreview from '@/shared/ui/media/BuddyImagePreview.vue'
import { isPastedTextResource } from '../../model/composer/pastedText'
import { useResourceHighlight } from '../attachments/useResourceHighlight'

const props = defineProps<{
  disabled: boolean
  language: BuddyLocale
  resources: readonly ComposerResourceCard[]
}>()
const emit = defineEmits<{
  remove: [resourceId: string]
  retry: [resourceId: string]
  previewText: [resourceId: string]
}>()
const { t } = useBuddyI18n(() => props.language)
const resourceTrack = useTemplateRef<HTMLDivElement>('resourceTrack')
const { highlightedResourceId, highlightResource } = useResourceHighlight(resourceTrack)
const failedPreviewUrls = shallowRef<ReadonlySet<string>>(new Set())
const previewVisible = shallowRef(false)
const previewIndex = shallowRef(0)
const cards = computed(() => props.resources.map(entry => ({
  ...entry,
  previewUrl: entry.previewUrl && !failedPreviewUrls.value.has(entry.previewUrl) ? entry.previewUrl : null,
  textPreview: entry.resource.state === 'ready' && isPastedTextResource(entry.resource),
})))
const previewSources = computed(() => cards.value.flatMap(({ previewUrl }) => previewUrl ? [previewUrl] : []))
function openPreview(source: string) {
  previewIndex.value = previewSources.value.indexOf(source)
  previewVisible.value = true
}

function markPreviewFailed(url: string) {
  failedPreviewUrls.value = new Set([...failedPreviewUrls.value, url])
}

defineExpose({ highlightResource })
</script>

<template>
  <div v-if="cards.length" class="composer-resource-strip__scroll">
    <NScrollbar
      class="composer-resource-strip__scrollbar"
      container-class="composer-resource-strip__scrollport"
      content-style="width: max-content"
      trigger="hover"
      x-scrollable
    >
      <div ref="resourceTrack" class="composer-resource-strip">
        <div
          v-for="{ resource, canRetry, imageLabel, previewUrl, textPreview, textLineCount } in cards"
          :key="resource.resourceId"
          class="composer-resource-strip__card"
          :class="{ 'is-failed': resource.state === 'failed', 'is-highlighted': highlightedResourceId === resource.resourceId }"
          :data-resource-card="resource.resourceId"
        >
          <component
            :is="previewUrl || textPreview ? 'button' : 'div'"
            class="composer-resource-strip__content"
            :class="{ 'is-previewable': previewUrl || textPreview, 'is-image': previewUrl }"
            :type="previewUrl || textPreview ? 'button' : undefined"
            :aria-label="previewUrl ? t('desktop.imagePreview.open', { name: resource.name }) : textPreview ? t('desktop.chat.pastedTextPreview', { name: resource.name }) : undefined"
            :title="textPreview && textLineCount !== undefined ? `${resource.name}\n${t('desktop.chat.pastedTextLines', { count: textLineCount })}` : resource.localReference?.path ?? resource.name"
            @click="previewUrl ? openPreview(previewUrl) : textPreview && emit('previewText', resource.resourceId)"
          >
            <NSpin v-if="resource.state === 'importing'" :size="20" />
            <img v-else-if="previewUrl" :src="previewUrl" :alt="resource.name" width="36" height="36" @error="markPreviewFailed(previewUrl)">
            <FolderIcon v-else-if="resource.kind === 'directory'" class="composer-resource-strip__folder" />
            <FileIcon v-else :name="resource.name" size="medium" />
            <span class="composer-resource-strip__details">
              <span>{{ imageLabel ?? resource.name }}</span>
              <small v-if="resource.state !== 'ready'">
                {{ t(resource.state === 'importing'
                  ? 'desktop.chat.importingAttachment'
                  : canRetry
                    ? 'desktop.chat.failedAttachment'
                    : 'desktop.chat.attachmentSourceUnavailable') }}
              </small>
            </span>
          </component>
          <NButton v-if="resource.state === 'failed' && canRetry" text :disabled="disabled" size="tiny" @click.stop="emit('retry', resource.resourceId)">
            {{ t('desktop.chat.retryAttachment') }}
          </NButton>
          <NButton
            class="buddy-icon-button"
            quaternary
            size="tiny"
            :disabled="disabled"
            :aria-label="t('desktop.chat.removeAttachment')"
            @click.stop="emit('remove', resource.resourceId)"
          >
            <template #icon>
              <DesktopIcon :component="Dismiss16Regular" />
            </template>
          </NButton>
        </div>
      </div>
    </NScrollbar>
  </div>
  <BuddyImagePreview v-model:show="previewVisible" v-model:current="previewIndex" :language="language" :sources="previewSources" />
</template>

<style scoped lang="scss">
.composer-resource-strip__scroll {
  min-width: 0;
  margin-bottom: 0.5rem;
}

:deep(.composer-resource-strip__scrollbar) {
  height: auto;
}

:deep(.composer-resource-strip__scrollport) {
  overscroll-behavior-inline: contain;
}

.composer-resource-strip {
  &__folder { width: 2rem; height: 2rem; }
  display: flex;
  flex-wrap: nowrap;
  gap: 0.45rem;

  &__card {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    max-width: min(18rem, 100%);
    flex: 0 0 auto;
    border: 1px solid var(--buddy-border-subtle);
    border-radius: var(--buddy-radius-micro);
    background: var(--buddy-surface-raised);
    padding: 0.4rem;
    font-size: 0.75rem;
  }

  &__details {
    display: grid;
    min-width: 0;
    max-width: 13rem;

    > span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    small {
      color: var(--buddy-text-muted);
    }
  }

  &__content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    border: 0;
    border-radius: var(--buddy-radius-micro);
    background: transparent;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: start;

    img { flex: none; border-radius: var(--buddy-radius-micro); object-fit: cover; }
    &.is-previewable { cursor: pointer; }
    &.is-image { cursor: zoom-in; }
    &:focus-visible { outline: 2px solid var(--buddy-focus-ring); }
  }
}

.composer-resource-strip__card.is-highlighted {
  border-color: var(--buddy-focus-ring);
  background: var(--buddy-accent-surface);
  box-shadow: inset 0 0 0 1px var(--buddy-focus-ring);
}
</style>

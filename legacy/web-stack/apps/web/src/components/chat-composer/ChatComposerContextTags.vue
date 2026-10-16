<script setup lang="ts">
import type { DocumentSelectionDisplayMode } from './attachmentOrdering'
import type { ChatComposerAttachment } from './typing'
import { Close } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getAttachmentDisplayLabel,
  getPanelAttachments,
} from './attachmentOrdering'

const props = defineProps<{
  attachments: ChatComposerAttachment[]
  documentSelectionDisplayMode?: DocumentSelectionDisplayMode | null
  highlightAttachmentId?: string | null
}>()

const emits = defineEmits<{
  remove: [attachmentId: string]
}>()

const { t } = useI18n({ useScope: 'global' })
const panelAttachments = computed(() => getPanelAttachments(props.attachments))

function getDisplayLabel(attachment: ChatComposerAttachment) {
  return getAttachmentDisplayLabel(attachment, {
    documentSelectionDisplayMode: props.documentSelectionDisplayMode,
  })
}
</script>

<template>
  <div v-if="panelAttachments.length" class="chat-composer-context-tags">
    <div
      v-for="attachment in panelAttachments"
      :key="attachment.id"
      class="chat-composer-context-tags__tag"
      :class="{ 'is-highlighted': attachment.id === props.highlightAttachmentId }"
      :title="getDisplayLabel(attachment)"
    >
      <span class="chat-composer-context-tags__label">
        {{ getDisplayLabel(attachment) }}
      </span>
      <button
        class="chat-composer-context-tags__remove"
        type="button"
        :aria-label="t('chat.composer.removeContext')"
        @click.stop="emits('remove', attachment.id)"
      >
        <ElIcon><Close /></ElIcon>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.chat-composer-context-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0.5rem 0.5rem 0;

  .chat-composer-context-tags__tag {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    max-width: min(18rem, 100%);
    height: 1.625rem;
    padding: 0 0.1875rem 0 0.5rem;
    border: 1px solid color-mix(in srgb, var(--brand-primary) 24%, var(--brand-border-base));
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--brand-primary) 7%, var(--brand-bg-surface));
    color: var(--brand-text-primary);
    font-size: 0.75rem;
    line-height: 1;
    cursor: default;
  }

  .chat-composer-context-tags__tag.is-highlighted {
    border-color: color-mix(in srgb, var(--brand-primary) 68%, var(--brand-border-base));
    background: color-mix(in srgb, var(--brand-primary) 14%, var(--brand-bg-surface));
  }

  .chat-composer-context-tags__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-composer-context-tags__remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    padding: 0;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--brand-text-secondary);
    cursor: pointer;

    &:hover {
      color: var(--brand-text-primary);
      background: color-mix(in srgb, var(--brand-fill-light) 78%, transparent);
    }
  }
}
</style>

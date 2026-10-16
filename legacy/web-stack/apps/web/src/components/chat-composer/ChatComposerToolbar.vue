<script setup lang="ts">
import type {
  ChatComposerToolbarEmits,
  ChatComposerToolbarProps,
} from './typing'
import { computed } from 'vue'
import ChatComposerAttachmentMenu from './ChatComposerAttachmentMenu.vue'
import ChatComposerSkillControls from './ChatComposerSkillControls.vue'
import ChatComposerSubmitControls from './ChatComposerSubmitControls.vue'
import ChatComposerWebSearchButton from './ChatComposerWebSearchButton.vue'

const props = defineProps<ChatComposerToolbarProps>()
const emit = defineEmits<ChatComposerToolbarEmits>()
const interactionStreaming = computed(() => Boolean(props.isStreaming || props.isSubmitting))
</script>

<template>
  <div class="chat-composer-toolbar">
    <div class="chat-composer-toolbar__left">
      <ChatComposerAttachmentMenu
        :disabled="props.disabled"
        :is-streaming="interactionStreaming"
        :upload-availability="props.uploadAvailability"
        @open-panel-picker="emit('openPanelPicker')"
        @upload-image="emit('uploadImage')"
        @upload-file="emit('uploadFile')"
      />

      <ChatComposerWebSearchButton
        :disabled="props.disabled"
        :is-streaming="interactionStreaming"
        :web-search-skill-enabled="props.webSearchSkillEnabled"
        :web-search-for-run-enabled="props.webSearchForRunEnabled"
        @update:web-search-for-run-enabled="emit('update:webSearchForRunEnabled', $event)"
      />

      <span class="chat-composer-toolbar__divider" aria-hidden="true" />

      <ChatComposerSkillControls
        :disabled="props.disabled"
        :is-streaming="interactionStreaming"
        :document-assistant-edit-intent="props.documentAssistantEditIntent"
        :document-assistant-skill-enabled="props.documentAssistantSkillEnabled"
        :translator-skill-enabled="props.translatorSkillEnabled"
        :translator-target-language="props.translatorTargetLanguage"
        :skill-command-open-signal="props.skillCommandOpenSignal"
        @update:document-assistant-edit-intent="emit('update:documentAssistantEditIntent', $event)"
        @update:translator-target-language="emit('update:translatorTargetLanguage', $event)"
      />
    </div>

    <ChatComposerSubmitControls
      :selected-model-ref="props.selectedModelRef"
      :model-selection-kind="props.modelSelectionKind"
      :is-submitting="props.isSubmitting"
      :is-streaming="props.isStreaming"
      :disabled="props.disabled"
      :can-send="props.canSend"
      @select-model="emit('selectModel', $event)"
      @send="emit('send')"
      @stop="emit('stop')"
    />
  </div>
</template>

<style scoped lang="scss">
.chat-composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem 0.5rem;

  .chat-composer-toolbar__left,
  :deep(.chat-composer-toolbar__right) {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .chat-composer-toolbar__left {
    flex: 1 1 0;
    overflow: hidden;
  }

  :deep(.chat-composer-toolbar__right) {
    flex: 0 1 11.25rem;
    justify-content: flex-end;
    margin-left: auto;
  }

  :deep(.chat-model-trigger) {
    flex: 1 1 0;
    max-width: 9rem;
    min-width: 0;
  }

  :deep(.chat-composer-toolbar__icon-button),
  :deep(.chat-composer-toolbar__parameter-button),
  :deep(.chat-composer-toolbar__send-button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--brand-fill-light) 36%, transparent);
    color: var(--brand-text-secondary);
    cursor: pointer;

    &:hover:not(:disabled) {
      color: var(--brand-text-primary);
      background: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.48;
    }
  }

  :deep(.chat-composer-toolbar__web-search-button.is-active) {
    border-color: color-mix(in srgb, var(--brand-primary) 42%, transparent);
    background: color-mix(in srgb, var(--brand-primary) 12%, var(--brand-bg-surface));
    color: var(--brand-primary);

    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--brand-primary) 18%, var(--brand-bg-surface));
      color: var(--brand-primary);
    }
  }

  .chat-composer-toolbar__divider {
    width: 1px;
    height: 1.25rem;
    flex: 0 0 auto;
    margin: 0 0.25rem;
    background: color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  }

  :deep(.chat-composer-toolbar__selected-skill) {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 0.625rem;
  }

  :deep(.chat-composer-toolbar__skill-chip) {
    display: inline-flex;
    height: 2rem;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.375rem 0 0.5rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--brand-primary) 10%, var(--brand-bg-surface));
    color: var(--brand-primary);
  }

  :deep(.chat-composer-toolbar__skill-icon) {
    flex: 0 0 auto;
  }

  :deep(.chat-composer-toolbar__skill-close) {
    display: inline-flex;
    width: 1.25rem;
    height: 1.25rem;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: color-mix(in srgb, var(--brand-primary) 72%, var(--brand-text-secondary));
    cursor: pointer;
    font-size: 0.75rem;

    &:hover {
      background: color-mix(in srgb, var(--brand-primary) 14%, transparent);
      color: var(--brand-primary);
    }
  }

  :deep(.chat-composer-toolbar__parameter-button) {
    width: auto;
    max-width: 13rem;
    gap: 0.375rem;
    padding: 0 0.625rem;
    border-color: transparent;
    background: transparent;
    color: var(--brand-text-primary);
  }

  :deep(.chat-composer-toolbar__parameter-edit) {
    display: inline-flex;
    height: 2rem;
    max-width: 16rem;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.375rem 0 0.625rem;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--brand-text-primary);
  }

  :deep(.chat-composer-toolbar__parameter-prefix) {
    flex: 0 0 auto;
    color: var(--brand-text-tertiary);
    font-size: 0.8125rem;
    font-weight: 500;
    line-height: 1;
  }

  :deep(.chat-composer-toolbar__parameter-value) {
    min-width: 0;
    overflow: hidden;
    font-size: 0.875rem;
    font-weight: 400;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :deep(.chat-composer-toolbar__parameter-arrow) {
    flex: 0 0 auto;
    color: var(--brand-text-secondary);
    font-size: 0.8125rem;
  }

  :deep(.chat-composer-toolbar__parameter-input) {
    width: 5.75rem;
    flex: 0 1 5.75rem;
    min-width: 4.5rem;
    overflow: visible;
    line-height: normal;
    white-space: normal;
  }

  :deep(.chat-composer-toolbar__parameter-input .el-input__wrapper) {
    height: 1.75rem;
    padding: 0 0.5rem;
    border-radius: 0.375rem;
    background: var(--brand-bg-surface);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-border-base) 86%, transparent) inset;
  }

  :deep(.chat-composer-toolbar__parameter-input .el-input__inner) {
    color: var(--brand-text-primary);
    font-size: 0.875rem;
    font-weight: 400;
  }

  :deep(.chat-composer-toolbar__parameter-action) {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    border-radius: 0.5rem;
    background: var(--brand-bg-surface);
    color: var(--brand-text-secondary);
    cursor: pointer;
    font-size: 0.875rem;

    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--brand-fill-light) 64%, transparent);
      color: var(--brand-text-primary);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.42;
    }
  }

  :deep(.chat-composer-toolbar__send-button) {
    flex: 0 0 auto;
    border-color: var(--brand-primary);
    background: var(--brand-primary);
    color: #fff;

    &:hover:not(:disabled) {
      color: #fff;
      background: color-mix(in srgb, var(--brand-primary) 88%, #000);
    }
  }

  :deep(.chat-composer-toolbar__send-button.is-stop) {
    border-color: var(--el-color-danger);
    background: var(--el-color-danger);
  }

  :deep(.chat-composer-toolbar__symbol) {
    font-size: 0.95rem;
    font-weight: 700;
    line-height: 1;
  }
}

:global(.chat-composer-toolbar__translate-menu) {
  min-width: 8.5rem;
  padding: 0.25rem;
}

:global(.chat-composer-toolbar__command-menu) {
  min-width: 11rem;
  padding: 0.25rem;
}

:global(.chat-composer-toolbar__upload-menu) {
  min-width: 9rem;
  padding: 0.25rem;
}

:global(.el-dropdown-menu__item.chat-composer-toolbar__translate-item) {
  min-height: 2rem;
  padding: 0 0.625rem;
}

:global(.el-dropdown-menu__item.chat-composer-toolbar__command-item),
:global(.el-dropdown-menu__item.chat-composer-toolbar__command-empty),
:global(.el-dropdown-menu__item.chat-composer-toolbar__upload-item) {
  min-height: 2rem;
  padding: 0 0.625rem;
}

:global(.chat-composer-toolbar__command-main) {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

:global(.el-dropdown-menu__item.chat-composer-toolbar__command-empty) {
  color: var(--brand-text-tertiary);
}

:global(.el-dropdown-menu__item.chat-composer-toolbar__translate-item.is-selected),
:global(.el-dropdown-menu__item.chat-composer-toolbar__command-item.is-selected) {
  color: var(--brand-primary);
  font-weight: 400;
}
</style>

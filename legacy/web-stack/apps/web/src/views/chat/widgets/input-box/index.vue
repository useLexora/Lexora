<script setup lang="ts">
import type { ChatInputBoxProps } from './typing'
import { useI18n } from 'vue-i18n'
import { ChatComposer } from '@/components/chat-composer'
import { useChatInputBox } from '../../composables/useChatInputBox'

const props = withDefaults(defineProps<ChatInputBoxProps>(), {
  isReadonly: false,
  variant: 'dock',
})
const { t } = useI18n({ useScope: 'global' })

const {
  attachments,
  cancelActiveRun,
  composerModelSelectionKind,
  composerSelectedModelRef,
  contentJSON,
  handleSend,
  handleUploadAttachmentFiles,
  handleUploadImageFiles,
  highlightAttachment,
  highlightAttachmentId,
  isSubmitting,
  isStreaming,
  selectComposerModel,
  translatorSkillEnabled,
  translatorTargetLanguage,
  uploadAvailability,
  webSearchForRunEnabled,
  webSearchSkillEnabled,
} = useChatInputBox({
  isReadonly: () => props.isReadonly,
})
</script>

<template>
  <div class="chat-input-box" :class="props.variant === 'hero' ? 'chat-input-box--hero p-0' : 'px-6 py-5'">
    <div class="mx-auto" :class="props.variant === 'hero' ? 'max-w-none' : 'max-w-[var(--page-mode-chat-max-width)]'">
      <ChatComposer
        v-if="!props.isReadonly"
        v-model:attachments="attachments"
        v-model:translator-target-language="translatorTargetLanguage"
        v-model:web-search-for-run-enabled="webSearchForRunEnabled"
        :content-j-s-o-n="contentJSON"
        :selected-model-ref="composerSelectedModelRef"
        :model-selection-kind="composerModelSelectionKind"
        :is-submitting="isSubmitting"
        :is-streaming="isStreaming"
        :highlight-attachment-id="highlightAttachmentId"
        :upload-availability="uploadAvailability"
        :translator-skill-enabled="translatorSkillEnabled"
        :web-search-skill-enabled="webSearchSkillEnabled"
        document-picker-teleport-to=".chat-view__picker-layer"
        @update:content-j-s-o-n="contentJSON = $event"
        @send="handleSend"
        @stop="cancelActiveRun"
        @select-model="selectComposerModel"
        @upload-image-files="handleUploadImageFiles"
        @upload-attachment-files="handleUploadAttachmentFiles"
        @highlight-attachment="highlightAttachment"
      />
      <div v-else class="chat-input-box__readonly flex items-center gap-3 rounded-lg px-4 py-3">
        <span class="chat-input-box__readonly-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <SvgIcon category="ui" icon="chat" size="1rem" />
        </span>
        <div class="min-w-0">
          <div class="text-sm font-medium leading-5 text-main">
            {{ t('chat.input.readonlyTitle') }}
          </div>
          <div class="mt-0.5 text-xs leading-5 text-secondary">
            {{ t('chat.input.readonlyDescription') }}
          </div>
        </div>
      </div>
      <div v-if="props.variant === 'dock' && !props.isReadonly" class="mt-2 text-center text-xs text-secondary-a50">
        {{ t('chat.input.disclaimer') }}
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.chat-input-box {
  border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 80%, transparent);
  background-image: linear-gradient(
    180deg,
    transparent 0%,
    color-mix(in srgb, var(--brand-bg-surface) 88%, var(--brand-bg-body)) 100%
  );

  &.chat-input-box--hero {
    border-top: 0;
    background-image: none;
  }

  &__readonly {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    background: color-mix(in srgb, var(--brand-fill-lighter) 70%, var(--brand-bg-surface));
  }

  &__readonly-icon {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    background: color-mix(in srgb, var(--brand-bg-surface) 88%, transparent);
    color: var(--brand-text-secondary);
  }
}
</style>

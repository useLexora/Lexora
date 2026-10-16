<script setup lang="ts">
import type { ChatUserMessageContentProps } from './typing'
import {
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
  AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
  AGENT_TRANSLATOR_SKILL_KEY,
} from '@haohaoxue/lexora-contracts/agent'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getAttachmentDisplayLabel,
  getDocumentSelectionDisplayModeFromIntent,
  getPanelAttachments,
} from '@/components/chat-composer/attachmentOrdering'
import { serializeChatComposerContent } from '@/components/chat-composer/serialization'
import { SvgIconCategory } from '@/components/svg-icon/typing'

const props = defineProps<ChatUserMessageContentProps>()

const { t } = useI18n({ useScope: 'global' })
const panelAttachments = computed(() => getPanelAttachments(props.message.metadata.attachments))
const hasPanelAttachments = computed(() => panelAttachments.value.length > 0)
const bodyText = computed(() => serializeChatComposerContent(props.message.metadata.contentJSON).content || props.message.content)
const hasBodyText = computed(() => bodyText.value.trim().length > 0)
const documentSelectionDisplayMode = computed(() => {
  const skillInvocation = props.message.metadata.skillInvocation

  return skillInvocation?.skillKey === AGENT_DOCUMENT_ASSISTANT_SKILL_KEY
    ? getDocumentSelectionDisplayModeFromIntent(skillInvocation.intent)
    : null
})
const skillCommand = computed(() => {
  const skillInvocation = props.message.metadata.skillInvocation
  if (skillInvocation?.skillKey === AGENT_TRANSLATOR_SKILL_KEY) {
    return {
      iconCategory: SvgIconCategory.AI,
      icon: 'translate',
      name: t('chat.composer.translate'),
      action: t('chat.messageDisplay.translateTo', { language: skillInvocation.targetLanguage.name }),
    }
  }

  if (skillInvocation?.skillKey === AGENT_DOCUMENT_ASSISTANT_SKILL_KEY) {
    if (skillInvocation.intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
      return {
        iconCategory: SvgIconCategory.UI,
        icon: 'document-tree-file',
        name: t('chat.composer.documentAssistant'),
        action: t('chat.composer.documentAssistantContinue'),
      }
    }

    return {
      iconCategory: SvgIconCategory.UI,
      icon: 'document-tree-file',
      name: t('chat.composer.documentAssistant'),
      action: t('chat.composer.documentAssistantRewrite'),
    }
  }

  return null
})
const hasVisibleContent = computed(() => skillCommand.value !== null || hasPanelAttachments.value || hasBodyText.value)

function getDisplayLabel(attachment: (typeof panelAttachments.value)[number]) {
  return getAttachmentDisplayLabel(attachment, {
    documentSelectionDisplayMode: documentSelectionDisplayMode.value,
  })
}
</script>

<template>
  <div v-if="hasVisibleContent" class="chat-user-message-content">
    <div v-if="skillCommand" class="chat-user-message-content__skill-command">
      <SvgIcon
        class="chat-user-message-content__skill-icon"
        :category="skillCommand.iconCategory"
        :icon="skillCommand.icon"
        size="1em"
      />
      <span class="chat-user-message-content__skill-name">
        {{ skillCommand.name }}
      </span>
      <span class="chat-user-message-content__skill-separator" aria-hidden="true">/</span>
      <span class="chat-user-message-content__skill-action">
        {{ skillCommand.action }}
      </span>
    </div>

    <div v-if="hasPanelAttachments" class="chat-user-message-content__contexts">
      <span
        v-for="attachment in panelAttachments"
        :key="attachment.id"
        class="chat-user-message-content__context"
        :title="getDisplayLabel(attachment)"
      >
        {{ getDisplayLabel(attachment) }}
      </span>
    </div>
    <div v-if="hasBodyText" class="chat-user-message-content__body">
      {{ bodyText }}
    </div>
  </div>
</template>

<style scoped lang="scss">
.chat-user-message-content {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;

  .chat-user-message-content__contexts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .chat-user-message-content__context {
    display: inline-flex;
    max-width: 11rem;
    min-height: 1.375rem;
    align-items: center;
    overflow: hidden;
    padding: 0.125rem 0.375rem;
    border: 1px solid color-mix(in srgb, #fff 24%, transparent);
    border-radius: 0.5rem;
    background: color-mix(in srgb, #fff 10%, transparent);
    color: color-mix(in srgb, #fff 84%, transparent);
    font-size: 0.75rem;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-user-message-content__skill-command {
    display: inline-flex;
    width: fit-content;
    max-width: 100%;
    min-height: 1.25rem;
    align-items: center;
    gap: 0.25rem;
    color: color-mix(in srgb, #fff 86%, transparent);
    font-size: 0.75rem;
    line-height: 1.25;
  }

  .chat-user-message-content__skill-icon {
    display: block;
    flex: 0 0 auto;
    color: color-mix(in srgb, #fff 62%, transparent);
  }

  .chat-user-message-content__skill-separator {
    flex: 0 0 auto;
    color: color-mix(in srgb, #fff 62%, transparent);
    line-height: 1.25;
  }

  .chat-user-message-content__skill-name,
  .chat-user-message-content__skill-action {
    min-width: 0;
    overflow: hidden;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-user-message-content__skill-name {
    flex: 0 0 auto;
    font-weight: 600;
  }

  .chat-user-message-content__skill-action {
    flex: 1 1 auto;
  }

  .chat-user-message-content__body {
    line-height: 1.6;
    white-space: pre-wrap;
  }
}
</style>

<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyQuoteReference } from '@buddy-shared/conversation/buddyInputMaterial'

import type { BuddyPromptDirective } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { isRetiredBuddyPromptCommand } from '@buddy-shared/conversation/buddyChatCommands'
import { resolveBuddyQuoteReference } from '@buddy-shared/conversation/buddyInputMaterial'
import { buddyPromptDirectiveToText } from '@buddy-shared/conversation/buddyUserContent'
import { computed, useTemplateRef } from 'vue'
import BuddyChatMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import { resolveBuddyAttachmentPreviewUrl } from '../../model/attachments/chatAttachmentView'
import { getInputMaterialViews, inputMaterialLabel } from '../../model/materials/inputMaterialView'
import { getChatMessageDisplayText, getChatMessageImageLabels, getChatMessageUserContent } from '../../model/transcript/chatMessageContent'
import ChatInputMaterialStrip from '../materials/ChatInputMaterialStrip.vue'
import BuddyChatResourceReference from './BuddyChatResourceReference.vue'
import { tryUseChatContent } from './chatContentContext'

const props = withDefaults(defineProps<{
  final?: boolean
  hiddenArtifacts?: readonly LocalArtifact[]
  language: BuddyLocale
  message: LocalMessage
  writeClipboardText: (text: string) => Promise<void>
}>(), {
  final: true,
  hiddenArtifacts: () => [],
})

const chatContent = tryUseChatContent()
const materialStrip = useTemplateRef('materialStrip')
const text = computed(() => getChatMessageDisplayText(
  props.message,
  props.hiddenArtifacts,
))
const hasText = computed(() => text.value.trim().length > 0)
const structuredUserContent = computed(() => getChatMessageUserContent(props.message))
const imageLabels = computed(() => getChatMessageImageLabels(props.message))
const attachmentByResourceId = computed(() => {
  const attachmentsById = new Map(
    props.message.attachments.map(attachment => [attachment.attachmentId, attachment]),
  )
  return new Map(structuredUserContent.value?.resourceSnapshots.flatMap((snapshot) => {
    const attachment = attachmentsById.get(snapshot.attachmentId ?? '') ?? snapshot.localReference
    return attachment ? [[snapshot.resourceId, attachment] as const] : []
  }) ?? [])
})
const materials = computed(() => {
  const structured = structuredUserContent.value
  if (!structured)
    return props.message.attachments.map(attachment => ({ kind: 'resource' as const, id: attachment.attachmentId, resource: { ...attachment, state: 'ready' as const }, previewUrl: resolveBuddyAttachmentPreviewUrl(attachment), imageLabel: imageLabels.value.get(attachment.attachmentId) }))
  return getInputMaterialViews(structured.userContent, (id) => {
    const attachment = attachmentByResourceId.value.get(id)
    return attachment ? { resource: { ...attachment, state: 'ready' as const }, previewUrl: 'attachmentId' in attachment ? resolveBuddyAttachmentPreviewUrl(attachment) : null, imageLabel: imageLabels.value.get(id) } : undefined
  })
})
const hasStructuredBody = computed(() => hasText.value || structuredUserContent.value?.userContent.body.some(paragraph => paragraph.content.some(node => node.type === 'quote_ref' || node.type === 'session_ref')))

function quoteLabel(reference: BuddyQuoteReference) {
  const content = structuredUserContent.value?.userContent
  const material = content && resolveBuddyQuoteReference(content, reference)
  return material && material.kind !== 'resource' ? inputMaterialLabel(material, props.language) : ''
}

function directiveText(directive: BuddyPromptDirective): string {
  return buddyPromptDirectiveToText(directive)
}

function sessionReferenceTitle(sessionId: string): string {
  return structuredUserContent.value?.userContent.sessionReferences?.find(reference => reference.id === sessionId)?.title ?? sessionId
}

function isRetiredDirective(directive: BuddyPromptDirective): boolean {
  return directive.directive === 'slash_command' && isRetiredBuddyPromptCommand(directive.value)
}

function handleMarkdownLink(href: string) {
  if (!chatContent)
    return
  if (chatContent.canPreviewFile(href))
    chatContent.previewFile(href)
}
</script>

<template>
  <div
    class="buddy-chat-message-content grid w-fit max-w-[min(42rem,_92%)] min-w-0 gap-[0.45rem] bg-transparent p-0"
    :class="`is-${message.role}`"
    :data-quote-source="message.role === 'user' || message.role === 'assistant' ? JSON.stringify({ conversationId: message.conversationId, branchId: message.branchId, messageId: message.id, runId: message.runId, role: message.role }) : undefined"
  >
    <ChatInputMaterialStrip ref="materialStrip" :materials="materials" :language="language" expanded :align-end="message.role === 'user'" />
    <div
      v-if="structuredUserContent && hasStructuredBody"
      class="buddy-chat-message-content__text buddy-chat-message-content__structured-body"
    >
      <p
        v-for="(paragraph, paragraphIndex) in structuredUserContent.userContent.body"
        :key="paragraphIndex"
      >
        <template v-for="(node, nodeIndex) in paragraph.content" :key="nodeIndex">
          <span v-if="node.type === 'text'">{{ node.text }}</span>
          <br v-else-if="node.type === 'hard_break'">
          <span
            v-else-if="node.type === 'prompt_directive' && isRetiredDirective(node)"
          >{{ directiveText(node) }}</span>
          <span
            v-else-if="node.type === 'prompt_directive'"
            class="buddy-chat-message-content__directive"
          >{{ directiveText(node) }}</span>
          <span
            v-else-if="node.type === 'session_ref'"
            class="buddy-chat-message-content__session-reference inline-block max-w-[min(24rem,_100%)] overflow-hidden text-ellipsis"
            data-quote-exclude
          >@{{ sessionReferenceTitle(node.sessionId) }}</span>
          <button
            v-else-if="node.type === 'quote_ref'"
            type="button"
            class="buddy-chat-message-content__quote-reference buddy-chat-resource-reference border-0 bg-transparent p-0 font-[inherit] text-[inherit] cursor-pointer"
            @click="materialStrip?.highlightMaterial({ kind: node.quoteKind === 'message' ? 'message_quote' : 'resource_quote', id: node.quoteId })"
          >
            @{{ quoteLabel(node) }}
          </button>
          <span
            v-else-if="node.type === 'actor_ref'"
            class="buddy-chat-message-content__directive"
            :data-actor-id="node.actorId"
          >@{{ node.name }}</span>
          <BuddyChatResourceReference
            v-else-if="node.type === 'resource_ref' && attachmentByResourceId.get(node.resourceId)"
            :attachment="attachmentByResourceId.get(node.resourceId)!"
            :image-label="imageLabels.get(node.resourceId)"
            :language="language"
            :resource-id="node.resourceId"
            @locate="materialStrip?.highlightResource($event)"
          />
        </template>
      </p>
    </div>
    <div
      v-else-if="hasText && message.role === 'user'"
      class="buddy-chat-message-content__text is-plain-text"
    >
      {{ text }}
    </div>
    <BuddyChatMarkdownContent
      v-else-if="hasText"
      class="buddy-chat-message-content__text"
      :content="text"
      :final="final"
      :language="language"
      :write-clipboard-text="writeClipboardText"
      :open-web-link="chatContent?.openWebLink"
      @open-link="handleMarkdownLink"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/shared/ui/highlight/inlineHighlightToken' as highlight;

.buddy-chat-message-content {
  &.is-user {
    justify-items: end;
  }

  &.is-assistant,
  &.is-tool {
    width: 100%;
    max-width: 100%;
    justify-items: start;
  }
}

.buddy-chat-message-content__text {
  width: fit-content;
  max-width: 100%;
  min-width: 0;
  border-radius: 0.9rem;
  background: var(--buddy-surface-raised);
  color: var(--buddy-text-primary);
  line-height: 1.7;
  padding: 0.75rem 0.95rem;
  overflow-wrap: anywhere;

  &.is-plain-text {
    white-space: pre-wrap;
  }

  .is-user & {
    justify-self: end;
    background: var(--buddy-user-message-surface);
    font-family: var(--buddy-font-body);
    font-size: var(--buddy-chat-user-font-size);
    line-height: var(--buddy-chat-final-line-height);
  }

  .is-assistant &,
  .is-tool & {
    width: 100%;
    border-radius: 0;
    background: transparent;
    padding: 0.05rem 0;
  }

  .is-tool & {
    color: var(--buddy-text-secondary);
    font-size: 0.75rem;
  }

  :deep(> :first-child) {
    margin-top: 0;
  }

  :deep(> :last-child) {
    margin-bottom: 0;
  }
}

.buddy-chat-message-content__structured-body {
  p {
    margin: 0;
    white-space: pre-wrap;

    & + p {
      margin-top: 0.35rem;
    }
  }
}

.buddy-chat-message-content__directive {
  @include highlight.inline-highlight-token;
}

.buddy-chat-message-content__session-reference,
.buddy-chat-message-content__quote-reference {
  @include highlight.inline-highlight-token;
  vertical-align: bottom;
}
</style>

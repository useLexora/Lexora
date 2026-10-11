<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyPromptDirective } from '@buddy-shared/conversation/buddyUserContent'

import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { isRetiredBuddyPromptCommand } from '@buddy-shared/conversation/buddyChatCommands'
import { buddyPromptDirectiveToText, getBuddyUserContentResourceIds } from '@buddy-shared/conversation/buddyUserContent'
import { NScrollbar, NTooltip } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import BuddyChatMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import BuddyImagePreview from '@/shared/ui/media/BuddyImagePreview.vue'
import { resolveBuddyAttachmentPreviewUrl } from '../../model/attachments/chatAttachmentView'
import { getChatMessageDisplayText, getChatMessageImageLabels, getChatMessageUserContent } from '../../model/transcript/chatMessageContent'
import { useResourceHighlight } from '../attachments/useResourceHighlight'
import ChatQuoteStrip from '../quotes/ChatQuoteStrip.vue'
import ChatSessionReferenceStrip from '../references/ChatSessionReferenceStrip.vue'
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

const { t } = useBuddyI18n(() => props.language)
const chatContent = tryUseChatContent()
const attachmentTrack = useTemplateRef<HTMLDivElement>('attachmentTrack')
const attachmentScrollport = computed(() => attachmentTrack.value?.closest<HTMLElement>('.buddy-chat-message-content__attachment-scrollport') ?? null)
const { highlightedResourceId, highlightResource } = useResourceHighlight(attachmentTrack)
const failedAttachmentIds = shallowRef<ReadonlySet<string>>(new Set())
const previewIndex = shallowRef(0)
const previewOpen = shallowRef(false)
let previewTrackScrollLeft = 0
const text = computed(() => getChatMessageDisplayText(
  props.message,
  props.hiddenArtifacts,
))
const hasText = computed(() => text.value.trim().length > 0)
const structuredUserContent = computed(() => getChatMessageUserContent(props.message))
const imageLabels = computed(() => getChatMessageImageLabels(props.message))
const allAttachmentViews = computed(() => props.message.attachments.map(attachment => ({
  attachment,
  attachmentId: attachment.attachmentId,
  previewUrl: resolveBuddyAttachmentPreviewUrl(attachment),
  resourceId: attachment.attachmentId,
})))
const attachmentByResourceId = computed(() => {
  const attachmentsById = new Map(
    props.message.attachments.map(attachment => [attachment.attachmentId, attachment]),
  )
  return new Map(structuredUserContent.value?.resourceSnapshots.flatMap((snapshot) => {
    const attachment = attachmentsById.get(snapshot.attachmentId ?? '') ?? snapshot.localReference
    return attachment ? [[snapshot.resourceId, attachment] as const] : []
  }) ?? [])
})
const attachmentViews = computed(() => {
  const structured = structuredUserContent.value
  if (!structured)
    return allAttachmentViews.value
  return getBuddyUserContentResourceIds(structured.userContent).flatMap((resourceId) => {
    const attachment = attachmentByResourceId.value.get(resourceId)
    return attachment
      ? [{ attachment, attachmentId: 'attachmentId' in attachment ? attachment.attachmentId : undefined, previewUrl: 'attachmentId' in attachment ? resolveBuddyAttachmentPreviewUrl(attachment) : null, resourceId }]
      : []
  })
})
const previewableAttachmentViews = computed(() => allAttachmentViews.value.filter(view => (
  view.previewUrl && !failedAttachmentIds.value.has(view.attachment.attachmentId)
)))
const previewSources = computed(() => previewableAttachmentViews.value.flatMap(
  view => view.previewUrl ? [view.previewUrl] : [],
))

function markPreviewFailed(attachmentId: string) {
  failedAttachmentIds.value = new Set([...failedAttachmentIds.value, attachmentId])
}

function openPreview(attachmentId: string | undefined) {
  if (!attachmentId)
    return
  const index = previewableAttachmentViews.value.findIndex(
    view => view.attachment.attachmentId === attachmentId,
  )
  if (index < 0)
    return
  previewTrackScrollLeft = attachmentScrollport.value?.scrollLeft ?? 0
  previewIndex.value = index
  previewOpen.value = true
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

async function updatePreviewOpen(open: boolean) {
  previewOpen.value = open
  if (open)
    return
  await nextTick()
  await previewLeaveTransition()
  attachmentScrollport.value?.scrollTo({ left: previewTrackScrollLeft })
}

function previewLeaveTransition(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 320))
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
    <BuddyImagePreview
      v-model:current="previewIndex"
      v-model:show="previewOpen"
      :language="language"
      :sources="previewSources"
      @update:show="updatePreviewOpen"
    />
    <ChatQuoteStrip :quotes="structuredUserContent?.userContent.quotes ?? []" :language="language" />
    <ChatSessionReferenceStrip :references="structuredUserContent?.userContent.sessionReferences ?? []" :language="language" />
    <NScrollbar
      v-if="attachmentViews.length"
      class="buddy-chat-message-content__attachment-scrollbar"
      container-class="buddy-chat-message-content__attachment-scrollport"
      content-style="min-width: 100%"
      trigger="hover"
      x-scrollable
    >
      <div
        ref="attachmentTrack"
        class="buddy-chat-message-content__attachments flex flex-nowrap gap-[0.45rem] pb-2"
      >
        <figure
          v-for="view in attachmentViews"
          :id="`buddy-resource-${view.resourceId}`"
          :key="view.resourceId"
          class="buddy-chat-message-content__attachment relative grid box-border w-44 min-w-0 grid-cols-[minmax(0,_1fr)] m-0 border-1 border-solid border-border rounded-micro bg-raised p-1"
          :class="{ 'is-highlighted': highlightedResourceId === view.resourceId }"
          :data-resource-card="view.resourceId"
          @click="openPreview(view.attachmentId)"
        >
          <button
            v-if="view.previewUrl && view.attachmentId && !failedAttachmentIds.has(view.attachmentId)"
            class="buddy-chat-message-content__preview-trigger block overflow-hidden border-0 p-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
            type="button"
            :aria-label="t('desktop.imagePreview.open', { name: view.attachment.name })"
            @click.stop="openPreview(view.attachmentId)"
          >
            <img
              :src="view.previewUrl"
              :alt="view.attachment.name"
              height="112"
              loading="lazy"
              width="160"
              @error="markPreviewFailed(view.attachmentId)"
            >
          </button>
          <div v-else class="buddy-chat-message-content__file grid place-items-center text-muted p-[0.65rem]">
            <FolderIcon v-if="view.attachment.kind === 'directory'" class="buddy-chat-message-content__folder" />
            <FileIcon v-else :name="view.attachment.name" size="preview" />
          </div>
          <figcaption class="flex min-w-0 items-baseline gap-[0.4rem] pt-[0.45rem] pr-[0.35rem] pb-[0.3rem] pl-[0.35rem] text-fg text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)] text-left">
            <NTooltip :delay="300" :style="{ maxWidth: '24rem', overflowWrap: 'anywhere' }">
              <template #trigger>
                <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {{ imageLabels.get(view.resourceId) ?? view.attachment.name }}
                </span>
              </template>
              {{ 'path' in view.attachment ? view.attachment.path : view.attachment.name }}
            </NTooltip>
            <span v-if="view.attachment.kind !== 'directory'" class="flex-none text-muted whitespace-nowrap">{{ formatFileSize(view.attachment.sizeBytes) }}</span>
          </figcaption>
        </figure>
      </div>
    </NScrollbar>
    <div
      v-if="structuredUserContent && hasText"
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
            :title="sessionReferenceTitle(node.sessionId)"
          >@{{ sessionReferenceTitle(node.sessionId) }}</span>
          <BuddyChatResourceReference
            v-else-if="attachmentByResourceId.get(node.resourceId)"
            :attachment="attachmentByResourceId.get(node.resourceId)!"
            :image-label="imageLabels.get(node.resourceId)"
            :language="language"
            :resource-id="node.resourceId"
            @locate="highlightResource"
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
      @open-link="handleMarkdownLink"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/shared/ui/highlight/inlineHighlightToken' as highlight;

.buddy-chat-message-content {
  &__folder { width: 3rem; height: 3rem; }

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

:deep(.buddy-chat-message-content__attachment-scrollbar) {
  width: 100%;
  height: auto;
  max-width: 100%;
  min-width: 0;
}

:deep(.buddy-chat-message-content__attachment-scrollport) {
  overscroll-behavior-inline: contain;
}

.buddy-chat-message-content__attachment {
  flex: 0 0 11rem;

  > .resource-reference-badge {
    position: absolute;
    top: 0.35rem;
    left: 0.35rem;
    z-index: 1;
    pointer-events: none;
  }

  &.is-highlighted {
    border-color: var(--buddy-focus-ring);
    box-shadow: inset 0 0 0 1px var(--buddy-focus-ring);

    figcaption {
      color: var(--buddy-accent-on-surface);
    }
  }

  .buddy-chat-message-content__preview-trigger,
  .buddy-chat-message-content__file {
    box-sizing: border-box;
    width: 100%;
    height: 7rem;
    border: 0;
    border-radius: 0.25rem;
    background: var(--buddy-surface-subtle);
  }
}

.buddy-chat-message-content.is-user .buddy-chat-message-content__attachment:first-child {
  margin-inline-start: auto;
}

.buddy-chat-message-content__preview-trigger {
  cursor: zoom-in;

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 120ms ease;
  }

  &:hover img {
    transform: scale(1.025);
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

.buddy-chat-message-content__session-reference {
  @include highlight.inline-highlight-token;
  vertical-align: bottom;
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-message-content__preview-trigger img {
    transition: none;
  }
}
</style>

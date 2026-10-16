<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { ChatMessageListProps } from './typing'
import type { ChatMessage } from '@/apis/chat'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChatAssistantAvatar,
  ChatMessageActions,
  ChatUserMessageContent,
} from '@/components/chat-message'
import { useDynamicChatVirtualList } from '@/composables/chat/useDynamicChatVirtualList'
import {
  getUserMessageDeliveryLabel,
  shouldShowAssistantPending,
  shouldShowUserMessageDelivery,
} from '@/composables/chat/utils/chat-message-display'
import dayjs from '@/utils/dayjs'
import ChatMessageUsageAction from '../../components/message-usage-action'
import { useChatMessageList } from '../../composables/useChatMessageList'

interface ChatMessageDayDividerItem {
  kind: 'day-divider'
  id: string
  label: string
}

interface ChatMessageContentItem {
  kind: 'message'
  id: string
  message: ChatMessage
}

type ChatMessageListItem = ChatMessageDayDividerItem | ChatMessageContentItem

const props = withDefaults(defineProps<ChatMessageListProps>(), {
  isReadonly: false,
})
const { t } = useI18n({ useScope: 'global' })
const scrollContainerRef = useTemplateRef<HTMLElement>('scrollContainerRef')
const {
  assistantName,
  cancelEditMessage,
  composerModelSelectionKind,
  composerSelectedModelRef,
  copyMessage,
  editingAttachments,
  editingContentJSON,
  editingHighlightAttachmentId,
  editingWebSearchForRunEnabled,
  emptyIcon,
  emptyIconStateClass,
  getMessageRoleClass,
  handleEditUploadAttachmentFiles,
  handleEditUploadImageFiles,
  highlightEditingAttachment,
  isBusy,
  isEditingMessage,
  isMessageCopied,
  isConfigured,
  listKey,
  messages,
  retryAssistantMessage,
  selectComposerModel,
  startEditMessage,
  submitEditMessage,
  switchToBranch,
  uploadAvailability,
  webSearchSkillEnabled,
} = useChatMessageList({
  isReadonly: () => props.isReadonly,
})
const messageItems = computed<ChatMessageListItem[]>(() => createMessageListItems(messages.value))
const emptyTitle = computed(() => {
  if (props.isReadonly) {
    return t('chat.messageList.emptyReadonlyTitle')
  }

  return isConfigured.value ? t('chat.messageList.emptyConfiguredTitle') : t('chat.messageList.emptyUnconfiguredTitle')
})
const emptyDescription = computed(() => {
  if (props.isReadonly) {
    return t('chat.messageList.emptyReadonlyDescription')
  }

  return isConfigured.value
    ? t('chat.messageList.emptyConfiguredDescription')
    : t('chat.messageList.emptyUnconfiguredDescription')
})
const {
  handleScroll,
  setItemElement,
  spacerStyle,
  virtualItems,
} = useDynamicChatVirtualList({
  items: messageItems,
  listKey,
  scrollContainerRef,
  estimateSize: 132,
  overscan: 10,
  bottomThreshold: 96,
  getItemKey: item => item.id,
})

function setVirtualItemElement(key: string, element: Element | ComponentPublicInstance | null) {
  setItemElement(key, element instanceof Element ? element : null)
}

function createMessageListItems(sourceMessages: ChatMessage[]): ChatMessageListItem[] {
  const items: ChatMessageListItem[] = []
  let previousDayKey: string | null = null

  for (const message of sourceMessages) {
    const day = dayjs(message.createdAt)
    const dayKey = day.isValid() ? day.format('YYYY-MM-DD') : 'unknown'

    if (dayKey !== previousDayKey) {
      items.push({
        kind: 'day-divider',
        id: `day:${dayKey}`,
        label: formatDayDividerLabel(message.createdAt),
      })
      previousDayKey = dayKey
    }

    items.push({
      kind: 'message',
      id: `message:${message.id}`,
      message,
    })
  }

  return items
}

function formatDayDividerLabel(value: string): string {
  const time = dayjs(value)
  if (!time.isValid()) {
    return t('chat.messageList.older')
  }

  const today = dayjs()
  if (time.isSame(today, 'day')) {
    return t('chat.messageList.today')
  }

  if (time.isSame(today.subtract(1, 'day'), 'day')) {
    return t('chat.messageList.yesterday')
  }

  if (time.isSame(today, 'year')) {
    return time.format(t('date.chatDayCurrentYear'))
  }

  return time.format(t('date.chatDayFullYear'))
}

function formatMessageSentAt(value: string): string {
  const time = dayjs(value)
  if (!time.isValid()) {
    return ''
  }

  const today = dayjs()
  if (time.isSame(today, 'day')) {
    return time.format('HH:mm')
  }

  if (time.isSame(today.subtract(1, 'day'), 'day')) {
    return t('chat.messageList.yesterdayAt', { time: time.format('HH:mm') })
  }

  if (time.isSame(today, 'year')) {
    return time.format('M-D HH:mm')
  }

  return time.format('YYYY-M-D HH:mm')
}
</script>

<template>
  <div
    ref="scrollContainerRef"
    class="chat-message-list flex-1 overflow-y-auto px-6 py-4"
    :data-message-count="messages.length"
    @scroll="handleScroll"
  >
    <div v-if="messages.length === 0" class="flex h-full items-center justify-center">
      <div class="text-center">
        <div class="chat-message-list__empty-icon mx-auto mb-4 flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-2xl" :class="emptyIconStateClass">
          <SvgIcon
            :category="emptyIcon.category"
            :icon="emptyIcon.icon"
            size="2.5rem"
            class="block"
          />
        </div>
        <div class="text-lg text-secondary">
          {{ emptyTitle }}
        </div>
        <div class="mt-1 text-sm text-secondary-a60">
          {{ emptyDescription }}
        </div>
      </div>
    </div>

    <div v-else class="chat-message-list__virtual-shell mx-auto max-w-[var(--page-mode-chat-max-width)]">
      <div
        class="chat-message-list__virtual-space"
        :style="spacerStyle"
      >
        <div
          v-for="virtual in virtualItems"
          :key="virtual.key"
          :ref="element => setVirtualItemElement(virtual.key, element)"
          class="chat-message-list__virtual-item"
          :class="{ 'is-day-divider': virtual.item.kind === 'day-divider' }"
          :style="virtual.style"
        >
          <div v-if="virtual.item.kind === 'day-divider'" class="chat-message-list__day-divider">
            {{ virtual.item.label }}
          </div>

          <div
            v-else
            class="chat-message-list__row flex gap-3"
            :class="[getMessageRoleClass(virtual.item.message.role), virtual.item.message.role === 'user' ? 'justify-end' : 'justify-start']"
          >
            <div
              v-if="virtual.item.message.role === 'assistant'"
              class="mt-1 shrink-0"
            >
              <ChatAssistantAvatar :pending="shouldShowAssistantPending(virtual.item.message)" />
            </div>

            <div v-if="virtual.item.message.role === 'assistant'" class="chat-message-list__assistant-content flex min-w-0 max-w-[80%] flex-col gap-2">
              <div class="chat-message-list__meta assistant">
                <span class="chat-message-list__author">{{ assistantName }}</span>
                <span class="chat-message-list__ai-tag">AI</span>
                <span class="chat-message-list__sent-at">{{ formatMessageSentAt(virtual.item.message.createdAt) }}</span>
              </div>

              <ChatAssistantMessage :message="virtual.item.message" variant="global" :show-usage-summary="false" />

              <ChatMessageActions
                class="chat-message-list__actions assistant flex items-center justify-start gap-1.5"
                :message="virtual.item.message"
                :copied="isMessageCopied(virtual.item.message)"
                :is-streaming="isBusy"
                :is-readonly="props.isReadonly"
                show-retry
                variant="global"
                @copy-message="copyMessage"
                @retry-assistant-message="retryAssistantMessage"
                @switch-branch="switchToBranch"
              >
                <template #after>
                  <ChatMessageUsageAction :message="virtual.item.message" />
                </template>
              </ChatMessageActions>
            </div>

            <div
              v-else
              class="chat-message-list__user-content flex min-w-0 max-w-[80%] flex-col items-end gap-2"
              :class="{ 'is-editing': isEditingMessage(virtual.item.message) }"
            >
              <div class="chat-message-list__meta user">
                <span class="chat-message-list__sent-at">{{ formatMessageSentAt(virtual.item.message.createdAt) }}</span>
              </div>

              <div v-if="isEditingMessage(virtual.item.message)" class="chat-message-list__edit-box">
                <ChatComposer
                  v-model:web-search-for-run-enabled="editingWebSearchForRunEnabled"
                  :content-j-s-o-n="editingContentJSON"
                  :attachments="editingAttachments"
                  :selected-model-ref="composerSelectedModelRef"
                  :model-selection-kind="composerModelSelectionKind"
                  :upload-availability="uploadAvailability"
                  :web-search-skill-enabled="webSearchSkillEnabled"
                  :disabled="isBusy || props.isReadonly"
                  :highlight-attachment-id="editingHighlightAttachmentId"
                  document-picker-teleport-to=".chat-view__picker-layer"
                  @update:content-j-s-o-n="editingContentJSON = $event"
                  @update:attachments="editingAttachments = $event"
                  @send="submitEditMessage(virtual.item.message, $event)"
                  @select-model="selectComposerModel"
                  @highlight-attachment="highlightEditingAttachment"
                  @upload-image-files="handleEditUploadImageFiles"
                  @upload-attachment-files="handleEditUploadAttachmentFiles"
                />
                <div class="chat-message-list__edit-actions mt-3 flex justify-end gap-2">
                  <ElButton round @click="cancelEditMessage">
                    {{ t('chat.messageList.cancel') }}
                  </ElButton>
                </div>
              </div>

              <template v-else>
                <div class="chat-message-list__bubble user rounded-lg px-3 py-2 text-sm leading-[1.625] break-words">
                  <ChatUserMessageContent :message="virtual.item.message" />
                </div>
                <div
                  v-if="shouldShowUserMessageDelivery(virtual.item.message)"
                  class="chat-message-list__user-delivery text-xs leading-4"
                  :class="virtual.item.message.status === 'failed' ? 'is-failed' : 'is-pending'"
                >
                  {{ getUserMessageDeliveryLabel(virtual.item.message) }}
                </div>
                <ChatMessageActions
                  v-if="!shouldShowUserMessageDelivery(virtual.item.message)"
                  class="chat-message-list__actions user flex items-center justify-end gap-1.5"
                  :message="virtual.item.message"
                  :copied="isMessageCopied(virtual.item.message)"
                  :is-streaming="isBusy"
                  :is-readonly="props.isReadonly"
                  show-edit
                  variant="global"
                  @copy-message="copyMessage"
                  @edit-message="startEditMessage"
                  @switch-branch="switchToBranch"
                >
                  <template #after>
                    <ChatMessageUsageAction :message="virtual.item.message" />
                  </template>
                </ChatMessageActions>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.chat-message-list {
  overflow-anchor: none;

  .chat-message-list__empty-icon {
    &.configured {
      background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
    }

    &.idle {
      background: color-mix(in srgb, var(--brand-border-base) 18%, transparent);
    }
  }

  .chat-message-list__user-content {
    &.is-editing {
      width: 100%;
      max-width: 100%;
    }
  }

  .chat-message-list__virtual-item {
    box-sizing: border-box;
    padding-bottom: 1rem;

    &.is-day-divider {
      padding: 1.25rem 0 1rem;
    }
  }

  .chat-message-list__day-divider {
    text-align: center;
    color: var(--brand-text-tertiary);
    font-size: 0.875rem;
    line-height: 1.25rem;
    font-variant-numeric: tabular-nums;
  }

  .chat-message-list__meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 1.25rem;
    color: var(--brand-text-tertiary);
    font-size: 0.8125rem;
    line-height: 1.25rem;
    font-variant-numeric: tabular-nums;

    &.user {
      justify-content: flex-end;
    }
  }

  .chat-message-list__author {
    color: var(--brand-text-secondary);
    font-weight: 500;
  }

  .chat-message-list__ai-tag {
    display: inline-flex;
    align-items: center;
    height: 1.125rem;
    border-radius: 999px;
    padding: 0 0.375rem;
    background: color-mix(in srgb, var(--brand-fill-light) 78%, transparent);
    color: var(--brand-text-secondary);
    font-size: 0.6875rem;
    line-height: 1;
  }

  .chat-message-list__bubble {
    overflow-wrap: break-word;

    &.user {
      max-width: 100%;
      white-space: pre-wrap;
      color: #fff;
      background: var(--brand-primary);
    }
  }

  .chat-message-list__user-delivery {
    color: var(--brand-text-tertiary);

    &.is-failed {
      color: var(--el-color-danger);
    }
  }

  .chat-message-list__actions {
    color: var(--brand-text-secondary);
    opacity: 0;
    pointer-events: none;
    transform: translateY(-0.125rem);
    transition:
      opacity 160ms ease,
      transform 160ms ease;

    :deep(.el-button.is-text:not(.is-disabled):not(.chat-message-actions__branch-button):hover),
    :deep(.el-button.is-text:not(.is-disabled):not(.chat-message-actions__branch-button):focus-visible) {
      color: var(--brand-text-primary);
      background-color: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
    }

    :deep(.el-button.is-text:not(.is-disabled):active) {
      background-color: color-mix(in srgb, var(--brand-fill-light) 92%, transparent);
    }
  }

  .chat-message-list__assistant-content:hover > .chat-message-list__actions,
  .chat-message-list__assistant-content:focus-within > .chat-message-list__actions,
  .chat-message-list__user-content:hover .chat-message-list__actions,
  .chat-message-list__user-content:focus-within .chat-message-list__actions {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }

  .chat-message-list__edit-box {
    width: 100%;
  }

}

@media (hover: none) {
  .chat-message-list {
    .chat-message-list__actions {
      opacity: 1;
      pointer-events: auto;
      transform: none;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .chat-message-list {
    .chat-message-list__actions {
      transition: none;
    }
  }
}
</style>

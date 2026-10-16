<script setup lang="ts">
import type { ChatMessageActionsEmits, ChatMessageActionsProps } from './typing'
import {
  ArrowLeft,
  ArrowRight,
  EditPen,
  RefreshRight,
} from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CopyStateIcon from '@/components/copy-state-icon/CopyStateIcon.vue'
import { getMessageText } from '@/composables/chat/utils/chat-message-display'

const props = withDefaults(defineProps<ChatMessageActionsProps>(), {
  copied: false,
  isReadonly: false,
  isStreaming: false,
  showEdit: false,
  showRetry: false,
  variant: 'global',
})

const emit = defineEmits<ChatMessageActionsEmits>()

const { t } = useI18n({ useScope: 'global' })
const isAssistant = computed(() => props.message.role === 'assistant')
const canCopy = computed(() => props.message.role === 'user' || Boolean(getMessageText(props.message)))
const copyTooltip = computed(() => isAssistant.value ? t('chat.messageList.copyReply') : t('chat.messageList.copyMessage'))
const copiedLabel = computed(() => isAssistant.value ? t('chat.messageList.replyCopied') : t('chat.messageList.messageCopied'))
const actionButtonClass = computed(() => [
  'chat-message-actions__button',
  `chat-message-actions__button--${props.variant}`,
])
const branchButtonClass = computed(() => [
  'chat-message-actions__branch-button',
  `chat-message-actions__branch-button--${props.variant}`,
])
const branchIndexClass = computed(() => props.variant === 'docs' ? 'min-w-[2.125rem]' : 'min-w-[2.25rem]')

function emitSwitchBranch(messageId: string | null) {
  if (!messageId) {
    return
  }

  emit('switchBranch', messageId)
}
</script>

<template>
  <div
    class="chat-message-actions"
    :class="[`chat-message-actions--${props.variant}`, `chat-message-actions--${props.message.role}`]"
  >
    <ElTooltip :content="copyTooltip" placement="bottom">
      <ElButton
        text
        class="chat-message-actions__copy-button" :class="[actionButtonClass, { 'is-copied': props.copied }]"
        :disabled="!canCopy"
        :aria-label="props.copied ? copiedLabel : copyTooltip"
        @click="emit('copyMessage', props.message)"
      >
        <CopyStateIcon :copied="props.copied" />
      </ElButton>
    </ElTooltip>

    <ElTooltip v-if="isAssistant && props.showRetry" :content="t('chat.messageList.retry')" placement="bottom">
      <ElButton
        text
        :class="actionButtonClass"
        :icon="RefreshRight"
        :aria-label="t('chat.messageList.retry')"
        :disabled="props.isStreaming || props.isReadonly"
        @click="emit('retryAssistantMessage', props.message)"
      />
    </ElTooltip>

    <ElTooltip v-if="props.message.role === 'user' && props.showEdit" :content="t('chat.messageList.edit')" placement="bottom">
      <ElButton
        text
        :class="actionButtonClass"
        :icon="EditPen"
        :aria-label="t('chat.messageList.edit')"
        :disabled="props.isStreaming || props.isReadonly"
        @click="emit('editMessage', props.message)"
      />
    </ElTooltip>

    <div
      v-if="props.message.branch.count > 1"
      class="chat-message-actions__branch inline-flex items-center gap-0.5 rounded-md px-0.5 leading-none"
    >
      <ElTooltip :content="t('chat.messageList.previousBranch')" placement="bottom">
        <ElButton
          text
          :class="branchButtonClass"
          :icon="ArrowLeft"
          :aria-label="t('chat.messageList.previousBranch')"
          :disabled="props.isStreaming || props.isReadonly || !props.message.branch.previousMessageId"
          @click="emitSwitchBranch(props.message.branch.previousMessageId)"
        />
      </ElTooltip>
      <span class="inline-flex items-center justify-center px-1" :class="branchIndexClass">
        {{ props.message.branch.index }} / {{ props.message.branch.count }}
      </span>
      <ElTooltip :content="t('chat.messageList.nextBranch')" placement="bottom">
        <ElButton
          text
          :class="branchButtonClass"
          :icon="ArrowRight"
          :aria-label="t('chat.messageList.nextBranch')"
          :disabled="props.isStreaming || props.isReadonly || !props.message.branch.nextMessageId"
          @click="emitSwitchBranch(props.message.branch.nextMessageId)"
        />
      </ElTooltip>
    </div>

    <slot name="after" />
  </div>
</template>

<style scoped lang="scss">
.chat-message-actions {
  font-variant-numeric: tabular-nums;

  &__button,
  &__branch-button {
    color: inherit;
  }

  &__button {
    background: color-mix(in srgb, var(--brand-fill-light) 34%, transparent);
  }

  &__button--global {
    width: 1.75rem;
    min-width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.5rem;
    padding: 0;
  }

  &__button--docs {
    width: 1.5rem;
    min-width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
    padding: 0;
  }

  &__copy-button {
    transition:
      color 0.16s ease,
      transform 0.16s ease;

    &.is-copied {
      transform: translateY(-0.0625rem);
    }
  }

  &--global &__copy-button.is-copied {
    color: var(--brand-success);
  }

  &--docs &__copy-button.is-copied {
    color: var(--brand-primary);
  }

  &__branch {
    color: inherit;
  }

  &--global &__branch {
    margin-left: 0.125rem;
    font-size: 0.8125rem;
  }

  &--docs &__branch {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 64%, transparent);
    font-size: 0.75rem;
  }

  &__branch-button {
    width: 1rem;
    min-width: 1rem;
    height: 1rem;
    border-radius: 0.375rem;
    background: transparent;
    padding: 0;

    :deep(.el-icon) {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.625rem;
      line-height: 1;
    }
  }

  :deep(.el-button.is-text.chat-message-actions__branch-button:not(.is-disabled):hover),
  :deep(.el-button.is-text.chat-message-actions__branch-button:not(.is-disabled):focus-visible) {
    background-color: transparent;
    color: var(--brand-text-primary);
  }
}
</style>

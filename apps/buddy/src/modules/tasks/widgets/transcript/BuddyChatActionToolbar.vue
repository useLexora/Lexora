<script setup lang="ts">
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'

import type { ChatMessageActions } from '../../model/transcript/chatMessageActions'
import type { ChatMessageBranchNavigator } from '../../model/transcript/chatMessageBranches'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useTimeoutFn } from '@vueuse/core'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import { shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { formatChatMessageTimeLabel } from '../../model/transcript/chatMessageTime'
import BuddyChatTokenUsage from './BuddyChatTokenUsage.vue'
import { useChatContent } from './chatContentContext'

const props = defineProps<{
  actions: ChatMessageActions
  branchNavigator: ChatMessageBranchNavigator | null
  copyText: string
  createdAt: string
  language: BuddyLocale
  role: LocalMessage['role']
  targetKey: string
  usage?: LocalRunTokenUsage | null
}>()

const emit = defineEmits<{
  activateBranch: [branchId: string]
  regenerate: []
  startEdit: []
}>()

const { t } = useBuddyI18n(() => props.language)
const { writeClipboardText } = useChatContent()
const notification = useMessage()
const copied = shallowRef(false)
const copyReset = useTimeoutFn(() => copied.value = false, 1_400, { immediate: false })

async function copyContent() {
  if (!props.copyText)
    return
  try {
    await writeClipboardText(props.copyText)
    copied.value = true
    copyReset.stop()
    copyReset.start()
  }
  catch {
    notification.error(t('desktop.chat.copyFailed'))
  }
}
</script>

<template>
  <div class="buddy-chat-action-toolbar flex flex-wrap min-h-6 items-center gap-[0.15rem]">
    <WorkbenchMenu v-if="actions.showCopy" target="message.actions" :values="{ 'message.role': role }" :capture="() => ({ content: copyText })" />
    <time
      v-if="actions.showTime && role === 'user'"
      class="buddy-chat-action-toolbar__time inline-flex h-6 items-center text-muted px-[0.2rem] whitespace-nowrap"
      :datetime="createdAt"
    >
      {{ formatChatMessageTimeLabel(createdAt) }}
    </time>
    <NTooltip v-if="actions.showCopy" placement="bottom">
      <template #trigger>
        <NButton
          :data-testid="`copy-${targetKey}`"
          class="buddy-icon-button buddy-chat-action-toolbar__copy-button"
          :class="{ 'is-copied': copied }"
          quaternary
          size="tiny"
          :aria-label="t(copied ? 'desktop.chat.copied' : 'desktop.chat.copy')"
          @click="copyContent"
        >
          <template #icon>
            <DesktopIcon :name="copied ? 'messageCopied' : 'messageCopy'" />
          </template>
        </NButton>
      </template>
      {{ t(copied ? 'desktop.chat.copied' : 'desktop.chat.copy') }}
    </NTooltip>
    <NTooltip v-if="actions.showEdit" placement="bottom">
      <template #trigger>
        <NButton
          :data-testid="`edit-${targetKey}`"
          :disabled="actions.disabled"
          class="buddy-icon-button"
          quaternary
          size="tiny"
          :aria-label="t('desktop.chat.editMessage')"
          @click="emit('startEdit')"
        >
          <template #icon>
            <DesktopIcon name="messageEdit" />
          </template>
        </NButton>
      </template>
      {{ t('desktop.chat.editMessage') }}
    </NTooltip>
    <NTooltip v-if="actions.showRegenerate" placement="bottom">
      <template #trigger>
        <NButton
          :data-testid="`regenerate-${targetKey}`"
          :disabled="actions.disabled"
          class="buddy-icon-button"
          quaternary
          size="tiny"
          :aria-label="t('desktop.chat.regenerate')"
          @click="emit('regenerate')"
        >
          <template #icon>
            <DesktopIcon name="messageRetry" />
          </template>
        </NButton>
      </template>
      {{ t('desktop.chat.regenerate') }}
    </NTooltip>
    <div v-if="branchNavigator" class="buddy-chat-action-toolbar__branch inline-flex items-center gap-[0.05rem] ml-[0.1rem] text-muted">
      <NTooltip placement="bottom">
        <template #trigger>
          <NButton
            :disabled="actions.disabled || !branchNavigator.previousBranchId"
            class="buddy-icon-button buddy-chat-action-toolbar__branch-button"
            quaternary
            size="tiny"
            :aria-label="t('desktop.chat.previousBranch')"
            @click="emit('activateBranch', branchNavigator.previousBranchId!)"
          >
            <template #icon>
              <DesktopIcon name="messageBranchPrevious" />
            </template>
          </NButton>
        </template>
        {{ t('desktop.chat.previousBranch') }}
      </NTooltip>
      <span>{{ branchNavigator.index }} / {{ branchNavigator.count }}</span>
      <NTooltip placement="bottom">
        <template #trigger>
          <NButton
            :disabled="actions.disabled || !branchNavigator.nextBranchId"
            class="buddy-icon-button buddy-chat-action-toolbar__branch-button"
            quaternary
            size="tiny"
            :aria-label="t('desktop.chat.nextBranch')"
            @click="emit('activateBranch', branchNavigator.nextBranchId!)"
          >
            <template #icon>
              <DesktopIcon name="messageBranchNext" />
            </template>
          </NButton>
        </template>
        {{ t('desktop.chat.nextBranch') }}
      </NTooltip>
    </div>
    <time
      v-if="actions.showTime && role === 'assistant'"
      class="buddy-chat-action-toolbar__time inline-flex h-6 items-center text-muted px-[0.2rem] whitespace-nowrap"
      :datetime="createdAt"
    >
      {{ formatChatMessageTimeLabel(createdAt) }}
    </time>
    <BuddyChatTokenUsage
      v-if="usage && role === 'assistant'"
      class="buddy-chat-action-toolbar__usage"
      :language="language"
      :usage="usage"
    />
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-action-toolbar {
  :deep(.n-button) {
    color: var(--buddy-text-secondary);
    font-size: 0.68rem;
  }
}

.buddy-chat-action-toolbar :deep(.buddy-chat-action-toolbar__usage) {
  padding-inline-start: 0.75rem;
}

.buddy-chat-action-toolbar__branch {
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;

  > span {
    min-width: 2.25rem;
    text-align: center;
  }
}

.buddy-chat-action-toolbar__time {
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}

.buddy-chat-action-toolbar__copy-button {
  transition:
    background-color 160ms ease,
    color 160ms ease;

  &.is-copied {
    background: var(--buddy-accent-surface);
    color: var(--buddy-accent-text);
  }
}

.buddy-chat-action-toolbar__branch-button {
  width: 1.35rem;
  min-width: 1.35rem;
  height: 1.35rem;
  border-radius: var(--buddy-icon-button-radius);
  padding: 0;

  :deep(.n-button__icon) {
    font-size: 1rem;
  }
}
</style>

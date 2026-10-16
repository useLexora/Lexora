import type { MaybeRefOrGetter } from 'vue'
import type { ChatMessage } from '@/apis/chat'
import { useClipboard } from '@vueuse/core'
import { computed, shallowRef, toValue, watch } from 'vue'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getMessageText } from './utils/chat-message-display'

export interface UseChatMessageActionsOptions {
  isReadonly?: MaybeRefOrGetter<boolean>
  isStreaming?: MaybeRefOrGetter<boolean>
  retryMessage?: (messageId: string) => Promise<boolean>
  switchBranch?: (messageId: string) => Promise<boolean>
}

export function useChatMessageActions(options: UseChatMessageActionsOptions = {}) {
  const copiedMessageId = shallowRef<string | null>(null)
  const isReadonly = computed(() => Boolean(toValue(options.isReadonly)))
  const isStreaming = computed(() => Boolean(toValue(options.isStreaming)))
  const {
    copy: copyText,
    copied: copiedMessage,
    isSupported: isClipboardSupported,
  } = useClipboard({
    copiedDuring: 1400,
    legacy: true,
  })

  watch(copiedMessage, (copied) => {
    if (!copied) {
      copiedMessageId.value = null
    }
  })

  async function copyMessage(message: ChatMessage) {
    const text = getMessageText(message)
    if (!text) {
      ElMessage.warning(translate('chat.messageList.noCopyContent'))
      return
    }

    if (!isClipboardSupported.value) {
      ElMessage.error(translate('chat.messageList.copyUnsupported'))
      return
    }

    try {
      await copyText(text)
      copiedMessageId.value = message.id
    }
    catch {
      ElMessage.error(translate('chat.messageList.copyFailed'))
    }
  }

  function isMessageCopied(message: ChatMessage) {
    return copiedMessage.value && copiedMessageId.value === message.id
  }

  async function retryAssistantMessage(message: ChatMessage) {
    if (message.role !== 'assistant' || isStreaming.value || isReadonly.value) {
      return
    }

    await options.retryMessage?.(message.id)
  }

  async function switchToBranch(messageId: string | null) {
    if (!messageId || isStreaming.value || isReadonly.value) {
      return
    }

    await options.switchBranch?.(messageId)
  }

  return {
    copyMessage,
    isMessageCopied,
    retryAssistantMessage,
    switchToBranch,
  }
}

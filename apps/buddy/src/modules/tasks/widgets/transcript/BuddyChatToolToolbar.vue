<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowUpRight20Regular, Checkmark20Regular, Copy20Regular } from '@vicons/fluent'
import { useTimeoutFn } from '@vueuse/core'
import { useMessage } from 'naive-ui'
import { onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useChatContent } from './chatContentContext'

const props = defineProps<{
  language: BuddyLocale
  title: string
  filePath?: string
  copyText?: string | null
  copyLabel?: string
}>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const actions = useChatContent()
const copyState = shallowRef<'idle' | 'copied'>('idle')
const copyReset = useTimeoutFn(() => copyState.value = 'idle', 1_400, { immediate: false })
let disposed = false
onScopeDispose(() => disposed = true)
watch(() => props.copyText, () => {
  copyReset.stop()
  copyState.value = 'idle'
})
async function copy() {
  const text = props.copyText
  if (!text)
    return
  try {
    await actions.writeClipboardText(text)
    if (!disposed && props.copyText === text) {
      copyState.value = 'copied'
      copyReset.start()
    }
  }
  catch {
    if (!disposed && props.copyText === text) {
      copyState.value = 'idle'
      message.error(t('desktop.chat.copyFailed'))
    }
  }
}
</script>

<template>
  <header class="buddy-chat-tool-toolbar">
    <span class="buddy-chat-tool-toolbar__title" :title="title">{{ title }}</span>
    <slot />
    <div class="buddy-chat-tool-toolbar__actions">
      <button v-if="filePath && actions.canPreviewFile(filePath)" class="buddy-chat-tool-toolbar__action" type="button" :title="filePath" @click="actions.previewFile(filePath)">
        <DesktopIcon :component="ArrowUpRight20Regular" />
        {{ t('desktop.chat.processToolPreviewFile') }}
      </button>
      <button v-if="copyText" class="buddy-chat-tool-toolbar__action" type="button" :aria-label="copyState === 'copied' ? t('desktop.chat.copied') : copyLabel ?? t('desktop.chat.processToolCopyOutput')" @click="copy">
        <DesktopIcon :component="copyState === 'copied' ? Checkmark20Regular : Copy20Regular" />
        <span aria-live="polite">{{ t(copyState === 'copied' ? 'desktop.chat.copied' : 'desktop.chat.copy') }}</span>
      </button>
    </div>
  </header>
</template>

<style scoped lang="scss">
.buddy-chat-tool-toolbar {
  display: flex;
  min-height: 30px;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-chat-caption-font-size);
}

.buddy-chat-tool-toolbar__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.buddy-chat-tool-toolbar__actions {
  display: flex;
  flex: none;
  gap: 4px;
  margin-left: auto;
}

.buddy-chat-tool-toolbar__action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: inherit;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;

  :deep(.n-icon) { width: 14px; height: 14px; }
  &:hover { color: var(--buddy-text-primary); background: var(--buddy-state-hover); }
  &:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: 2px; }
}
</style>

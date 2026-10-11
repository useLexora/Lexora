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
  <header class="buddy-chat-tool-toolbar flex min-h-[30px] items-center gap-[8px] py-[3px] px-[10px] text-muted text-[length:var(--buddy-chat-caption-font-size)]">
    <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" :title="title">{{ title }}</span>
    <slot />
    <div class="flex flex-none gap-[4px] ml-auto">
      <button v-if="filePath && actions.canPreviewFile(filePath)" class="buddy-chat-tool-toolbar__action inline-flex items-center gap-[5px] py-[3px] px-[6px] border-0 rounded-micro bg-transparent text-inherit whitespace-nowrap cursor-pointer hover:text-fg hover:bg-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" type="button" :title="filePath" @click="actions.previewFile(filePath)">
        <DesktopIcon :component="ArrowUpRight20Regular" />
        {{ t('desktop.chat.processToolPreviewFile') }}
      </button>
      <button v-if="copyText" class="buddy-chat-tool-toolbar__action inline-flex items-center gap-[5px] py-[3px] px-[6px] border-0 rounded-micro bg-transparent text-inherit whitespace-nowrap cursor-pointer hover:text-fg hover:bg-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" type="button" :aria-label="copyState === 'copied' ? t('desktop.chat.copied') : copyLabel ?? t('desktop.chat.processToolCopyOutput')" @click="copy">
        <DesktopIcon :component="copyState === 'copied' ? Checkmark20Regular : Copy20Regular" />
        <span aria-live="polite">{{ t(copyState === 'copied' ? 'desktop.chat.copied' : 'desktop.chat.copy') }}</span>
      </button>
    </div>
  </header>
</template>

<style scoped lang="scss">
.buddy-chat-tool-toolbar__action {
  :deep(.n-icon) { width: 14px; height: 14px; }
}
</style>

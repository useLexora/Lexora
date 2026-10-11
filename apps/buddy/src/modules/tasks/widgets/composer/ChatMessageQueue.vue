<script setup lang="ts">
import type { LocalChatQueueItem } from '@buddy-shared/conversation/chatQueueApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyUserContentToText } from '@buddy-shared/conversation/buddyUserContent'
import { ArrowEnterUp20Regular, Dismiss20Regular, Pause20Regular, TextBulletListLtr20Regular } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { FileIcon } from '@/shared/ui/file-icon'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyImagePreview from '@/shared/ui/media/BuddyImagePreview.vue'

const props = defineProps<{
  items: readonly LocalChatQueueItem[]
  pending: ReadonlySet<string>
  language: BuddyLocale
}>()
const emit = defineEmits<{ cancel: [id: string], steer: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const rows = computed(() => props.items.map(item => ({
  ...item,
  text: [buddyUserContentToText(item.content.userContent, () => '').trim(), ...(item.content.userContent.quotes ?? []).map(quote => quote.text)].filter(Boolean).join(' · '),
  visibleAttachments: item.attachments.slice(0, 2),
  attachmentNames: item.attachments.map(attachment => attachment.name).join('\n'),
})))
const previewVisible = shallowRef(false)
const previewSources = shallowRef<string[]>([])
const previewIndex = shallowRef(0)
function isImage(attachment: LocalChatQueueItem['attachments'][number]) {
  return attachment.mimeType.startsWith('image/') && attachment.mimeType !== 'image/svg+xml'
}
function preview(item: LocalChatQueueItem, id: string) {
  const images = item.attachments.filter(isImage)
  previewSources.value = images.map(attachment => `lexora-attachment://preview/${encodeURIComponent(attachment.id)}`)
  previewIndex.value = images.findIndex(attachment => attachment.id === id)
  previewVisible.value = true
}
</script>

<template>
  <div v-if="rows.length" class="chat-message-queue grid grid-cols-[minmax(0,_1fr)] min-w-0 max-h-[min(10rem,_25vh)] mb-[0.45rem] border-1 border-solid border-border rounded-micro bg-surface" role="list" :aria-label="t('desktop.chat.queueWaiting')">
    <div v-for="item in rows" :key="item.id" class="chat-message-queue__row flex items-center min-w-0 h-[38px] gap-2 pt-0 pr-[0.35rem] pb-0 pl-[0.65rem]" :class="{ 'is-paused': item.state === 'paused' }" role="listitem" :data-queued-message="item.id">
      <span class="chat-message-queue__status inline-flex flex-none text-muted text-[1rem]" :title="t(item.state === 'paused' ? 'desktop.chat.queuePaused' : 'desktop.chat.queueWaiting')" :aria-label="t(item.state === 'paused' ? 'desktop.chat.queuePaused' : 'desktop.chat.queueWaiting')">
        <DesktopIcon :component="item.state === 'paused' ? Pause20Regular : TextBulletListLtr20Regular" />
      </span>
      <div v-if="item.attachments.length" class="chat-message-queue__attachments">
        <template v-for="attachment in item.visibleAttachments" :key="attachment.id">
          <button v-if="isImage(attachment)" type="button" :title="attachment.name" :aria-label="t('desktop.imagePreview.open', { name: attachment.name })" @click="preview(item, attachment.id)">
            <img :src="`lexora-attachment://preview/${encodeURIComponent(attachment.id)}`" :alt="attachment.name" width="24" height="24">
          </button>
          <span v-else class="chat-message-queue__file" :title="attachment.name" :aria-label="attachment.name">
            <FileIcon :name="attachment.name" size="small" />
          </span>
        </template>
        <span v-if="item.attachments.length > 2" class="chat-message-queue__more px-[0.15rem] text-muted" :title="item.attachmentNames">+{{ item.attachments.length - 2 }}</span>
      </div>
      <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.82rem] text-muted" :title="item.text || item.attachmentNames">{{ item.text || item.attachments.map(attachment => attachment.name).join('、') }}</span>
      <div class="chat-message-queue__actions">
        <NTooltip>
          <template #trigger>
            <NButton quaternary circle size="small" :loading="pending.has(item.id)" :disabled="pending.has(item.id)" :aria-label="t('desktop.chat.queueSteer')" @click="emit('steer', item.id)">
              <template #icon>
                <DesktopIcon :component="ArrowEnterUp20Regular" />
              </template>
            </NButton>
          </template>
          {{ t('desktop.chat.queueSteer') }}
        </NTooltip>
        <NButton quaternary circle size="small" :disabled="pending.has(item.id)" :title="t('desktop.chat.queueCancel')" :aria-label="t('desktop.chat.queueCancel')" @click="emit('cancel', item.id)">
          <template #icon>
            <DesktopIcon :component="Dismiss20Regular" />
          </template>
        </NButton>
      </div>
    </div>
  </div>
  <BuddyImagePreview v-model:show="previewVisible" v-model:current="previewIndex" :language="language" :sources="previewSources" />
</template>

<style scoped lang="scss">
.chat-message-queue {
  overflow: hidden auto;
  overscroll-behavior: contain;

  &__row {
    & + & { border-top: 1px solid var(--buddy-border-subtle); }
  }

  &__row.is-paused &__status { color: var(--buddy-status-warning-text); }

  &__attachments, &__actions {
    display: flex;
    align-items: center;
    flex: none;
    gap: 0.2rem;
  }

  &__attachments {
    button, .chat-message-queue__file {
      display: grid;
      place-items: center;
      flex: none;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1px solid var(--buddy-border-subtle);
      border-radius: 4px;
      background: transparent;
      color: inherit;
    }

    button { cursor: zoom-in; }
    img { object-fit: cover; border-radius: 3px; }
  }

  &__more {
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
}
</style>

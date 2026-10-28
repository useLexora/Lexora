<script setup lang="ts">
import type { LocalChatQueueItem } from '@buddy-shared/conversation/chatQueueApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyUserContentToText, getBuddyUserContentActorReferences } from '@buddy-shared/conversation/buddyUserContent'
import { ArrowEnterUp20Regular, Dismiss20Regular, Pause20Regular, TextBulletListLtr20Regular } from '@vicons/fluent'
import { NButton, NPopover, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { getInputMaterialViews, inputMaterialText } from '../../model/materials/inputMaterialView'
import ChatInputMaterialStrip from '../materials/ChatInputMaterialStrip.vue'

const props = defineProps<{
  items: readonly LocalChatQueueItem[]
  pending: ReadonlySet<string>
  activeBuddyId?: string
  recipientNames?: ReadonlyMap<string, string>
  language: BuddyLocale
}>()
const emit = defineEmits<{ cancel: [id: string], steer: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const rows = computed(() => props.items.map((item) => {
  const attachments = new Map(item.attachments.map(attachment => [attachment.id, attachment]))
  const snapshots = new Map(item.content.resourceSnapshots.map(snapshot => [snapshot.resourceId, snapshot]))
  const materials = getInputMaterialViews(item.content.userContent, (id) => {
    const snapshot = snapshots.get(id)
    const attachment = snapshot?.attachmentId ? attachments.get(snapshot.attachmentId) : undefined
    const resource = attachment
      ? { ...attachment, kind: attachment.mimeType.startsWith('image/') ? 'image' as const : 'binary' as const, state: 'ready' as const }
      : snapshot?.localReference ? { ...snapshot.localReference, state: 'ready' as const } : undefined
    return resource
      ? {
          resource,
          previewUrl: attachment?.mimeType.startsWith('image/') && attachment.mimeType !== 'image/svg+xml' ? `lexora-attachment://preview/${encodeURIComponent(attachment.id)}` : null,
        }
      : undefined
  })
  return {
    ...item,
    differentBuddy: !!props.activeBuddyId && item.buddyId !== props.activeBuddyId,
    canSteer: !item.delivery || (item.delivery.mode === 'current' && item.delivery.target !== null && item.state === 'waiting'),
    recipient: props.recipientNames?.get(item.buddyId)
      ?? getBuddyUserContentActorReferences(item.content.userContent).find(actor => actor.actorId === item.buddyId)?.name,
    status: item.delivery
      ? t(item.state === 'paused' ? 'desktop.chat.inputDeliveryPaused' : item.delivery.mode === 'next' ? 'desktop.chat.inputDelivery.next' : item.delivery.target ? 'desktop.chat.inputDelivery.current' : 'desktop.chat.queueWaiting')
      : t(item.state === 'paused' ? 'desktop.chat.queuePaused' : 'desktop.chat.queueWaiting'),
    text: buddyUserContentToText(item.content.userContent, () => '').trim() || materials.map(inputMaterialText).join(' · '),
    materials,
  }
}))
</script>

<template>
  <div v-if="rows.length" class="chat-message-queue grid grid-cols-[minmax(0,_1fr)] min-w-0 max-h-[min(10rem,_25vh)] mb-[0.45rem] border-1 border-solid border-border rounded-micro bg-surface" role="list" :aria-label="t('desktop.chat.queueWaiting')">
    <div v-for="item in rows" :key="item.id" class="chat-message-queue__row flex items-center min-w-0 min-h-[38px] gap-2 py-1 pr-[0.35rem] pl-[0.65rem]" :class="{ 'is-paused': item.state === 'paused' }" role="listitem" :data-queued-message="item.id">
      <span class="chat-message-queue__status inline-flex flex-none text-muted text-[1rem]" :aria-label="item.status">
        <DesktopIcon :component="item.state === 'paused' ? Pause20Regular : TextBulletListLtr20Regular" />
      </span>
      <ChatInputMaterialStrip v-if="item.materials.length" class="flex-none max-w-[45%]" :materials="item.materials" :language="language" compact />
      <NPopover trigger="click" placement="top-start" :show-arrow="false">
        <template #trigger>
          <button type="button" class="flex-1 min-w-0 overflow-hidden border-0 bg-transparent p-0 text-left text-[0.82rem] text-muted cursor-pointer ui-focus-ring">
            <span v-if="item.delivery" class="block truncate text-xs leading-5">
              <span v-if="item.recipient">{{ t('desktop.chat.inputDelivery.recipient') }} {{ item.recipient }} · </span>{{ item.status }}
            </span>
            <span class="block truncate">{{ item.text }}</span>
          </button>
        </template>
        <p v-if="item.delivery" class="mb-2 text-xs text-muted">
          <span v-if="item.recipient">{{ t('desktop.chat.inputDelivery.recipient') }} {{ item.recipient }} · </span>{{ item.status }}
        </p>
        <p class="max-w-[min(24rem,_80vw)] max-h-[40vh] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-fg">
          {{ item.text }}
        </p>
      </NPopover>
      <div class="chat-message-queue__actions">
        <NTooltip v-if="item.canSteer">
          <template #trigger>
            <NButton class="buddy-icon-button" quaternary size="small" :loading="pending.has(item.id)" :disabled="pending.has(item.id) || item.differentBuddy" :aria-label="t('desktop.chat.queueSteer')" @click="emit('steer', item.id)">
              <template #icon>
                <DesktopIcon :component="ArrowEnterUp20Regular" />
              </template>
            </NButton>
          </template>
          {{ item.differentBuddy ? (language === 'en-US' ? 'Waiting for the selected companion’s next turn' : '等待所选伙伴在下一轮处理') : t('desktop.chat.queueSteer') }}
        </NTooltip>
        <NButton class="buddy-icon-button" quaternary size="small" :disabled="pending.has(item.id)" :aria-label="t('desktop.chat.queueCancel')" @click="emit('cancel', item.id)">
          <template #icon>
            <DesktopIcon :component="Dismiss20Regular" />
          </template>
        </NButton>
      </div>
    </div>
  </div>
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

}
</style>

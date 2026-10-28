<script setup lang="ts">
import type { DesktopComposerInputDelivery } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowUp20Regular, Stop20Filled } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  canSubmit: boolean
  queuesSubmission: boolean
  inputDelivery?: DesktopComposerInputDelivery
  isRunning: boolean
  isStopping: boolean
  isSending: boolean
  isLocalCommand: boolean
  issueMessage: string
}>()
const emit = defineEmits<{ submit: [], stop: [] }>()
const { t } = useBuddyI18n(() => props.language)
const submitLabel = computed(() => {
  if (props.isLocalCommand)
    return t('desktop.command.run')
  if (props.inputDelivery)
    return t(props.inputDelivery.mode === 'next' ? 'desktop.chat.queueAdd' : props.inputDelivery.answering ? 'desktop.chat.inputDelivery.answer' : 'desktop.chat.inputDelivery.current')
  return t(props.queuesSubmission ? 'desktop.chat.queueAdd' : 'desktop.chat.send')
})
const actions = computed(() => [
  {
    id: 'stop' as const,
    visible: props.isRunning,
    label: t(props.isStopping ? 'desktop.chat.progressStopping' : 'desktop.chat.stop'),
    hint: t(props.isStopping ? 'desktop.chat.progressStopping' : 'desktop.chat.stop'),
    disabled: props.isStopping,
    loading: props.isStopping,
    type: 'error' as const,
  },
  {
    id: props.queuesSubmission ? 'queue' : 'send',
    visible: true,
    label: submitLabel.value,
    hint: props.isLocalCommand ? submitLabel.value : props.issueMessage || submitLabel.value,
    disabled: !props.canSubmit,
    loading: props.isSending,
    type: props.queuesSubmission ? 'default' as const : 'primary' as const,
  },
].filter(action => action.visible))
</script>

<template>
  <NTooltip v-for="action in actions" :key="action.id">
    <template #trigger>
      <span class="desktop-chat-composer__send-trigger inline-flex flex-none">
        <NButton
          class="buddy-icon-button composer-submit-action"
          :class="action.id === 'queue' ? 'desktop-chat-composer__queue-action' : 'desktop-chat-composer__send-action'"
          :type="action.type"
          :quaternary="action.id === 'queue'"
          :secondary="action.id === 'stop'"
          :aria-label="action.label"
          :aria-busy="action.id === 'stop' ? isStopping : undefined"
          :disabled="action.disabled"
          :loading="action.loading"
          @click="action.id === 'stop' ? emit('stop') : emit('submit')"
        >
          <template #icon>
            <DesktopIcon v-if="action.id === 'queue'" name="messageQueue" />
            <DesktopIcon v-else :component="action.id === 'stop' ? Stop20Filled : ArrowUp20Regular" />
          </template>
        </NButton>
      </span>
    </template>
    {{ action.hint }}
  </NTooltip>
</template>

<style scoped lang="scss">
.composer-submit-action {
  --n-height: var(--buddy-composer-control-height);

  width: var(--buddy-composer-control-height);
  min-width: var(--buddy-composer-control-height);
  height: var(--buddy-composer-control-height);
}

@media (prefers-reduced-motion: reduce) {
  .desktop-chat-composer__send-action :deep(.n-base-loading__container) {
    box-sizing: border-box;
    width: 1em;
    height: 1em;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: none;
  }

  .desktop-chat-composer__send-action :deep(.n-base-loading__icon) {
    display: none;
  }
}
</style>

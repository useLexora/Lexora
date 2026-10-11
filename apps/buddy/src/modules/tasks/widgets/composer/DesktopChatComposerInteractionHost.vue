<script setup lang="ts">
import type { ChatComposerInteraction } from '../../state/composer/typing'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Dismiss16Regular, Info20Regular, Warning20Regular } from '@vicons/fluent'
import { useTimeoutFn } from '@vueuse/core'
import { NButton } from 'naive-ui'
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  chooserVisible: boolean
  interaction: ChatComposerInteraction | null
  language: BuddyLocale
}>()

const emit = defineEmits<{
  dismiss: [id: string]
}>()

defineSlots<{
  chooser?: () => unknown
}>()

const { t } = useBuddyI18n(() => props.language)
const { start: startDismissTimer, stop: stopDismissTimer } = useTimeoutFn(() => {
  if (props.interaction)
    emit('dismiss', props.interaction.id)
}, () => props.interaction?.autoDismissMs ?? 0, { immediate: false })

watch(
  [() => props.chooserVisible, () => props.interaction?.id],
  resetDismissTimer,
)
onMounted(resetDismissTimer)
onBeforeUnmount(stopDismissTimer)

function resetDismissTimer() {
  stopDismissTimer()
  if (!props.chooserVisible && props.interaction?.autoDismissMs)
    startDismissTimer()
}
</script>

<template>
  <div
    v-if="chooserVisible || interaction"
    class="desktop-chat-composer-interaction-host absolute right-0 bottom-[calc(100%_+_0.65rem)] left-0 z-20 grid"
  >
    <div v-if="chooserVisible" class="min-w-0 rounded-[0.55rem] bg-raised shadow-raised">
      <slot name="chooser" />
    </div>

    <article
      v-else-if="interaction"
      class="desktop-chat-composer-notice grid max-w-[min(30rem,_100%)] grid-cols-[auto_minmax(0,_1fr)_auto] items-center justify-self-center gap-[0.55rem] border-1 border-solid border-border rounded-micro bg-raised shadow-raised text-fg text-[0.76rem] leading-[1.4] pt-[0.38rem] pr-[0.42rem] pb-[0.38rem] pl-[0.6rem]"
      :class="`is-${interaction.tone}`"
      role="status"
      @mouseenter="stopDismissTimer"
      @mouseleave="resetDismissTimer"
    >
      <DesktopIcon
        :component="interaction.tone === 'warning' ? Warning20Regular : Info20Regular"
        class="desktop-chat-composer-notice__icon"
      />
      <span>{{ t(interaction.messageKey) }}</span>
      <NButton
        v-if="interaction.dismissible"
        class="desktop-chat-composer-notice__dismiss buddy-icon-button"
        quaternary
        size="small"
        :aria-label="t('common.close')"
        @click="emit('dismiss', interaction.id)"
      >
        <template #icon>
          <DesktopIcon :component="Dismiss16Regular" />
        </template>
      </NButton>
    </article>
  </div>
</template>

<style scoped lang="scss">
.desktop-chat-composer-notice__icon {
  color: var(--buddy-accent-text);
  font-size: 1rem;
}

.desktop-chat-composer-notice.is-warning .desktop-chat-composer-notice__icon {
  color: var(--buddy-status-warning-text);
}

.desktop-chat-composer-notice__dismiss {
  width: 1.65rem;
  height: 1.65rem;
}
</style>

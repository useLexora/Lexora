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
    class="desktop-chat-composer-interaction-host"
  >
    <div v-if="chooserVisible" class="desktop-chat-composer-interaction-host__chooser">
      <slot name="chooser" />
    </div>

    <article
      v-else-if="interaction"
      class="desktop-chat-composer-notice"
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
.desktop-chat-composer-interaction-host {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.65rem);
  left: 0;
  z-index: 20;
  display: grid;
}

.desktop-chat-composer-interaction-host__chooser {
  min-width: 0;
  border-radius: 0.55rem;
  background: var(--buddy-surface-raised);
  box-shadow: var(--buddy-shadow-raised);
}

.desktop-chat-composer-notice {
  display: grid;
  max-width: min(30rem, 100%);
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  justify-self: center;
  gap: 0.55rem;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: var(--buddy-radius-micro);
  background: var(--buddy-surface-raised);
  box-shadow: var(--buddy-shadow-raised);
  color: var(--buddy-text-primary);
  font-size: 0.76rem;
  line-height: 1.4;
  padding: 0.38rem 0.42rem 0.38rem 0.6rem;
}

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

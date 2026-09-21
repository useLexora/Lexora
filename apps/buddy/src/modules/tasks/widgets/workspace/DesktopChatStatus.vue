<script setup lang="ts">
import type { LocalBuddyServiceSupervisorState } from '@buddy-shared/runtime/serviceState'
import type { ChatBlocker } from '../../model/status/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopSettingsCategory } from '@/shared/navigation/desktopRoutes'
import { ArrowClockwise20Regular, Settings20Regular, Warning20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import ModelIcon from '@/shared/ui/icon/ModelIcon.vue'

const props = defineProps<{
  blocker: ChatBlocker | null
  canRestartRuntime: boolean
  language: BuddyLocale
  runtimeError: string | null
  runtimeStatus: LocalBuddyServiceSupervisorState['status']
}>()
const emit = defineEmits<{
  dismissBlocker: []
  openSettings: [category: DesktopSettingsCategory]
  restartRuntime: []
  selectModel: []
}>()
const { t } = useBuddyI18n(() => props.language)

const title = computed(() => {
  if (!props.blocker)
    return ''
  if (props.blocker.kind === 'no_models')
    return t('desktop.chat.blocker.noModels.title')
  return t(`desktop.chat.blocker.${props.blocker.kind}.title`)
})

const description = computed(() => {
  if (!props.blocker)
    return ''
  if (props.blocker.kind === 'runtime')
    return props.runtimeError || t('desktop.chat.blocker.runtime.description')
  if (props.blocker.kind === 'no_models')
    return t('desktop.chat.blocker.noModels.description')
  if (props.blocker.kind === 'model') {
    return props.blocker.reason === 'unavailable'
      ? t('desktop.chat.blocker.model.unavailableDescription')
      : t('desktop.chat.blocker.model.description')
  }
  return t(`desktop.chat.blocker.${props.blocker.kind}.description`)
})

const actionLabel = computed(() => {
  if (!props.blocker)
    return ''
  if (props.blocker.kind === 'no_models')
    return t('desktop.chat.blocker.noModels.action')
  return t(`desktop.chat.blocker.${props.blocker.kind}.action`)
})

function handlePrimaryAction() {
  if (!props.blocker)
    return
  if (props.blocker.kind === 'runtime') {
    emit('openSettings', 'logs')
    return
  }
  if (props.blocker.kind === 'model') {
    emit('selectModel')
    return
  }
  emit('openSettings', 'models')
}
</script>

<template>
  <article
    v-if="blocker"
    class="desktop-chat-page__alert"
    :class="`is-${blocker.kind}`"
    role="alert"
  >
    <DesktopIcon :component="Warning20Regular" />
    <div>
      <strong>{{ title }}</strong>
      <p>{{ description }}</p>
    </div>
    <div class="desktop-chat-page__alert-actions">
      <NButton
        v-if="blocker.kind === 'runtime' && canRestartRuntime"
        size="small"
        type="error"
        ghost
        @click="emit('restartRuntime')"
      >
        <template #icon>
          <DesktopIcon :component="ArrowClockwise20Regular" />
        </template>
        {{ t('desktop.chat.runtimeRestart') }}
      </NButton>
      <NButton
        size="small"
        :type="blocker.kind === 'runtime' ? 'default' : 'primary'"
        @click="handlePrimaryAction"
      >
        <template #icon>
          <DesktopIcon :component="blocker.kind === 'model' ? ModelIcon : Settings20Regular" />
        </template>
        {{ actionLabel }}
      </NButton>
      <NButton v-if="blocker.dismissible" text size="small" @click="emit('dismissBlocker')">
        {{ t('desktop.chat.blocker.ignore') }}
      </NButton>
    </div>
  </article>
</template>

<style scoped lang="scss">
.desktop-chat-page__alert {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.7rem;
  border: 1px solid var(--buddy-status-warning-border);
  border-radius: 0.65rem;
  background: var(--buddy-status-warning-surface);
  color: var(--buddy-text-primary);
  padding: 0.65rem 0.75rem;

  > .n-icon {
    color: var(--buddy-status-warning-text);
    font-size: 1.1rem;
  }

  &.is-runtime {
    border-color: var(--buddy-status-danger-border);
    background: var(--buddy-status-danger-surface);

    > .n-icon {
      color: var(--buddy-status-danger-text);
    }
  }

  strong,
  p {
    margin: 0;
  }

  strong {
    font-size: 0.75rem;
  }

  p {
    margin-top: 0.12rem;
    color: var(--buddy-text-secondary);
    font-size: 0.68rem;
    line-height: 1.45;
  }
}

.desktop-chat-page__alert-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

@container desktop-chat-page (max-width: 34rem) {
  .desktop-chat-page__alert {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .desktop-chat-page__alert-actions {
    grid-column: 2;
    justify-content: flex-start;
  }
}
</style>

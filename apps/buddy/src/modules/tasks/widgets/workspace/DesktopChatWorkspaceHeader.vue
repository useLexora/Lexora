<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Chat20Regular } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  taskId?: string | null
  viewMode?: 'chat' | 'canvas'
  canToggleCanvas: boolean
  language: BuddyLocale
  title: string
}>()
const emit = defineEmits<{
  toggleCanvas: []
}>()

const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <header class="desktop-chat-workspace-header flex flex-none items-center justify-between gap-[0.85rem] border-b-1 border-b-solid border-b-border bg-surface pt-0 pr-3 pb-0 pl-4 h-region-header">
    <div class="desktop-chat-workspace-header__copy grid min-w-0 flex-1 gap-[0.05rem] select-none">
      <slot name="title">
        <strong>{{ title }}</strong>
      </slot>
    </div>

    <div class="flex min-w-0 flex-none items-center gap-[0.18rem]">
      <WorkbenchMenu target="task.actions" :task-id="taskId" />
      <slot name="leadingActions" />
      <button
        v-if="canToggleCanvas"
        class="desktop-chat-workspace-header__icon-button grid w-8 h-8 flex-none place-items-center border-0 rounded-icon bg-transparent text-muted cursor-pointer ui-focus-ring disabled:cursor-not-allowed disabled:opacity-42"
        :class="{ 'is-active': viewMode === 'canvas' }"
        data-testid="conversation-canvas-toggle"
        type="button"
        :aria-label="viewMode === 'canvas' ? t('desktop.canvas.chatView') : t('desktop.canvas.view')"
        :aria-pressed="viewMode === 'canvas'"
        @click="emit('toggleCanvas')"
      >
        <DesktopIcon v-if="viewMode === 'canvas'" :component="Chat20Regular" />
        <DesktopIcon v-else>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 21V9.6c0-3.2 2.7-6.4 5.7-7 1.7-.4 2.4 9.6-5.7 18.4Z" />
            <path d="M3 21C7.7 13.3 9.4 8.2 14.7 6c5.9-2.4 6 3.2 2.1 6.9C13.5 16.1 8.3 18.2 3 21Z" fill="var(--buddy-accent-solid)" fill-opacity="0.12" />
            <path d="M3 21c7.5-4.7 13.1-7.9 18.1-7 2.4.3-.9 7-5.9 7Z" />
          </svg>
        </DesktopIcon>
      </button>
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped lang="scss">
.desktop-chat-workspace-header__copy {
  strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 0.88rem;
    font-weight: 660;
  }
}

.desktop-chat-workspace-header__icon-button {
  .n-icon {
    font-size: 16px;
  }

  &:hover:not(:disabled) {
    background: var(--buddy-state-hover);
    color: var(--buddy-text-strong);
  }
}
</style>

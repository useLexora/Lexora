<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Chat20Regular } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
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
  <header class="desktop-chat-workspace-header">
    <div class="desktop-chat-workspace-header__copy">
      <slot name="title">
        <strong>{{ title }}</strong>
      </slot>
    </div>

    <div class="desktop-chat-workspace-header__actions">
      <slot name="leadingActions" />
      <button
        v-if="canToggleCanvas"
        class="desktop-chat-workspace-header__icon-button"
        :class="{ 'is-active': viewMode === 'canvas' }"
        data-testid="conversation-canvas-toggle"
        type="button"
        :aria-label="viewMode === 'canvas' ? t('desktop.canvas.chatView') : t('desktop.canvas.view')"
        :aria-pressed="viewMode === 'canvas'"
        @click="emit('toggleCanvas')"
      >
        <DesktopIcon v-if="viewMode === 'canvas'" :component="Chat20Regular" />
        <DesktopIcon v-else>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 21V9.6c0-3.2 2.7-6.4 5.7-7 1.7-.4 2.4 9.6-5.7 18.4Z" />
            <path d="M3 21C7.7 13.3 9.4 8.2 14.7 6c5.9-2.4 6 3.2 2.1 6.9C13.5 16.1 8.3 18.2 3 21Z" fill="currentColor" fill-opacity="0.1" />
            <path d="M3 21c7.5-4.7 13.1-7.9 18.1-7 2.4.3-.9 7-5.9 7Z" />
          </svg>
        </DesktopIcon>
      </button>
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped lang="scss">
.desktop-chat-workspace-header {
  display: flex;
  height: var(--buddy-region-header-height);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.85rem;
  border-bottom: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-base);
  padding: 0 0.75rem 0 1rem;
}

.desktop-chat-workspace-header__copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 0.05rem;
  user-select: none;

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

.desktop-chat-workspace-header__actions {
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: 0.18rem;
}

.desktop-chat-workspace-header__icon-button {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: var(--buddy-icon-button-radius);
  background: transparent;
  color: var(--buddy-text-primary);
  cursor: pointer;

  .n-icon {
    font-size: 18px;
  }

  &:hover:not(:disabled) {
    background: var(--buddy-state-hover);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }
}
</style>

<script setup lang="ts">
import type { InputInst } from 'naive-ui'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import {
  Chat20Regular,
  ChevronDown20Regular,
  ChevronUp20Regular,
  Dismiss20Regular,
  Search20Regular,
} from '@vicons/fluent'
import { NInput } from 'naive-ui'
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  viewMode?: 'chat' | 'canvas'
  activeSearchIndex: number
  canSearchConversation: boolean
  conversationSearchLoading: boolean
  conversationSearchOpen: boolean
  conversationSearchQuery: string
  conversationSearchResultCount: number
  language: BuddyLocale
  title: string
}>()
const emit = defineEmits<{
  toggleCanvas: []
  closeConversationSearch: []
  nextConversationSearchResult: []
  openConversationSearch: []
  previousConversationSearchResult: []
  updateConversationSearch: [query: string]
}>()

const searchInput = useTemplateRef<InputInst>('searchInput')
const { t } = useBuddyI18n(() => props.language)
const searchPosition = computed(() => {
  if (props.conversationSearchLoading)
    return t('desktop.chat.searchLoading')
  if (!props.conversationSearchResultCount)
    return '0 / 0'
  return `${props.activeSearchIndex + 1} / ${props.conversationSearchResultCount}`
})

watch(
  () => props.conversationSearchOpen,
  async (open) => {
    if (!open)
      return
    await nextTick()
    searchInput.value?.focus()
  },
)
</script>

<template>
  <header class="desktop-chat-workspace-header">
    <div class="desktop-chat-workspace-header__copy">
      <strong>{{ title }}</strong>
    </div>

    <div class="desktop-chat-workspace-header__actions">
      <div v-if="conversationSearchOpen" class="desktop-chat-workspace-header__search-control">
        <NInput
          ref="searchInput"
          clearable
          :input-props="{ 'aria-label': t('desktop.chat.searchOpen') }"
          size="small"
          :placeholder="t('desktop.chat.searchPlaceholder')"
          :value="conversationSearchQuery"
          @update:value="emit('updateConversationSearch', $event)"
        >
          <template #prefix>
            <DesktopIcon :component="Search20Regular" />
          </template>
        </NInput>
        <span class="desktop-chat-workspace-header__search-position">{{ searchPosition }}</span>
        <button
          class="desktop-chat-workspace-header__icon-button"
          type="button"
          :aria-label="t('desktop.chat.searchPrevious')"
          :disabled="!conversationSearchResultCount"
          @click="emit('previousConversationSearchResult')"
        >
          <DesktopIcon :component="ChevronUp20Regular" />
        </button>
        <button
          class="desktop-chat-workspace-header__icon-button"
          type="button"
          :aria-label="t('desktop.chat.searchNext')"
          :disabled="!conversationSearchResultCount"
          @click="emit('nextConversationSearchResult')"
        >
          <DesktopIcon :component="ChevronDown20Regular" />
        </button>
        <button
          class="desktop-chat-workspace-header__icon-button"
          type="button"
          :aria-label="t('desktop.chat.searchClose')"
          @click="emit('closeConversationSearch')"
        >
          <DesktopIcon :component="Dismiss20Regular" />
        </button>
      </div>

      <button
        v-else-if="canSearchConversation"
        class="desktop-chat-workspace-header__icon-button"
        type="button"
        :aria-label="t('desktop.chat.searchOpen')"
        @click="emit('openConversationSearch')"
      >
        <DesktopIcon :component="Search20Regular" />
      </button>
      <button
        v-if="canSearchConversation"
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
  padding: 0 0.9rem 0 1.1rem;
}

.desktop-chat-workspace-header__copy {
  display: grid;
  min-width: 5rem;
  gap: 0.05rem;

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

.desktop-chat-workspace-header__actions,
.desktop-chat-workspace-header__search-control {
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: 0.18rem;
}

.desktop-chat-workspace-header__search-control :deep(.n-input) {
  width: clamp(10rem, 18vw, 16rem);
}

.desktop-chat-workspace-header__search-position {
  min-width: 3.25rem;
  color: var(--buddy-text-secondary);
  font-size: 0.68rem;
  text-align: center;
  white-space: nowrap;
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

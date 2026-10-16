<script setup lang="ts">
import type { ReadableDocumentSearchResult } from '@/apis/document'
import { Close, Search } from '@element-plus/icons-vue'
import { nextTick, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatDocumentSearch } from './useChatDocumentSearch'

const props = defineProps<{
  visible: boolean
}>()

const emits = defineEmits<{
  close: []
  select: [document: ReadableDocumentSearchResult]
}>()
const { t } = useI18n({ useScope: 'global' })

const searchInputRef = useTemplateRef<HTMLInputElement>('searchInput')
const {
  query,
  documents,
  isLoading,
  errorMessage,
  hasQuery,
  isEmpty,
  setQuery,
  reset,
} = useChatDocumentSearch()

watch(() => props.visible, async (visible) => {
  if (!visible) {
    reset()
    return
  }

  await nextTick()
  searchInputRef.value?.focus()
})

function handleSelect(document: ReadableDocumentSearchResult) {
  emits('select', document)
  reset()
}

function handleInput(event: Event) {
  setQuery(event.target instanceof HTMLInputElement ? event.target.value : '')
}
</script>

<template>
  <div v-if="props.visible" class="chat-document-picker-overlay" @mousedown.self="emits('close')">
    <div class="chat-document-picker" role="dialog" :aria-label="t('chat.composer.documentPicker.aria')" @mousedown.stop>
      <div class="chat-document-picker__search">
        <ElIcon class="chat-document-picker__search-icon">
          <Search />
        </ElIcon>
        <input
          ref="searchInput"
          class="chat-document-picker__input"
          :value="query"
          :aria-label="t('chat.composer.documentPicker.search')"
          :placeholder="t('chat.composer.documentPicker.search')"
          @input="handleInput"
          @keydown.esc="emits('close')"
        >
        <button
          class="chat-document-picker__close"
          type="button"
          :aria-label="t('chat.composer.documentPicker.close')"
          @click="emits('close')"
        >
          <ElIcon><Close /></ElIcon>
        </button>
      </div>

      <div class="chat-document-picker__body">
        <div v-if="isLoading" class="chat-document-picker__state">
          {{ t('chat.composer.documentPicker.loading') }}
        </div>
        <div v-else-if="errorMessage" class="chat-document-picker__state is-error">
          {{ errorMessage }}
        </div>
        <div v-else-if="!hasQuery" class="chat-document-picker__state">
          {{ t('chat.composer.documentPicker.idle') }}
        </div>
        <div v-else-if="isEmpty" class="chat-document-picker__state">
          {{ t('chat.composer.documentPicker.empty') }}
        </div>
        <template v-else>
          <button
            v-for="document in documents"
            :key="document.id"
            class="chat-document-picker__item"
            type="button"
            @click="handleSelect(document)"
          >
            <SvgIcon category="ui" icon="document-tree-file" size="1rem" class="chat-document-picker__item-icon" />
            <span class="chat-document-picker__item-title">{{ document.title }}</span>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.chat-document-picker-overlay {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: color-mix(in srgb, var(--brand-bg-base) 72%, transparent);
  -webkit-backdrop-filter: blur(1.5px);
  backdrop-filter: blur(1.5px);
  pointer-events: auto;
}

.chat-document-picker {
  width: min(24rem, 100%);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 86%, transparent);
  border-radius: 0.5rem;
  background: var(--brand-bg-surface-raised);
  box-shadow: var(--brand-shadow-floating);
  pointer-events: auto;

  .chat-document-picker__search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 66%, transparent);
  }

  .chat-document-picker__search-icon {
    color: var(--brand-text-secondary);
  }

  .chat-document-picker__input {
    min-width: 0;
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--brand-text-primary);
    font-size: 0.875rem;
  }

  .chat-document-picker__input::placeholder {
    color: var(--brand-text-placeholder);
  }

  .chat-document-picker__close {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--brand-text-secondary);
    cursor: pointer;

    &:hover {
      background: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
      color: var(--brand-text-primary);
    }
  }

  .chat-document-picker__body {
    min-height: 3.5rem;
    max-height: 16rem;
    overflow-y: auto;
    padding: 0.25rem;
  }

  .chat-document-picker__state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 3rem;
    padding: 0.5rem 0.625rem;
    color: var(--brand-text-secondary);
    font-size: 0.8125rem;
    text-align: center;
  }

  .chat-document-picker__state.is-error {
    color: var(--el-color-danger);
  }

  .chat-document-picker__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-width: 0;
    padding: 0.5rem;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--brand-text-primary);
    cursor: pointer;
    font-size: 0.875rem;
    text-align: left;

    &:hover {
      background: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
    }
  }

  .chat-document-picker__item-icon {
    flex: none;
    color: var(--brand-text-secondary);
  }

  .chat-document-picker__item-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>

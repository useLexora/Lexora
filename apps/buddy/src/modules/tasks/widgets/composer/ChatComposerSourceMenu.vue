<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatPromptContextOption } from '@/modules/prompt-input'
import { Add20Regular, ArrowLeft16Regular, ArrowUpload20Regular, ChatMultiple20Regular } from '@vicons/fluent'
import { useEventListener } from '@vueuse/core'
import { NButton, NInput, NPopover } from 'naive-ui'
import { nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import ChatComposerSourcePicker from './ChatComposerSourcePicker.vue'

const props = defineProps<{
  disabled: boolean
  language: BuddyLocale
  loading: boolean
  options: readonly ChatPromptContextOption[]
}>()
const emit = defineEmits<{
  attach: []
  query: [value: string]
  select: [option: ChatPromptContextOption]
}>()
const show = defineModel<boolean>('show', { required: true })
const { t } = useBuddyI18n(() => props.language)
const sourceMenuView = shallowRef<'menu' | 'files'>('menu')
const sourcePickerQuery = shallowRef('')
const sourcePopoverThemeOverrides = { padding: '8px' } as const
const sourceTrigger = useTemplateRef<ComponentPublicInstance>('sourceTrigger')

watch(show, (visible) => {
  sourceMenuView.value = 'menu'
  if (visible)
    sourcePickerQuery.value = ''
})
useEventListener(document, 'keydown', handleDocumentKeydown)

function chooseLocalFiles() {
  show.value = false
  emit('attach')
}

function openConversationFilePicker() {
  sourceMenuView.value = 'files'
  sourcePickerQuery.value = ''
  emit('query', '')
}

function handleSourceMenuVisibility(visible: boolean) {
  show.value = visible
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !show.value)
    return

  event.preventDefault()
  show.value = false
  sourceMenuView.value = 'menu'
  sourcePickerQuery.value = ''
  void nextTick(() => {
    const trigger = sourceTrigger.value?.$el as HTMLButtonElement | undefined
    trigger?.focus()
  })
}
</script>

<template>
  <NPopover
    placement="top-start"
    :show="show"
    :show-arrow="false"
    :theme-overrides="sourcePopoverThemeOverrides"
    trigger="click"
    @update:show="handleSourceMenuVisibility"
  >
    <template #trigger>
      <NButton
        ref="sourceTrigger"
        class="buddy-icon-button desktop-chat-composer__source-trigger"
        :class="{ 'is-open': show }"
        quaternary
        :aria-expanded="show"
        aria-haspopup="menu"
        :aria-label="t(show ? 'desktop.chat.closeAttachmentMenu' : 'desktop.chat.addAttachment')"
        :disabled="disabled"
      >
        <template #icon>
          <DesktopIcon class="desktop-chat-composer__source-trigger-icon" :component="Add20Regular" />
        </template>
      </NButton>
    </template>

    <div
      v-if="show"
      class="desktop-chat-composer__source-menu grid w-fit min-w-[min(8.5rem,_calc(100vw_-_2rem))] max-w-[min(13rem,_calc(100vw_-_2rem))] gap-[0.125rem] overflow-hidden"
      :class="{ 'is-files': sourceMenuView === 'files' }"
    >
      <template v-if="sourceMenuView === 'menu'">
        <button
          class="desktop-chat-composer__source-action grid w-full grid-cols-[1.1rem_minmax(0,_1fr)] py-[0.36rem] px-[0.35rem] gap-x-2 text-[0.8rem] leading-[1.35]"
          type="button"
          @click="chooseLocalFiles"
        >
          <DesktopIcon class="desktop-chat-composer__source-action-icon" :component="ArrowUpload20Regular" />
          <span>{{ t('desktop.chat.addLocalFile') }}</span>
        </button>
        <button
          class="desktop-chat-composer__source-action grid w-full grid-cols-[1.1rem_minmax(0,_1fr)] py-[0.36rem] px-[0.35rem] gap-x-2 text-[0.8rem] leading-[1.35]"
          type="button"
          @click="openConversationFilePicker"
        >
          <DesktopIcon class="desktop-chat-composer__source-action-icon" :component="ChatMultiple20Regular" />
          <span>{{ t('desktop.chat.selectConversationFile') }}</span>
        </button>
      </template>
      <template v-else>
        <div class="flex items-center">
          <button
            class="desktop-chat-composer__source-back py-1 px-[0.35rem] text-muted text-[0.75rem]"
            type="button"
            @click="sourceMenuView = 'menu'"
          >
            <DesktopIcon :component="ArrowLeft16Regular" />
            <span>{{ t('desktop.chat.sourcePickerBack') }}</span>
          </button>
        </div>
        <NInput
          v-model:value="sourcePickerQuery"
          clearable
          size="small"
          :placeholder="t('desktop.chat.sourcePickerSearch')"
          @update:value="emit('query', $event)"
        />
        <ChatComposerSourcePicker
          :accessible-label="t('desktop.chat.sourcePickerTitle')"
          :empty-label="t('desktop.chat.sourcePickerEmpty')"
          :files-only="true"
          :language="language"
          :loading="loading"
          :loading-label="t('desktop.chat.loadingContext')"
          :options="options"
          @select="emit('select', $event)"
        />
      </template>
    </div>
  </NPopover>
</template>

<style scoped lang="scss">
.desktop-chat-composer__source-trigger {
  --n-height: var(--buddy-composer-control-height);

  width: var(--buddy-composer-control-height);
  min-width: var(--buddy-composer-control-height);
  height: var(--buddy-composer-control-height);
}

.desktop-chat-composer__source-trigger.is-open {
  background: var(--buddy-accent-surface-subtle);
  color: var(--buddy-text-strong);
}

.desktop-chat-composer__source-trigger-icon {
  transform-origin: center;
  transition: transform 150ms var(--buddy-motion-state-easing);
}

.desktop-chat-composer__source-trigger.is-open .desktop-chat-composer__source-trigger-icon {
  transform: rotate(45deg);
}

.desktop-chat-composer__source-menu {
  interpolate-size: allow-keywords;
  transition: width 160ms var(--buddy-motion-state-easing);

  &.is-files {
    width: min(22rem, calc(100vw - 2rem));
    min-width: min(22rem, calc(100vw - 2rem));
    max-width: min(22rem, calc(100vw - 2rem));
    gap: 0.35rem;
  }
}

.desktop-chat-composer__source-action,
.desktop-chat-composer__source-back {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 0;
  border-radius: var(--buddy-menu-item-radius);
  background: transparent;
  color: var(--buddy-text-primary);
  cursor: pointer;
  font: inherit;
  text-align: left;
  white-space: nowrap;

  &:hover,
  &:focus-visible {
    background: var(--buddy-state-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}

.desktop-chat-composer__source-action-icon {
  flex: none;
  color: var(--buddy-text-secondary);
  font-size: 1.05rem;
}

@media (prefers-reduced-motion: reduce) {
  .desktop-chat-composer__source-trigger-icon,
  .desktop-chat-composer__source-menu {
    transition-duration: 0ms;
  }
}
</style>

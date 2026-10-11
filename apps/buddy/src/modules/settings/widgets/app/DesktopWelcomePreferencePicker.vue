<script setup lang="ts">
import type { DesktopChatWelcomePreference } from '@buddy-electron/shared/desktopApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown16Regular } from '@vicons/fluent'
import { NPopover } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DESKTOP_CHAT_WELCOME_VARIANTS } from '@/shared/branding/welcome/desktopChatWelcomeVariants'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  pending: boolean
  value: DesktopChatWelcomePreference
}>()

const emit = defineEmits<{
  select: [value: DesktopChatWelcomePreference]
}>()

const { t } = useBuddyI18n(() => props.language)
const panelOpen = shallowRef(false)
const defaultPreferences = ['none', 'random'] as const
const currentLabel = computed(() => {
  if (props.value === 'none')
    return t('desktop.settings.welcomeNone')
  if (props.value === 'random')
    return t('desktop.settings.welcomeRandom')

  const variant = DESKTOP_CHAT_WELCOME_VARIANTS.find(item => item.id === props.value)
  return variant ? t(variant.titleKey) : t('desktop.settings.welcomeRandom')
})

function selectPreference(preference: DesktopChatWelcomePreference) {
  if (props.pending || preference === props.value)
    return
  emit('select', preference)
}
</script>

<template>
  <NPopover
    class="buddy-raw-popover"
    :show="panelOpen"
    trigger="click"
    placement="bottom-end"
    raw
    to=".buddy-app"
    :show-arrow="false"
    @update:show="panelOpen = $event"
  >
    <template #trigger>
      <button
        class="desktop-welcome-preference-picker__trigger grid w-full min-w-0 min-h-[2.35rem] grid-cols-[minmax(0,_1fr)_auto] items-center gap-[0.65rem] border-1 border-solid border-border-strong rounded-1 bg-raised text-fg py-[0.35rem] px-[0.65rem] text-[0.8rem] text-left hover:border-accent-border"
        type="button"
        aria-haspopup="dialog"
        :aria-expanded="panelOpen"
      >
        <span>{{ currentLabel }}</span>
        <DesktopIcon
          class="desktop-welcome-preference-picker__chevron"
          :class="{ 'is-open': panelOpen }"
          :component="ChevronDown16Regular"
        />
      </button>
    </template>

    <section
      class="w-[min(34rem,_calc(100vw_-_2rem))] overflow-hidden border-1 border-solid border-border rounded-[0.65rem] bg-raised shadow-overlay p-[0.8rem]"
      role="dialog"
      :aria-label="t('desktop.settings.welcome')"
    >
      <header class="desktop-welcome-preference-picker__header flex items-center min-h-[1.8rem] text-strong">
        <strong>{{ t('desktop.settings.welcome') }}</strong>
      </header>

      <div class="grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[0.65rem]">
        <button
          v-for="preference in defaultPreferences"
          :key="preference"
          class="desktop-welcome-preference-picker__mode w-full min-h-[2.55rem] border-1 border-solid border-border rounded-[0.45rem] bg-surface text-fg text-[0.78rem] font-600 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
          :class="{ 'is-selected': value === preference }"
          type="button"
          :aria-pressed="value === preference"
          :disabled="pending"
          @click="selectPreference(preference)"
        >
          {{ t(preference === 'none' ? 'desktop.settings.welcomeNone' : 'desktop.settings.welcomeRandom') }}
        </button>
      </div>

      <div class="desktop-welcome-preference-picker__specific grid gap-[0.55rem] border-t-1 border-t-solid border-t-border mt-3 pt-[0.7rem]">
        <strong>{{ t('desktop.settings.welcomeSpecific') }}</strong>
        <div class="desktop-welcome-preference-picker__options flex gap-[0.65rem] overflow-x-auto pt-[0.1rem] pr-[0.1rem] pb-[0.45rem] pl-[0.1rem]" role="group">
          <button
            v-for="variant in DESKTOP_CHAT_WELCOME_VARIANTS"
            :key="variant.id"
            class="desktop-welcome-preference-picker__option grid min-h-43 grid-rows-[7.6rem_minmax(2.25rem,_auto)] items-center gap-[0.2rem] border-1 border-solid border-border rounded-2 bg-surface text-fg pt-[0.35rem] pr-2 pb-[0.55rem] pl-2 text-center focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
            :class="{ 'is-selected': value === variant.id }"
            type="button"
            :aria-pressed="value === variant.id"
            :disabled="pending"
            @click="selectPreference(variant.id)"
          >
            <img
              class="desktop-welcome-preference-picker__illustration w-[7.4rem] h-[7.4rem] select-none"
              :src="variant.illustrationUrl"
              alt=""
              draggable="false"
            >
            <span>{{ t(variant.titleKey) }}</span>
          </button>
        </div>
      </div>
    </section>
  </NPopover>
</template>

<style scoped lang="scss">
.desktop-welcome-preference-picker__trigger {
  transition:
    border-color 100ms ease,
    box-shadow 100ms ease;

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:focus-visible {
    border-color: var(--buddy-focus-ring);
    outline: 0;
    box-shadow: 0 0 0 2px var(--buddy-accent-surface-hover);
  }
}

.desktop-welcome-preference-picker__chevron {
  color: var(--buddy-text-secondary);
  transition: transform 120ms ease;

  &.is-open {
    transform: rotate(180deg);
  }
}

.desktop-welcome-preference-picker__header {
  strong {
    font-size: 0.82rem;
    font-weight: 600;
  }
}

.desktop-welcome-preference-picker__mode {
  transition:
    background-color 100ms ease,
    border-color 100ms ease,
    box-shadow 100ms ease;

  &:not(:disabled) {
    cursor: pointer;
  }

  &:not(:disabled):hover {
    border-color: var(--buddy-accent-border);
    background: var(--buddy-accent-surface);
  }

  &.is-selected {
    border-color: var(--buddy-focus-ring);
    background: var(--buddy-accent-surface-hover);
    color: var(--buddy-accent-on-surface);
  }
}

.desktop-welcome-preference-picker__specific {
  > strong {
    color: var(--buddy-text-secondary);
    font-size: 0.7rem;
    font-weight: 600;
  }
}

.desktop-welcome-preference-picker__options {
  overscroll-behavior-inline: contain;
  scroll-snap-type: inline proximity;
  scrollbar-color: var(--buddy-border-strong) transparent;
  scrollbar-width: thin;
}

.desktop-welcome-preference-picker__option {
  flex: 0 0 9.75rem;
  scroll-snap-align: start;
  transition:
    background-color 100ms ease,
    border-color 100ms ease,
    box-shadow 100ms ease;

  &:not(:disabled) {
    cursor: pointer;
  }

  &:not(:disabled):hover {
    border-color: var(--buddy-accent-border);
    background: var(--buddy-accent-surface);
  }

  &.is-selected {
    border-color: var(--buddy-focus-ring);
    background: var(--buddy-accent-surface-hover);
    color: var(--buddy-accent-on-surface);
  }

  > span {
    overflow-wrap: anywhere;
    font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, serif;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    line-height: 1.45;
  }
}

.desktop-welcome-preference-picker__illustration {
  place-self: center;
  object-fit: contain;
}
</style>

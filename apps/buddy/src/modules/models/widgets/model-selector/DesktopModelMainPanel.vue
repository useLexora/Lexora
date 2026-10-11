<script setup lang="ts">
import type { BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight16Regular, Flash20Filled } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  isMeterDragging: boolean
  effortTransitionDirection: 'increasing' | 'decreasing'
  displayedEffort: BuddyThinkingLevel | null
  displayedEffortLabel: string
  supportsFastMode: boolean
  isFastMode: boolean
}>()
const emit = defineEmits<{ advanced: [], toggleFast: [] }>()
defineSlots<{ default?: () => unknown }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <section
    class="desktop-model-selector__panel desktop-model-selector__panel--spell relative flex-none w-[min(17rem,calc(100vw_-_2rem))] overflow-hidden border border-solid border-border rounded-menu shadow-overlay pt-[0.375rem] px-2 pb-2"
  >
    <div class="flex items-center justify-between min-h-menu-row">
      <button
        class="desktop-model-selector__advanced inline-flex min-w-12 h-7 items-center justify-center gap-0 border-0 rounded-menu-item bg-transparent text-muted cursor-pointer text-[0.74rem] leading-[1] py-1 px-[0.3rem] hover:(bg-hover text-strong outline-0) focus-visible:(bg-hover text-strong outline-0)"
        type="button"
        @click="emit('advanced')"
      >
        <span>{{ t('desktop.chat.advanced') }}</span>
        <DesktopIcon class="flex-none mx-[-0.125rem] [transform:translateY(-0.04rem)]" :size="16" :component="ChevronRight16Regular" />
      </button>
      <span class="grid min-w-7 min-h-7 items-center justify-items-end">
        <Transition name="desktop-model-selector__status" mode="out-in">
          <span
            v-if="isMeterDragging"
            key="reasoning-level"
            class="desktop-model-selector__dragging-effort grid text-muted text-[0.76rem] leading-[1] px-[0.4rem]"
            :class="`is-${effortTransitionDirection}`"
          >
            <Transition :name="`desktop-model-selector__effort-${effortTransitionDirection}`">
              <span
                :key="displayedEffort ?? 'none'"
                class="[grid-area:1_/_1] justify-self-end whitespace-nowrap"
              >
                {{ displayedEffortLabel }}
              </span>
            </Transition>
          </span>
          <button
            v-else-if="supportsFastMode"
            key="fast-toggle"
            class="desktop-model-selector__fast-toggle grid w-7 h-7 place-items-center border-0 rounded-icon bg-transparent cursor-pointer p-0 transition-state-colors hover:(bg-hover outline-0) focus-visible:(bg-hover outline-0)"
            :class="isFastMode ? 'is-active text-gold hover:text-gold focus-visible:text-gold' : 'text-muted hover:text-strong focus-visible:text-strong'"
            type="button"
            role="switch"
            :aria-checked="isFastMode"
            :aria-label="t('desktop.chat.fastMode')"
            @click="emit('toggleFast')"
          >
            <DesktopIcon :component="Flash20Filled" />
          </button>
        </Transition>
      </span>
    </div>

    <div class="relative z-1">
      <slot>
        <div class="text-muted text-[0.72rem] pt-[0.55rem] pr-[0.35rem] pb-[0.45rem] pl-[0.35rem]">
          {{ t('desktop.chat.noReasoningLevels') }}
        </div>
      </slot>
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-model-selector__panel--spell {
  --desktop-model-spell-glow:
    radial-gradient(ellipse at 42% 50%, rgb(217 166 83 / 18%), transparent 43%),
    radial-gradient(ellipse at 70% 50%, rgb(53 83 165 / 14%), transparent 46%);

  background: linear-gradient(145deg, #fff, color-mix(in srgb, var(--buddy-surface-raised) 94%, #f8f6f0));

  &::after {
    position: absolute;
    right: 0.75rem;
    bottom: -1.4rem;
    left: 0.75rem;
    height: 2.7rem;
    border-radius: 50%;
    background: var(--desktop-model-spell-glow);
    content: '';
    filter: blur(0.75rem);
    pointer-events: none;
  }
}

:global(:root[data-buddy-theme='dark'] .desktop-model-selector__panel--spell) {
  --desktop-model-spell-glow:
    radial-gradient(ellipse at 42% 50%, rgb(218 164 78 / 20%), transparent 43%),
    radial-gradient(ellipse at 72% 50%, rgb(51 80 174 / 24%), transparent 48%);

  border-color: rgb(255 255 255 / 13%);
  background: linear-gradient(145deg, #20242c, #171a21 76%);
  box-shadow:
    0 1px 2px rgb(0 0 0 / 28%),
    0 10px 24px rgb(0 0 0 / 36%);
}

.desktop-model-selector__effort {
  &-increasing-enter-active,
  &-increasing-leave-active,
  &-decreasing-enter-active,
  &-decreasing-leave-active {
    transition:
      filter 100ms ease,
      opacity 90ms ease,
      transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
    will-change: filter, opacity, transform;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  }

  &-increasing-enter-from,
  &-decreasing-leave-to {
    filter: blur(1px);
    opacity: 0;
    transform: translateX(-0.22rem);
  }

  &-increasing-leave-to,
  &-decreasing-enter-from {
    filter: blur(1px);
    opacity: 0;
    transform: translateX(0.22rem);
  }
}

.desktop-model-selector__status {
  &-enter-active,
  &-leave-active {
    transition:
      opacity 90ms ease,
      transform 120ms ease;
  }

  &-enter-from {
    opacity: 0;
    transform: translateY(0.2rem);
  }

  &-leave-to {
    opacity: 0;
    transform: translateY(-0.2rem);
  }
}

.desktop-model-selector__fast-toggle.is-active {
  background: color-mix(in srgb, var(--buddy-brand-gold) 14%, transparent);
  filter: drop-shadow(0 0 0.35rem color-mix(in srgb, var(--buddy-brand-gold) 44%, transparent));
}
</style>

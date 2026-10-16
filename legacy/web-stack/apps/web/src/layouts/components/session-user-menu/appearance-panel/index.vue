<script setup lang="ts">
import type { AppearancePreference } from '@haohaoxue/lexora-contracts'
import type { SessionAppearancePanelProps } from '../typing'

const props = defineProps<SessionAppearancePanelProps>()
const emits = defineEmits<{
  select: [mode: AppearancePreference]
}>()
</script>

<template>
  <div class="session-user-menu-subpanel absolute left-[calc(100%+10px)] top-1/2 z-[8] w-[172px] -translate-y-1/2 p-1">
    <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
      <li
        v-for="option in props.options"
        :key="option.value"
        class="session-appearance-option list-none"
        :class="{
          'is-active': props.currentAppearance === option.value,
          'is-disabled': props.isSaving,
        }"
      >
        <button
          type="button"
          class="session-appearance-option__button flex min-h-8 w-full items-center rounded-lg border-0 bg-transparent px-2 py-1"
          :disabled="props.isSaving"
          @click.stop="emits('select', option.value)"
        >
          <span class="session-appearance-option__content flex h-full w-full items-center justify-between gap-2.5 text-left">
            <span class="session-appearance-option__label min-w-0">
              <span class="truncate text-[13px] font-medium leading-none text-main">
                {{ option.label }}
              </span>
            </span>

            <span class="session-appearance-option__indicator flex w-3 shrink-0 items-center justify-center">
              <SvgIcon
                category="ui"
                icon="check"
                size="12px"
                class="session-appearance-option__check"
                :class="{ 'is-visible': props.currentAppearance === option.value }"
              />
            </span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.session-user-menu-subpanel {
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  border-radius: 8px;
  background: var(--brand-bg-surface);
  box-shadow: var(--brand-shadow-hairline);
}

.session-appearance-option__button {
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    opacity 0.2s ease;

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--brand-primary) 18%, transparent);
    outline-offset: 2px;
  }

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--brand-fill-light) 82%, var(--brand-bg-surface));
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }
}

.session-appearance-option.is-active .session-appearance-option__button {
  color: var(--brand-text-primary);
  background: color-mix(in srgb, var(--brand-primary) 8%, var(--brand-bg-surface));

  :deep(.text-main) {
    color: var(--brand-text-primary);
  }
}

.session-appearance-option__check {
  color: var(--brand-primary);
  opacity: 0;
  transition: opacity 0.2s ease;

  &.is-visible {
    opacity: 1;
  }
}
</style>

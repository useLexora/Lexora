<script setup lang="ts">
import type { AuthEntryShellProps, AuthEntryShellSlots } from './typing'
import { LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'

const props = defineProps<AuthEntryShellProps>()

defineSlots<AuthEntryShellSlots>()

const { t } = useI18n({ useScope: 'global' })
const userStore = useUserStore()
const currentLanguageLabel = computed(() =>
  userStore.resolvedLanguage === LANGUAGE_PREFERENCE.ZH_CN
    ? t('auth.common.languageChinese')
    : t('auth.common.languageEnglish'),
)
const languageOptions = computed(() => [
  {
    value: LANGUAGE_PREFERENCE.ZH_CN,
    label: t('auth.common.languageChinese'),
  },
  {
    value: LANGUAGE_PREFERENCE.EN_US,
    label: t('auth.common.languageEnglish'),
  },
])

function switchLanguage(command: string | number | object) {
  if (command !== LANGUAGE_PREFERENCE.ZH_CN && command !== LANGUAGE_PREFERENCE.EN_US) {
    return
  }

  userStore.setLocalLanguagePreference(command)
}
</script>

<template>
  <div class="auth-entry-shell relative flex min-h-screen min-h-dvh items-center justify-center overflow-hidden p-5">
    <div class="auth-entry-shell__backdrop auth-entry-shell__backdrop--top" aria-hidden="true" />
    <div class="auth-entry-shell__backdrop auth-entry-shell__backdrop--bottom" aria-hidden="true" />

    <div class="auth-entry-shell__global-actions absolute right-[clamp(1rem,3vw,2.5rem)] top-[clamp(1rem,3vw,2rem)] z-2">
      <ElDropdown
        trigger="click"
        placement="bottom-end"
        popper-class="auth-entry-shell__language-menu"
        @command="switchLanguage"
      >
        <button
          type="button"
          class="auth-entry-shell__language-trigger"
          :aria-label="t('auth.common.language')"
        >
          <SvgIcon category="ui" icon="translate" size="1.0625rem" class="auth-entry-shell__language-switch-icon" />
          <span class="auth-entry-shell__language-switch-text">{{ currentLanguageLabel }}</span>
          <SvgIcon category="ui" icon="chevron-down" size="0.875rem" class="auth-entry-shell__language-chevron" />
        </button>
        <template #dropdown>
          <ElDropdownMenu>
            <ElDropdownItem
              v-for="item in languageOptions"
              :key="item.value"
              :command="item.value"
              :class="{ 'is-selected': userStore.resolvedLanguage === item.value }"
            >
              {{ item.label }}
            </ElDropdownItem>
          </ElDropdownMenu>
        </template>
      </ElDropdown>
    </div>

    <ElCard shadow="never" body-class="!p-0" class="auth-entry-shell__card relative w-full max-w-[34rem] overflow-hidden rounded-lg">
      <section
        class="auth-entry-shell__panel relative flex flex-col gap-6 p-[clamp(1.75rem,4vw,2.5rem)] backdrop-blur-[8px]"
      >
        <div v-if="$slots.actions" class="auth-entry-shell__actions absolute right-[clamp(1.25rem,4vw,2.5rem)] top-[clamp(1.25rem,4vw,2.5rem)] z-1">
          <slot name="actions" />
        </div>

        <div class="auth-entry-shell__brand flex items-center gap-3.5" :class="{ 'pr-44': $slots.actions }">
          <div class="auth-entry-shell__brand-mark flex h-12 w-12 shrink-0 items-center justify-center rounded-[1rem]">
            <img
              src="/app-icon.png"
              alt=""
              aria-hidden="true"
              class="auth-entry-shell__brand-mark-image block h-11 w-11 rounded-[0.875rem] object-cover"
            >
          </div>
          <div class="auth-entry-shell__brand-text min-w-0">
            <div class="auth-entry-shell__brand-name text-lg font-bold whitespace-nowrap text-main">
              Lexora
            </div>
          </div>
        </div>

        <header class="auth-entry-shell__header flex flex-col gap-3.5">
          <h1 class="auth-entry-shell__title m-0 text-[2.75rem] font-bold leading-[1.05] text-main max-sm:text-[2rem]">
            {{ props.title }}
          </h1>
          <p v-if="props.description" class="auth-entry-shell__description m-0 text-[15px] leading-[1.75] text-secondary">
            {{ props.description }}
          </p>
        </header>

        <div class="auth-entry-shell__body flex flex-col gap-4">
          <slot />
        </div>

        <footer class="auth-entry-shell__footer flex flex-wrap items-center gap-1.5 pt-1 text-sm text-secondary">
          <slot name="footer" />
        </footer>
      </section>
    </ElCard>
  </div>
</template>

<style scoped lang="scss">
.auth-entry-shell {
  background:
    radial-gradient(circle at 92% 18%, color-mix(in srgb, var(--brand-primary) 12%, transparent), transparent 24rem),
    radial-gradient(circle at 8% 86%, color-mix(in srgb, var(--brand-warning) 11%, transparent), transparent 20rem),
    radial-gradient(circle at 36% 56%, color-mix(in srgb, var(--brand-primary) 5%, transparent), transparent 24rem),
    linear-gradient(180deg, color-mix(in srgb, var(--brand-bg-sidebar) 82%, white 18%), var(--brand-bg-sidebar));

  &__global-actions {
    position: absolute;
  }

  &__language-trigger {
    display: inline-flex;
    min-height: 2.25rem;
    align-items: center;
    gap: 0.375rem;
    padding: 0;
    border: 0;
    color: var(--brand-text-primary);
    background: transparent;
    font-weight: 700;
    cursor: pointer;
    transition: color 0.2s ease;

    &:hover {
      color: var(--brand-primary);
    }

    &:focus-visible {
      border-radius: 6px;
      outline: 2px solid color-mix(in srgb, var(--brand-primary) 34%, transparent);
      outline-offset: 0.25rem;
    }
  }

  &__language-switch-text {
    font-size: 0.8125rem;
    line-height: 1;
    white-space: nowrap;
  }

  &__language-chevron {
    color: var(--brand-text-secondary);
  }

  &__backdrop {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    filter: blur(72px);
    opacity: 0.55;
  }

  &__backdrop--top {
    top: 4rem;
    right: 2rem;
    width: 15rem;
    height: 15rem;
    background: color-mix(in srgb, var(--brand-primary) 20%, white);
  }

  &__backdrop--bottom {
    bottom: 2rem;
    left: 3rem;
    width: 11rem;
    height: 11rem;
    background: color-mix(in srgb, var(--brand-warning) 18%, white);
  }

  &__card {
    border-color: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    box-shadow: 0 32px 88px -56px color-mix(in srgb, var(--brand-primary) 28%, transparent);
  }

  &__panel {
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--brand-bg-surface) 96%, white 4%), var(--brand-bg-surface));
  }

  &__body {
    :deep(.el-form-item__label) {
      padding-bottom: 0.5rem;
      color: color-mix(in srgb, var(--brand-text-primary) 78%, var(--brand-text-secondary));
      font-weight: 700;
      line-height: 1.2;
    }

    :deep(.el-input__wrapper) {
      border-radius: 7px;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-border-base) 78%, transparent) inset;
      transition: box-shadow 0.2s ease, background-color 0.2s ease;
    }

    :deep(.el-input__wrapper:hover) {
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-primary) 28%, var(--brand-border-dark)) inset;
    }

    :deep(.el-input__wrapper.is-focus) {
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--brand-primary) 72%, var(--brand-border-dark)) inset,
        0 0 0 3px color-mix(in srgb, var(--brand-primary) 12%, transparent);
    }
  }

  &__footer:empty {
    display: none;
  }
}

:global(.auth-entry-shell__language-menu) {
  min-width: 8rem;
}

:global(.auth-entry-shell__language-menu .el-dropdown-menu__item) {
  min-height: 2.375rem;
  font-weight: 600;
}

:global(.auth-entry-shell__language-menu .el-dropdown-menu__item.is-selected) {
  color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
}
</style>

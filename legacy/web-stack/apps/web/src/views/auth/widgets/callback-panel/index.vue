<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useCallback } from '../../composables/useCallback'
import AuthEntryShell from '../../layouts/entry-shell'

const { statusLabel, errorMessage, pageDescription } = useCallback()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <AuthEntryShell
    :title="statusLabel"
    :description="pageDescription"
  >
    <div class="auth-callback__status mb-2 flex justify-center">
      <div v-if="!errorMessage" class="auth-callback__spinner" />
      <div v-else class="auth-callback__error-mark mb-6 flex h-12 w-12 items-center justify-center rounded-full text-[1.5rem]">
        <SvgIcon category="ui" icon="error" size="1.5rem" />
      </div>
    </div>

    <ElAlert
      v-if="errorMessage"
      class="auth-callback__alert"
      type="error"
      :title="errorMessage"
      :closable="false"
    />

    <template #footer>
      <RouterLink v-if="errorMessage" :to="{ name: 'login' }" class="auth-callback__back-link text-primary font-semibold no-underline">
        {{ t('auth.common.returnLogin') }}
      </RouterLink>
      <span v-else class="auth-callback__hint text-sm text-secondary">{{ t('auth.callback.keepOpen') }}</span>
    </template>
  </AuthEntryShell>
</template>

<style scoped lang="scss">
.auth-callback {
  &__spinner {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    border: 3px solid color-mix(in srgb, var(--brand-primary) 20%, transparent);
    border-top-color: var(--brand-primary);
    animation: auth-callback-spin 1s linear infinite;
  }

  &__error-mark {
    color: var(--brand-error);
    background: color-mix(in srgb, var(--brand-error) 10%, transparent);
  }

  &__alert {
    border-style: dashed;
    border-radius: 0.75rem;
  }
}

@keyframes auth-callback-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

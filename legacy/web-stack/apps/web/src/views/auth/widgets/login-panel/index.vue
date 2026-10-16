<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import { useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLogin } from '../../composables/useLogin'
import AuthEntryShell from '../../layouts/entry-shell'

const repositoryUrl = 'https://github.com/haohaoxue-site/Lexora'
const passwordFormRef = useTemplateRef<FormInstance>('passwordFormRef')
const oauthInviteFormRef = useTemplateRef<FormInstance>('oauthInviteFormRef')
const { t } = useI18n({ useScope: 'global' })
const {
  continueOauthAsExistingAccount,
  continueOauthWithInviteCode,
  handleSubmitPasswordLogin,
  handleStartLogin,
  hasOauthProviders,
  isOauthInviteDialogVisible,
  isLoadingCapabilities,
  isPasswordSubmitting,
  loadErrorMessage,
  oauthInviteForm,
  oauthInviteFormRules,
  passwordRegistrationEnabled,
  passwordForm,
  passwordFormRules,
  providers,
  selectedOauthProviderMeta,
  startingOauthProvider,
} = useLogin({
  oauthInviteFormRef,
  passwordFormRef,
})
</script>

<template>
  <AuthEntryShell
    :title="t('auth.login.title')"
    :description="t('auth.login.description')"
  >
    <template #actions>
      <a
        :href="repositoryUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="login-view__source-link inline-flex min-h-[2.375rem] items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-bold leading-none no-underline max-[420px]:min-h-[2.25rem] max-[420px]:gap-1.5 max-[420px]:px-2 max-[420px]:py-[0.3125rem]"
        :aria-label="t('auth.login.repositoryAria')"
      >
        <ElTooltip
          :content="t('auth.login.betaTooltip')"
          placement="top"
          effect="light"
          :show-after="120"
        >
          <span class="login-view__source-status inline-flex h-[1.625rem] items-center rounded px-2 text-[10px] font-[800] max-[420px]:h-6 max-[420px]:px-2">
            BETA
          </span>
        </ElTooltip>
        <span class="login-view__source-divider h-[1.125rem] w-px max-[420px]:hidden" />
        <SvgIcon category="brand" icon="brand-github" size="1.125rem" class="login-view__source-icon shrink-0" />
        <span class="login-view__source-text shrink-0 max-[420px]:hidden">GitHub</span>
      </a>
    </template>

    <ElAlert
      v-if="loadErrorMessage"
      type="warning"
      show-icon
      :closable="false"
      :title="loadErrorMessage"
      class="login-view__alert mb-4"
    />

    <ElForm
      ref="passwordFormRef"
      :model="passwordForm"
      :rules="passwordFormRules"
      label-position="top"
      class="login-view__form w-full"
      @submit.prevent="handleSubmitPasswordLogin"
    >
      <ElFormItem :label="t('auth.common.email')" prop="email">
        <ElInput
          v-model="passwordForm.email"
          autocomplete="email"
          size="large"
          :placeholder="t('auth.common.emailPlaceholder')"
        />
      </ElFormItem>
      <ElFormItem :label="t('auth.common.password')" prop="password">
        <ElInput
          v-model="passwordForm.password"
          type="password"
          show-password
          autocomplete="current-password"
          size="large"
          :placeholder="t('auth.common.passwordPlaceholder')"
        />
      </ElFormItem>

      <ElButton
        type="primary"
        native-type="submit"
        size="large"
        class="login-view__submit mt-3 w-full min-h-12 font-semibold"
        :loading="isPasswordSubmitting"
      >
        {{ t('auth.login.submit') }}
      </ElButton>
    </ElForm>

    <template v-if="hasOauthProviders">
      <div class="login-view__divider mt-1 flex items-center gap-3.5 text-secondary">
        <span class="login-view__divider-text text-[13px] font-semibold">{{ t('auth.login.otherMethods') }}</span>
      </div>

      <div
        class="login-view__providers grid justify-start gap-2.5 [grid-template-columns:repeat(var(--provider-columns),9.2rem)] max-[420px]:![grid-template-columns:minmax(0,1fr)] min-[421px]:max-[680px]:![grid-template-columns:repeat(2,minmax(0,1fr))]"
        :style="{ '--provider-columns': providers.length }"
      >
        <ElButton
          v-for="item in providers"
          :key="item.provider"
          class="login-provider-btn !ml-0 !min-h-14 !w-full justify-between rounded-lg px-2.5 py-1.5"
          :class="{ 'is-loading': startingOauthProvider === item.provider }"
          :disabled="startingOauthProvider === item.provider"
          :aria-busy="startingOauthProvider === item.provider"
          @click="handleStartLogin(item.provider)"
        >
          <span class="login-provider-btn__icon-wrap flex h-8 w-8 items-center justify-center rounded-lg border">
            <SvgIcon :category="item.iconCategory" :icon="item.icon" size="1.125rem" class="login-provider-btn__icon" />
          </span>
          <span class="login-provider-btn__label min-w-0 truncate text-left text-[13px] font-semibold">{{ item.title }}</span>
          <span class="login-provider-btn__arrow-wrap flex h-[1.125rem] w-3.5 shrink-0 items-center justify-center">
            <SvgIcon
              v-if="startingOauthProvider === item.provider"
              category="ui"
              icon="spinner-orbit"
              size="1rem"
              class="login-provider-btn__loading animate-spin"
            />
            <SvgIcon v-else category="ui" icon="arrow-right" size="1rem" class="login-provider-btn__arrow" />
          </span>
        </ElButton>
      </div>
    </template>

    <template #footer>
      <template v-if="passwordRegistrationEnabled && !isLoadingCapabilities">
        <span class="login-view__footer-text text-secondary">{{ t('auth.login.noAccount') }}</span>
        <RouterLink :to="{ name: 'register' }" class="login-view__footer-link text-sm font-semibold text-primary no-underline">
          {{ t('auth.login.createEmailAccount') }}
        </RouterLink>
      </template>
    </template>
  </AuthEntryShell>

  <ElDialog
    v-model="isOauthInviteDialogVisible"
    :title="t('auth.login.oauthDialogTitle', { provider: selectedOauthProviderMeta?.title ?? t('auth.common.thirdPartyAccount') })"
    width="28rem"
    align-center
    destroy-on-close
  >
    <ElForm
      ref="oauthInviteFormRef"
      :model="oauthInviteForm"
      :rules="oauthInviteFormRules"
      label-position="top"
      @submit.prevent="continueOauthWithInviteCode"
    >
      <ElFormItem :label="t('auth.common.inviteCode')" prop="inviteCode">
        <ElInput
          v-model="oauthInviteForm.inviteCode"
          autocomplete="off"
          :placeholder="t('auth.login.inviteCodePlaceholder')"
        />
      </ElFormItem>
    </ElForm>

    <template #footer>
      <div class="login-view__oauth-dialog-footer flex justify-end gap-3">
        <ElButton
          :loading="Boolean(startingOauthProvider)"
          @click="continueOauthAsExistingAccount"
        >
          {{ t('auth.login.continueExisting') }}
        </ElButton>
        <ElButton
          type="primary"
          :loading="Boolean(startingOauthProvider)"
          @click="continueOauthWithInviteCode"
        >
          {{ t('auth.login.verifyInviteAndContinue') }}
        </ElButton>
      </div>
    </template>
  </ElDialog>
</template>

<style scoped lang="scss">
.login-view {
  &__source-link {
    border: 1px solid color-mix(in srgb, var(--brand-warning) 38%, var(--brand-border-base));
    background: color-mix(in srgb, var(--brand-warning) 9%, var(--brand-bg-surface));
    box-shadow: 0 14px 24px -22px color-mix(in srgb, var(--brand-warning) 65%, transparent);
    color: color-mix(in srgb, var(--brand-warning) 64%, var(--brand-text-primary));
    transition: transform 0.2s ease, border-color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;

    &:hover {
      border-color: color-mix(in srgb, var(--brand-warning) 62%, var(--brand-border-base));
      background: color-mix(in srgb, var(--brand-warning) 13%, var(--brand-bg-surface));
      box-shadow: 0 18px 30px -22px color-mix(in srgb, var(--brand-warning) 75%, transparent);
      transform: translateY(-1px);
    }
  }

  &__source-status {
    background: color-mix(in srgb, var(--brand-warning) 16%, transparent);
    color: color-mix(in srgb, var(--brand-warning) 76%, var(--brand-text-primary));
  }

  &__source-divider {
    background: color-mix(in srgb, var(--brand-warning) 35%, var(--brand-border-base));
  }

  &__submit {
    border-radius: 7px;
    box-shadow: 0 18px 30px -24px color-mix(in srgb, var(--brand-primary) 45%, transparent);
    letter-spacing: 0;
  }

  &__divider {
    &::before,
    &::after {
      flex: 1;
      height: 1px;
      background: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
      content: '';
    }
  }
}

.login-provider-btn {
  border-color: color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--brand-bg-surface) 95%, white 5%), var(--brand-bg-surface));
  transition: transform 0.22s ease, border-color 0.22s ease, background-color 0.22s ease, box-shadow 0.22s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 38%, var(--brand-border-base));
    background-color: color-mix(in srgb, var(--brand-primary) 6%, var(--brand-bg-surface));
    box-shadow: 0 18px 28px -24px color-mix(in srgb, var(--brand-primary) 45%, transparent);
    transform: translateY(-1px);
  }

  &:hover &__arrow-wrap {
    color: var(--brand-primary);
  }

  &:hover &__arrow {
    color: var(--brand-primary);
    transform: translateX(0.125rem);
  }

  &.is-loading,
  &.is-disabled,
  &.is-disabled:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 34%, var(--brand-border-base));
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--brand-primary) 6%, white 94%), var(--brand-bg-surface));
    box-shadow: 0 18px 28px -24px color-mix(in srgb, var(--brand-primary) 45%, transparent);
    color: var(--brand-text-primary);
    cursor: default;
    opacity: 1;
    transform: none;
  }

  &.is-loading &__arrow-wrap {
    color: var(--brand-primary);
  }

  :deep(> span) {
    width: 100%;
    height: 2.25rem;
    display: grid;
    grid-template-columns: 2rem minmax(0, 1fr) 0.875rem;
    align-items: center;
    gap: 0.5rem;
  }

  &__icon-wrap {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    background: color-mix(in srgb, var(--brand-primary) 5%, var(--brand-bg-surface));
  }

  &__icon {
    color: var(--brand-text-primary);
  }

  &__label {
    color: var(--brand-text-secondary);
  }

  &__arrow-wrap,
  &__arrow {
    color: var(--brand-text-secondary);
    transition: color 0.2s ease;
  }

  &__arrow {
    transition: transform 0.2s ease, color 0.2s ease;
  }

  &__loading {
    color: var(--brand-primary);
  }
}
</style>

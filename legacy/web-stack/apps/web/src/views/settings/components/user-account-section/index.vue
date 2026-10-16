<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import type { UserAccountSectionEmits, UserAccountSectionProps } from './typing'
import { useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserAccountSection } from '../../composables/useUserAccountSection'
import UserSettingsSectionHeader from '../section-header'

const props = defineProps<UserAccountSectionProps>()
const emit = defineEmits<UserAccountSectionEmits>()
const emailModel = defineModel<string>('email', { required: true })
const codeModel = defineModel<string>('code', { required: true })
const newPasswordModel = defineModel<string>('newPassword', { required: true })
const confirmPasswordModel = defineModel<string>('confirmPassword', { required: true })
const emailFormRef = useTemplateRef<FormInstance>('emailFormRef')
const { t } = useI18n({ useScope: 'global' })
const {
  clearEmailValidation,
  emailButtonText,
  emailFormRules,
  form,
  handleConfirmEmail,
  handleDisconnect,
  handleSendCode,
  handleStartOauthBinding,
  isConfirmEmailDisabled,
  isSendCodeDisabled,
  oauthRows,
  requiresPasswordSetup,
  sectionDescription,
  showEmailStatus,
} = useUserAccountSection({
  code: codeModel,
  confirmPassword: confirmPasswordModel,
  email: emailModel,
  emailFormRef,
  newPassword: newPasswordModel,
  onConfirmEmail: () => emit('confirmEmail'),
  onDisconnectOauthBinding: provider => emit('disconnectOauthBinding', provider),
  onSendCode: () => emit('sendCode'),
  onStartOauthBinding: provider => emit('startOauthBinding', provider),
  props,
})

defineExpose({
  clearEmailValidation,
})
</script>

<template>
  <ElCard shadow="never" class="user-account-section">
    <UserSettingsSectionHeader
      :title="t('settings.user.account.title')"
      :description="sectionDescription"
    />

    <div v-if="showEmailStatus" class="mb-5 grid gap-3 md:grid-cols-2">
      <div class="user-account-section__status-card flex flex-col gap-[0.375rem] rounded-[1rem] p-4">
        <span class="text-xs text-secondary">{{ t('settings.user.account.currentEmail') }}</span>
        <strong class="text-base text-main">{{ props.account.email || t('settings.user.account.notBound') }}</strong>
        <span class="text-xs leading-6 text-secondary">
          {{ props.account.emailVerified ? t('settings.user.account.emailVerified') : t('settings.user.account.verifiedAfterBinding') }}
        </span>
      </div>
      <div class="user-account-section__status-card flex flex-col gap-[0.375rem] rounded-[1rem] p-4">
        <span class="text-xs text-secondary">{{ t('settings.user.account.password') }}</span>
        <strong class="text-base text-main">{{ props.account.hasPasswordAuth ? t('settings.user.account.passwordEnabled') : t('settings.user.account.passwordNotEnabled') }}</strong>
        <span class="text-xs leading-6 text-secondary">
          {{ props.account.hasPasswordAuth ? t('settings.user.account.emailLoginAvailable') : t('settings.user.account.enableAfterSetup') }}
        </span>
      </div>
    </div>

    <ElForm
      v-if="props.emailBindingEnabled"
      ref="emailFormRef"
      :model="form"
      :rules="emailFormRules"
      label-position="top"
      class="flex flex-col gap-3"
      @submit.prevent="handleConfirmEmail"
    >
      <div class="grid gap-4 md:grid-cols-2">
        <ElFormItem :label="t('settings.user.account.email')" prop="email">
          <ElInput v-model="form.email" autocomplete="email" :placeholder="t('settings.user.account.emailInputPlaceholder')" />
        </ElFormItem>
        <ElFormItem :label="t('settings.user.account.code')" prop="code">
          <div class="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3">
            <ElInput
              v-model="form.code"
              maxlength="6"
              inputmode="numeric"
              autocomplete="one-time-code"
              :placeholder="t('settings.user.account.codePlaceholder')"
            />
            <ElButton :disabled="isSendCodeDisabled" :loading="props.isSendingCode" @click="handleSendCode">
              {{ props.isSendingCode ? t('settings.user.account.sendingCode') : t('settings.user.account.sendCode') }}
            </ElButton>
          </div>
        </ElFormItem>
      </div>

      <template v-if="requiresPasswordSetup">
        <div class="grid gap-4 md:grid-cols-2">
          <ElFormItem :label="t('settings.user.account.password')" prop="newPassword">
            <ElInput
              v-model="form.newPassword"
              type="password"
              show-password
              autocomplete="new-password"
              :placeholder="t('settings.user.account.passwordPlaceholder')"
            />
          </ElFormItem>
          <ElFormItem :label="t('settings.user.account.confirmPassword')" prop="confirmPassword">
            <ElInput
              v-model="form.confirmPassword"
              type="password"
              show-password
              autocomplete="new-password"
              :placeholder="t('settings.user.account.repeatPasswordPlaceholder')"
            />
          </ElFormItem>
        </div>
      </template>

      <ElButton type="primary" :disabled="isConfirmEmailDisabled" :loading="props.isBindingEmail" native-type="submit">
        {{ props.isBindingEmail ? t('settings.user.account.submitLoading') : emailButtonText }}
      </ElButton>
    </ElForm>

    <div class="mt-6 flex flex-col gap-3">
      <div
        v-for="row in oauthRows"
        :key="row.provider"
        class="user-account-section__oauth-item flex flex-wrap items-center justify-between gap-4 rounded-[1rem] p-4"
      >
        <div class="flex min-w-0 items-center gap-3">
          <span class="user-account-section__oauth-icon-wrap flex h-10 w-10 shrink-0 items-center justify-center rounded-[0.875rem]">
            <SvgIcon
              :category="row.iconCategory"
              :icon="row.icon"
              size="1.125rem"
              class="user-account-section__oauth-icon"
            />
          </span>

          <div class="min-w-0">
            <div class="font-semibold text-main">
              {{ row.title }}
            </div>
            <div class="mt-1 text-[0.8125rem] text-secondary">
              {{ row.connected ? t('settings.user.account.providerConnected', { account: row.username || t('settings.user.account.boundAccount') }) : row.canStartBinding ? t('settings.user.account.providerNotBound') : t('settings.user.account.providerDisabled') }}
            </div>
          </div>
        </div>

        <div class="flex gap-3">
          <ElButton
            v-if="!row.connected"
            :loading="props.bindingProvider === row.provider"
            :disabled="!row.canStartBinding"
            @click="handleStartOauthBinding(row.provider)"
          >
            {{ row.canStartBinding ? t('settings.user.account.bind') : t('settings.user.account.providerClosed') }}
          </ElButton>
          <ElButton
            v-else
            type="danger"
            plain
            :disabled="!row.canDisconnect"
            :loading="props.disconnectingProvider === row.provider"
            @click="handleDisconnect(row.provider)"
          >
            {{ t('settings.user.account.disconnect') }}
          </ElButton>
        </div>
      </div>
    </div>
  </ElCard>
</template>

<style scoped lang="scss">
.user-account-section {
  border-color: color-mix(in srgb, var(--brand-border-base) 85%, transparent);

  &__status-card {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--brand-fill-lighter) 72%, transparent);
  }

  &__oauth-item {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    border-radius: 1rem;
  }

  &__oauth-icon-wrap {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    background: color-mix(in srgb, var(--brand-primary) 5%, var(--brand-bg-surface));
  }

  &__oauth-icon {
    color: var(--brand-text-primary);
  }
}
</style>

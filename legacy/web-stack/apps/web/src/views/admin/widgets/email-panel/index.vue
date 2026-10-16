<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import type { SystemEmailProvider } from '@/apis/system-admin'
import { Promotion } from '@element-plus/icons-vue'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import PagePanel from '@/layouts/panels/page-panel'
import { formatDateTime } from '@/utils/dayjs'
import AdminPageHeader from '../../components/page-header'
import { useAdminEmail } from '../../composables/useAdminEmail'

const emailConfigFormRef = useTemplateRef<FormInstance>('emailConfigFormRef')
const testEmailFormRef = useTemplateRef<FormInstance>('testEmailFormRef')
const { t } = useI18n({ useScope: 'global' })
const {
  closeTestDialog,
  currentConfig,
  currentServiceStatus,
  errorMessage,
  form,
  formRules,
  handleKeepSavedPassword,
  handleSaveConfig,
  handleSendTestEmail,
  handleServiceStatusChange,
  handleStartPasswordEdit,
  hasSavedPassword,
  isEditingPassword,
  isLoading,
  isSaving,
  isTestDialogVisible,
  isTesting,
  isUpdatingServiceStatus,
  openTestDialog,
  providerCards,
  selectProvider,
  testEmailForm,
  testEmailFormRules,
} = useAdminEmail({
  emailConfigFormRef,
  testEmailFormRef,
})

const senderIdentityText = computed(() => {
  const fromName = currentConfig.value?.fromName?.trim() ?? ''
  const fromEmail = currentConfig.value?.fromEmail?.trim() ?? ''

  if (!fromName && !fromEmail) {
    return '-'
  }

  if (!fromEmail) {
    return fromName
  }

  if (!fromName) {
    return fromEmail
  }

  return `${fromName} <${fromEmail}>`
})

const canSendTestEmail = computed(() => {
  if (!currentConfig.value) {
    return false
  }

  return Boolean(
    currentConfig.value.smtpHost.trim()
    && currentConfig.value.smtpUsername.trim()
    && currentConfig.value.fromName.trim()
    && currentConfig.value.fromEmail.trim()
    && currentConfig.value.hasPassword,
  )
})

const testEmailTooltip = computed(() => {
  return canSendTestEmail.value
    ? t('admin.email.testCanSend')
    : t('admin.email.testNeedConfig')
})

const lastTestPrimaryText = computed(() => {
  const lastTest = currentConfig.value?.lastTest

  if (!lastTest) {
    return t('admin.email.lastTestNever')
  }

  return `${lastTest.succeeded ? t('admin.email.lastTestSucceeded') : t('admin.email.lastTestFailed')} · ${formatDateTime(lastTest.testedAt)}`
})

const lastTestSecondaryText = computed(() => {
  const lastTest = currentConfig.value?.lastTest

  if (!lastTest) {
    return ''
  }

  if (lastTest.message?.trim()) {
    return lastTest.message.trim()
  }

  if (!lastTest.succeeded && lastTest.recipientEmail.trim()) {
    return t('admin.email.lastTestRecipient', { email: lastTest.recipientEmail })
  }

  return ''
})

function handleProviderChange(value: string | number | boolean | undefined) {
  if (typeof value !== 'string') {
    return
  }

  if (!providerCards.value.some(provider => provider.provider === value)) {
    return
  }

  selectProvider(value as SystemEmailProvider)
}
</script>

<template>
  <PagePanel>
    <template #header>
      <AdminPageHeader :title="t('admin.pages.email')" />
    </template>

    <div class="admin-email min-h-full bg-fill-lighter p-4 lg:p-6">
      <ElAlert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false" class="rounded-xl" />

      <ElSkeleton v-else-if="isLoading" animated>
        <template #template>
          <div class="admin-email__columns grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(22rem,0.9fr)]">
            <section class="rounded-lg border border-border-a60 bg-surface p-5">
              <ElSkeletonItem variant="h3" class="max-w-36" />
              <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                <ElSkeletonItem variant="rect" class="h-20 w-full" />
                <ElSkeletonItem variant="rect" class="h-20 w-full" />
              </div>
              <div class="mt-7 grid grid-cols-1 gap-4 md:grid-cols-2">
                <ElSkeletonItem v-for="field in 6" :key="field" variant="rect" class="h-11 w-full" />
              </div>
              <ElSkeletonItem variant="button" class="mt-5 h-9 max-w-24" />
            </section>

            <aside class="order-first rounded-lg border border-border-a60 bg-surface p-5 lg:order-none">
              <div class="mb-5 flex items-start justify-between gap-4">
                <div class="grid min-w-0 flex-1 gap-2">
                  <ElSkeletonItem variant="h3" class="max-w-28" />
                  <ElSkeletonItem variant="text" class="max-w-60" />
                </div>
                <ElSkeletonItem variant="circle" class="h-8 w-8 shrink-0" />
              </div>
              <ElSkeletonItem variant="rect" class="h-px w-full" />
              <div class="mt-5 grid gap-2">
                <ElSkeletonItem variant="text" class="max-w-24" />
                <ElSkeletonItem variant="h3" class="max-w-44" />
                <ElSkeletonItem variant="text" class="max-w-64" />
              </div>
            </aside>
          </div>
        </template>
      </ElSkeleton>

      <template v-else>
        <div class="admin-email__columns grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(22rem,0.9fr)]">
          <ElCard shadow="never" class="admin-email__main-card">
            <div class="admin-email__section">
              <h2 class="admin-email__section-title m-0 text-base font-bold leading-6 text-main">
                {{ t('admin.email.smtpConfig') }}
              </h2>

              <ElRadioGroup
                v-model="form.provider"
                class="admin-email__provider-group mt-4 grid grid-cols-1 gap-3 md:grid-cols-2"
                @change="handleProviderChange"
              >
                <ElRadio
                  v-for="provider in providerCards"
                  :key="provider.provider"
                  :label="provider.provider"
                  :value="provider.provider"
                  :disabled="provider.disabled"
                  border
                  class="admin-email__provider-option !m-0 !h-auto !w-full text-left"
                >
                  <div class="admin-email__provider-option-content grid w-full gap-2 p-4 leading-[1.6] whitespace-normal">
                    <span class="admin-email__provider-title block text-[0.95rem] font-bold leading-[1.4] text-main">
                      {{ provider.title }}
                    </span>
                    <span class="admin-email__provider-meta block text-[13px] leading-[1.6] text-secondary">
                      Host: {{ provider.defaults.smtpHost }} / Port: {{ provider.defaults.smtpPort }}
                    </span>
                  </div>
                </ElRadio>
              </ElRadioGroup>
            </div>

            <div class="admin-email__section mt-7">
              <ElForm
                ref="emailConfigFormRef"
                :model="form"
                :rules="formRules"
                label-position="top"
                @submit.prevent="handleSaveConfig"
              >
                <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <ElFormItem label="SMTP Host" prop="smtpHost">
                    <ElInput v-model="form.smtpHost" placeholder="smtp.exmail.qq.com" />
                  </ElFormItem>
                  <ElFormItem :label="t('admin.email.port')" prop="smtpPort">
                    <ElInputNumber v-model="form.smtpPort" :min="1" :max="65535" controls-position="right" class="w-full" />
                  </ElFormItem>
                  <ElFormItem :label="t('admin.email.username')" prop="smtpUsername">
                    <ElInput v-model="form.smtpUsername" autocomplete="username" />
                  </ElFormItem>
                  <ElFormItem :label="t('admin.email.password')" prop="smtpPassword">
                    <ElButton v-if="hasSavedPassword && !isEditingPassword" plain type="primary" class="w-full" @click="handleStartPasswordEdit">
                      {{ t('admin.email.changePassword') }}
                    </ElButton>
                    <div v-else class="flex w-full items-start gap-3">
                      <ElInput
                        v-model="form.smtpPassword"
                        class="min-w-0 flex-1"
                        type="password"
                        show-password
                        autocomplete="new-password"
                        :placeholder="hasSavedPassword ? t('admin.email.passwordUpdatePlaceholder') : t('admin.email.passwordPlaceholder')"
                      />
                      <ElButton
                        v-if="hasSavedPassword && isEditingPassword"
                        link
                        class="shrink-0 self-center"
                        @click="handleKeepSavedPassword"
                      >
                        {{ t('admin.email.keepPassword') }}
                      </ElButton>
                    </div>
                  </ElFormItem>
                  <ElFormItem :label="t('admin.email.fromName')" prop="fromName">
                    <ElInput v-model="form.fromName" />
                  </ElFormItem>
                  <ElFormItem :label="t('admin.email.fromEmail')" prop="fromEmail">
                    <ElInput v-model="form.fromEmail" autocomplete="email" />
                  </ElFormItem>
                </div>

                <ElFormItem prop="smtpSecure">
                  <ElCheckbox v-model="form.smtpSecure">
                    {{ t('admin.email.secure') }}
                  </ElCheckbox>
                </ElFormItem>

                <div class="admin-email__form-actions flex justify-start pt-1">
                  <ElButton type="primary" :loading="isSaving" native-type="submit">
                    {{ isSaving ? t('admin.email.saving') : t('admin.email.save') }}
                  </ElButton>
                </div>
              </ElForm>
            </div>
          </ElCard>

          <ElCard
            shadow="never"
            class="admin-email__side-card order-first overflow-hidden bg-surface lg:order-none lg:sticky lg:top-6"
            body-class="admin-email__side-card-body flex flex-col gap-4 p-5"
          >
            <div class="admin-email__side-header flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0">
                <h2 class="admin-email__section-title m-0 text-base font-bold leading-6 text-main">
                  {{ t('admin.email.service') }}
                </h2>
                <p class="admin-email__section-description mt-1.5 text-[13px] leading-[1.7] text-secondary">
                  {{ t('admin.email.currentSender', { identity: senderIdentityText }) }}
                </p>
              </div>
              <div class="admin-email__status-actions inline-flex items-center gap-2.5">
                <ElTooltip :content="testEmailTooltip" placement="top" effect="light">
                  <span class="inline-flex">
                    <ElButton
                      circle
                      plain
                      size="small"
                      class="admin-email__test-trigger"
                      :icon="Promotion"
                      :disabled="!canSendTestEmail"
                      @click="openTestDialog"
                    />
                  </span>
                </ElTooltip>
                <ElSwitch
                  :model-value="currentServiceStatus?.enabled ?? false"
                  :loading="isUpdatingServiceStatus"
                  :disabled="isUpdatingServiceStatus"
                  @change="handleServiceStatusChange"
                />
              </div>
            </div>

            <ElDivider class="admin-email__side-divider !m-0" />

            <div class="admin-email__side-block flex flex-col gap-1">
              <span class="admin-email__side-label text-xs font-semibold leading-[1.6] text-secondary">{{ t('admin.email.lastTest') }}</span>
              <span class="admin-email__last-test-primary text-sm font-bold leading-[1.6] text-main">{{ lastTestPrimaryText }}</span>
              <p v-if="lastTestSecondaryText" class="admin-email__last-test-secondary m-0 text-xs leading-[1.6] text-secondary">
                {{ lastTestSecondaryText }}
              </p>
            </div>
          </ElCard>
        </div>

        <ElDialog
          v-model="isTestDialogVisible"
          :title="t('admin.email.testTitle')"
          width="32rem"
          destroy-on-close
          @close="closeTestDialog"
        >
          <ElForm
            ref="testEmailFormRef"
            :model="testEmailForm"
            :rules="testEmailFormRules"
            label-position="top"
            @submit.prevent="handleSendTestEmail"
          >
            <ElFormItem :label="t('admin.email.testRecipient')" prop="email">
              <ElInput
                v-model="testEmailForm.email"
                autocomplete="email"
                :placeholder="t('admin.email.testRecipientPlaceholder')"
              />
            </ElFormItem>
          </ElForm>

          <template #footer>
            <div class="flex justify-end gap-3">
              <ElButton @click="closeTestDialog">
                {{ t('admin.common.cancel') }}
              </ElButton>
              <ElButton type="primary" :loading="isTesting" @click="handleSendTestEmail">
                {{ isTesting ? t('admin.email.testSending') : t('admin.email.testSend') }}
              </ElButton>
            </div>
          </template>
        </ElDialog>
      </template>
    </div>
  </PagePanel>
</template>

<style scoped lang="scss">
.admin-email {
  &__main-card,
  &__side-card {
    border-color: color-mix(in srgb, var(--brand-border-base) 82%, transparent);
    box-shadow: 0 16px 36px -32px color-mix(in srgb, var(--brand-text-primary) 20%, transparent);
  }

  &__provider-option {
    border-radius: 1rem;
    transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;

    &:not(.is-disabled):hover {
      border-color: color-mix(in srgb, var(--brand-primary) 36%, var(--brand-border-base));
      transform: translateY(-1px);
      box-shadow: 0 16px 28px -24px color-mix(in srgb, var(--brand-primary) 55%, transparent);
    }

    &.is-checked {
      border-color: color-mix(in srgb, var(--brand-primary) 60%, transparent);
      transform: translateY(-1px);
      background: color-mix(in srgb, var(--brand-primary) 6%, var(--brand-bg-surface));
      box-shadow: 0 20px 36px -28px color-mix(in srgb, var(--brand-primary) 72%, transparent);
    }

    &.is-disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    :deep(.el-radio__input) {
      display: none;
    }

    :deep(.el-radio__label) {
      width: 100%;
      color: inherit;
      padding: 0;
    }
  }

  &__test-trigger {
    color: var(--brand-primary);
  }
}
</style>

<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus'
import type { RegistrationGovernanceField } from '../../composables/useAdminAuthGovernance'
import type { InviteCodeFormModel } from './typing'
import { reactive, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminAuthGovernance } from '../../composables/useAdminAuthGovernance'

const {
  authGovernanceCards,
  getGovernanceSwitchValue,
  handleGovernanceSwitchChange,
  inviteCodeForm,
  isGovernanceSwitchDisabled,
  isInviteCodeDialogVisible,
  isSavingInviteCode,
  openInviteCodeDialog,
  savingGovernanceFields,
  shouldShowEmailServiceHint,
  shouldShowMissingInviteCodeWarning,
  updateInviteCode,
} = useAdminAuthGovernance()

const inviteCodeFormRef = useTemplateRef<FormInstance>('inviteCodeFormRef')
const { t } = useI18n({ useScope: 'global' })
const inviteCodeFormModel = reactive<InviteCodeFormModel>({
  get inviteCode() {
    return inviteCodeForm.inviteCode
  },
  set inviteCode(value: string) {
    inviteCodeForm.inviteCode = value
  },
})
const inviteCodeFormRules: FormRules<InviteCodeFormModel> = {
  inviteCode: [
    {
      validator: (_rule, value: unknown, callback) => {
        const normalizedValue = typeof value === 'string' ? value.trim() : ''

        if (!normalizedValue || normalizedValue.length >= 4) {
          callback()
          return
        }

        callback(new Error(t('admin.authGovernance.inviteCodeMin')))
      },
      trigger: 'change',
    },
  ],
}

async function submitInviteCode() {
  const form = inviteCodeFormRef.value

  if (!form) {
    return
  }

  const isValid = await form.validate().catch(() => false)

  if (!isValid) {
    return
  }

  void updateInviteCode()
}

function handleSwitchChange(key: RegistrationGovernanceField, value: string | number | boolean) {
  handleGovernanceSwitchChange(key, value)
}
</script>

<template>
  <ElCard shadow="never" class="auth-governance-panel border-border-a80">
    <div class="flex flex-col gap-5">
      <header class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h2 class="m-0 text-base font-bold text-main">
          {{ t('admin.authGovernance.registration') }}
        </h2>
        <ElButton @click="openInviteCodeDialog">
          {{ t('admin.authGovernance.setInviteCode') }}
        </ElButton>
      </header>

      <ElAlert
        v-if="shouldShowMissingInviteCodeWarning"
        :title="t('admin.authGovernance.missingInviteCodeWarning')"
        type="warning"
        show-icon
        :closable="false"
      />

      <div class="auth-governance-panel__entry-grid grid grid-cols-1 gap-3 lg:grid-cols-2 min-[1440px]:grid-cols-4">
        <section
          v-for="card in authGovernanceCards"
          :key="card.key"
          class="auth-governance-panel__entry-card flex min-h-[12.5rem] flex-col gap-4 rounded-lg border border-border-a80 bg-surface p-4"
        >
          <div>
            <div class="text-sm font-semibold text-main">
              {{ card.title }}
            </div>
            <p class="m-0 mt-1 text-xs leading-5 text-secondary">
              {{ card.description }}
            </p>
          </div>

          <div class="auth-governance-panel__switch-list flex flex-1 flex-col gap-3">
            <label
              v-for="item in card.switches"
              :key="item.key"
              class="auth-governance-panel__switch-row flex min-h-12 items-center justify-between gap-4"
            >
              <span class="min-w-0">
                <span class="block text-sm font-medium text-main">{{ item.label }}</span>
                <span class="mt-0.5 block text-xs leading-5 text-secondary">{{ item.description }}</span>
              </span>
              <span class="flex shrink-0 items-center gap-2.5">
                <ElTooltip
                  v-if="shouldShowEmailServiceHint(item.key)"
                  placement="top"
                  effect="light"
                  :show-after="150"
                >
                  <template #content>
                    <div class="auth-governance-panel__switch-hint max-w-64">
                      <p class="auth-governance-panel__switch-hint-text m-0 text-xs leading-5 text-main">
                        {{ t('admin.authGovernance.emailRegistrationDisabledHint') }}
                      </p>
                      <RouterLink
                        to="/admin/email"
                        class="auth-governance-panel__switch-hint-link mt-2 inline-flex text-xs font-semibold text-primary no-underline hover:opacity-80"
                      >
                        {{ t('admin.authGovernance.goEmailSettings') }}
                      </RouterLink>
                    </div>
                  </template>
                  <button
                    type="button"
                    class="auth-governance-panel__switch-hint-trigger inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-none p-0"
                    @click.stop.prevent
                    @mousedown.stop.prevent
                  >
                    <SvgIcon category="ui" icon="info" size="1rem" />
                  </button>
                </ElTooltip>
                <ElSwitch
                  :model-value="getGovernanceSwitchValue(item.key)"
                  :disabled="isGovernanceSwitchDisabled(item.key)"
                  :loading="savingGovernanceFields[item.key]"
                  @change="(value: string | number | boolean) => handleSwitchChange(item.key, value)"
                />
              </span>
            </label>
          </div>
        </section>
      </div>
    </div>
  </ElCard>

  <ElDialog
    v-model="isInviteCodeDialogVisible"
    :title="t('admin.authGovernance.inviteCodeDialogTitle')"
    width="28rem"
    align-center
    destroy-on-close
  >
    <ElForm
      ref="inviteCodeFormRef"
      :model="inviteCodeFormModel"
      :rules="inviteCodeFormRules"
      label-position="top"
      @submit.prevent="submitInviteCode"
    >
      <ElFormItem :label="t('admin.authGovernance.newInviteCode')" prop="inviteCode">
        <ElInput
          v-model="inviteCodeFormModel.inviteCode"
          autocomplete="off"
          clearable
          maxlength="120"
          :placeholder="t('admin.authGovernance.inviteCodePlaceholder')"
          show-word-limit
        />
      </ElFormItem>
    </ElForm>

    <template #footer>
      <ElButton :disabled="isSavingInviteCode" @click="isInviteCodeDialogVisible = false">
        {{ t('admin.common.cancel') }}
      </ElButton>
      <ElButton type="primary" :loading="isSavingInviteCode" @click="submitInviteCode">
        {{ t('admin.common.save') }}
      </ElButton>
    </template>
  </ElDialog>
</template>

<style scoped lang="scss">
.auth-governance-panel {
  &__switch-hint-trigger {
    color: var(--brand-warning);
    background: color-mix(in srgb, var(--brand-warning) 12%, transparent);
    transition: background-color 0.2s ease, color 0.2s ease;

    &:hover {
      background: color-mix(in srgb, var(--brand-warning) 18%, transparent);
    }

    &:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--brand-primary) 35%, transparent);
      outline-offset: 2px;
    }
  }
}
</style>

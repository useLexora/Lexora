<script setup lang="ts">
import type { UserAccountSectionExposed } from './typing'
import { nextTick, onMounted, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import BotsSection from '../../components/bots-section'
import UserAccountSection from '../../components/user-account-section'
import UserDeleteSection from '../../components/user-delete-section'
import UserProfileSection from '../../components/user-profile-section'
import { useSettingsAuthCapabilities } from '../../composables/useSettingsAuthCapabilities'
import { useSettingsUserAccount } from '../../composables/useSettingsUserAccount'
import { useSettingsUserDelete } from '../../composables/useSettingsUserDelete'
import { useSettingsUserProfile } from '../../composables/useSettingsUserProfile'
import { useSettingsWeixinBot } from '../../composables/useSettingsWeixinBot'

const userStore = useUserStore()
const userAccountSectionRef = useTemplateRef<UserAccountSectionExposed>('userAccountSectionRef')
const { t } = useI18n({ useScope: 'global' })

const { loadAuthCapabilities } = useSettingsAuthCapabilities()
const {
  avatarUrl,
  canEditAvatar,
  canEditDisplayName,
  displayName,
  isSavingDisplayName,
  isUploadingAvatar,
  saveDisplayName,
  syncProfileForm,
  uploadAvatar,
} = useSettingsUserProfile()
const {
  account,
  bindEmail,
  bindingProvider,
  connectOauth,
  consumeRouteFeedback,
  disconnectOauth,
  disconnectingProvider,
  emailBindingEnabled,
  emailForm,
  isBindingEmail,
  isSendingEmailCode,
  oauthProviderBindingState,
  sendEmailCode,
  syncEmailForm,
} = useSettingsUserAccount()
const {
  deleteAccount,
  deleteAccountConfirmationMode,
  deleteAccountConfirmationPhrase,
  deleteAccountConfirmationTarget,
  isDeletingAccount,
  shouldShowDeleteAccountSection,
} = useSettingsUserDelete()
const {
  disconnect: disconnectWeixinBot,
  isDisconnecting: isDisconnectingWeixinBot,
  isLoading: isLoadingWeixinBot,
  isPollingLogin: isPollingWeixinLogin,
  isStartingBot: isStartingWeixinBot,
  isStartingLogin: isStartingWeixinLogin,
  isStoppingBot: isStoppingWeixinBot,
  isSubmittingVerifyCode: isSubmittingWeixinVerifyCode,
  loadWeixinStatus,
  loginDialogVisible: weixinLoginDialogVisible,
  loginState: weixinLoginState,
  startLogin: startWeixinLogin,
  startRuntime: startWeixinRuntime,
  status: weixinStatus,
  stopRuntime: stopWeixinRuntime,
  submitVerifyCode: submitWeixinVerifyCode,
  verifyCode: weixinVerifyCode,
} = useSettingsWeixinBot()

const isLoading = shallowRef(false)
const errorMessage = shallowRef('')

onMounted(loadView)

async function loadView() {
  isLoading.value = true
  errorMessage.value = ''

  try {
    await Promise.all([
      userStore.refreshContext(),
      loadAuthCapabilities(),
      loadWeixinStatus({ silent: true }),
    ])

    syncProfileForm()
    syncEmailForm()
    await consumeRouteFeedback()
  }
  catch (error) {
    errorMessage.value = getRequestErrorDisplayMessage(error, t('settings.user.loadFailed'))
  }
  finally {
    isLoading.value = false
  }
}

async function handleConfirmEmail() {
  const isSuccess = await bindEmail()

  if (!isSuccess) {
    return
  }

  await nextTick()
  userAccountSectionRef.value?.clearEmailValidation()
}
</script>

<template>
  <div class="settings-user-page mx-auto w-full max-w-[var(--page-mode-form-max-width)] px-6 py-6">
    <ElAlert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
      class="mb-4"
    />

    <ElSkeleton v-else-if="isLoading" animated class="grid gap-4">
      <template #template>
        <ElCard shadow="never">
          <div class="flex items-center gap-4">
            <ElSkeletonItem variant="circle" class="h-16 w-16" />
            <div class="grid flex-1 gap-3">
              <ElSkeletonItem variant="h3" class="max-w-36" />
              <ElSkeletonItem variant="text" class="max-w-72" />
            </div>
          </div>
        </ElCard>
        <ElCard shadow="never">
          <div class="grid gap-5">
            <ElSkeletonItem variant="h3" class="max-w-32" />
            <div class="grid grid-cols-2 gap-4 max-[720px]:grid-cols-1">
              <ElSkeletonItem variant="rect" class="h-20" />
              <ElSkeletonItem variant="rect" class="h-20" />
            </div>
            <ElSkeletonItem variant="rect" class="h-16" />
            <ElSkeletonItem variant="rect" class="h-16" />
          </div>
        </ElCard>
        <ElCard shadow="never">
          <div class="grid gap-4">
            <ElSkeletonItem variant="h3" class="max-w-28" />
            <ElSkeletonItem variant="rect" class="h-18" />
          </div>
        </ElCard>
      </template>
    </ElSkeleton>

    <div v-else class="grid gap-4">
      <UserProfileSection
        v-model:display-name="displayName"
        :avatar-url="avatarUrl"
        :user-code="account.userCode"
        :can-edit-avatar="canEditAvatar"
        :can-edit-display-name="canEditDisplayName"
        :is-saving-display-name="isSavingDisplayName"
        :is-uploading="isUploadingAvatar"
        @save-display-name="saveDisplayName"
        @upload="uploadAvatar"
      />

      <UserAccountSection
        ref="userAccountSectionRef"
        v-model:email="emailForm.email"
        v-model:code="emailForm.code"
        v-model:new-password="emailForm.newPassword"
        v-model:confirm-password="emailForm.confirmPassword"
        :account="account"
        :email-binding-enabled="emailBindingEnabled"
        :is-sending-code="isSendingEmailCode"
        :is-binding-email="isBindingEmail"
        :binding-provider="bindingProvider"
        :disconnecting-provider="disconnectingProvider"
        :oauth-provider-binding-state="oauthProviderBindingState"
        @send-code="sendEmailCode"
        @confirm-email="handleConfirmEmail"
        @start-oauth-binding="connectOauth"
        @disconnect-oauth-binding="disconnectOauth"
      />

      <BotsSection
        v-model:login-visible="weixinLoginDialogVisible"
        v-model:verify-code="weixinVerifyCode"
        :status="weixinStatus"
        :login-state="weixinLoginState"
        :is-loading="isLoadingWeixinBot"
        :is-starting-login="isStartingWeixinLogin"
        :is-polling-login="isPollingWeixinLogin"
        :is-submitting-verify-code="isSubmittingWeixinVerifyCode"
        :is-starting-bot="isStartingWeixinBot"
        :is-stopping-bot="isStoppingWeixinBot"
        :is-disconnecting="isDisconnectingWeixinBot"
        @start-login="startWeixinLogin"
        @submit-verify-code="submitWeixinVerifyCode"
        @start-runtime="startWeixinRuntime"
        @stop-runtime="stopWeixinRuntime"
        @disconnect="disconnectWeixinBot"
      />
    </div>

    <UserDeleteSection
      v-if="shouldShowDeleteAccountSection"
      class="mt-4"
      :is-deleting="isDeletingAccount"
      :confirmation-target="deleteAccountConfirmationTarget"
      :confirmation-mode="deleteAccountConfirmationMode"
      :confirmation-phrase="deleteAccountConfirmationPhrase"
      @delete-account="deleteAccount"
    />
  </div>
</template>

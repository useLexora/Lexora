import type { DeleteCurrentUserRequest } from '@haohaoxue/lexora-contracts'
import { PERMISSIONS } from '@haohaoxue/lexora-contracts/rbac/constants'
import { ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '@haohaoxue/lexora-contracts/user/constants'
import { createSharedComposable } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { deleteCurrentUser } from '@/apis/user'
import { resetAdminRoutes } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { useSettingsUserAccount } from './useSettingsUserAccount'

export const DELETE_ACCOUNT_CONFIRMATION_PHRASE: DeleteCurrentUserRequest['confirmationPhrase']
  = ACCOUNT_DELETION_CONFIRMATION_PHRASE

export const useSettingsUserDelete = createSharedComposable(() => {
  const { t } = useI18n({ useScope: 'global' })
  const router = useRouter()
  const authStore = useAuthStore()
  const userStore = useUserStore()
  const { account } = useSettingsUserAccount()
  const isDeletingAccount = shallowRef(false)

  const currentUser = computed(() => userStore.currentUser)
  const canDeleteAccount = computed(() =>
    currentUser.value?.permissions.includes(PERMISSIONS.USER_DELETE_SELF) ?? false,
  )
  const shouldShowDeleteAccountSection = computed(() =>
    canDeleteAccount.value && !userStore.isSystemAdmin,
  )
  const deleteAccountConfirmationMode = computed<'email' | 'displayName'>(() =>
    account.value.email ? 'email' : 'displayName',
  )
  const deleteAccountConfirmationTarget = computed(() =>
    account.value.email ?? currentUser.value?.displayName ?? '',
  )

  async function deleteAccount(payload: DeleteCurrentUserRequest) {
    if (!shouldShowDeleteAccountSection.value) {
      return false
    }

    isDeletingAccount.value = true

    try {
      await deleteCurrentUser(payload)
      authStore.clearSession()
      ElMessage.success(t('settings.user.delete.deleted'))

      try {
        await router.replace({ name: 'login' })
      }
      finally {
        resetAdminRoutes(router)
      }

      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.delete.deleteFailed')))
      return false
    }
    finally {
      isDeletingAccount.value = false
    }
  }

  return {
    deleteAccount,
    deleteAccountConfirmationMode,
    deleteAccountConfirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
    deleteAccountConfirmationTarget,
    isDeletingAccount,
    shouldShowDeleteAccountSection,
  }
})

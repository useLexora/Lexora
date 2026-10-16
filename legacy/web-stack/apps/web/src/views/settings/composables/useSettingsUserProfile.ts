import { createSharedComposable } from '@vueuse/core'
import { computed, reactive, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export const useSettingsUserProfile = createSharedComposable(() => {
  const { t } = useI18n({ useScope: 'global' })
  const userStore = useUserStore()
  const isSavingDisplayName = shallowRef(false)
  const isUploadingAvatar = shallowRef(false)
  const profileForm = reactive({
    displayName: '',
  })

  const displayName = computed({
    get: () => profileForm.displayName,
    set: (nextDisplayName: string) => {
      profileForm.displayName = nextDisplayName
    },
  })
  const avatarUrl = computed(() =>
    userStore.settings?.profile.avatarUrl ?? userStore.currentUser?.avatarUrl ?? null,
  )
  const canEditAvatar = computed(() => !userStore.isSystemAdmin)
  const canEditDisplayName = computed(() => !userStore.isSystemAdmin)

  function syncProfileForm() {
    const nextSettings = userStore.settings

    if (!nextSettings) {
      return
    }

    profileForm.displayName = nextSettings.profile.displayName
  }

  async function saveDisplayName() {
    isSavingDisplayName.value = true

    try {
      await userStore.updateProfile(profileForm.displayName.trim())
      profileForm.displayName = userStore.currentUser?.displayName ?? profileForm.displayName
      ElMessage.success(t('settings.user.profile.displayNameUpdated'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.profile.displayNameSaveFailed')))
    }
    finally {
      isSavingDisplayName.value = false
    }
  }

  async function uploadAvatar(file: File) {
    isUploadingAvatar.value = true

    try {
      await userStore.updateAvatar(file)
      ElMessage.success(t('settings.user.profile.avatarUpdated'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.profile.avatarUploadFailed')))
    }
    finally {
      isUploadingAvatar.value = false
    }
  }

  return {
    avatarUrl,
    canEditAvatar,
    canEditDisplayName,
    displayName,
    isSavingDisplayName,
    isUploadingAvatar,
    saveDisplayName,
    syncProfileForm,
    uploadAvatar,
  }
})

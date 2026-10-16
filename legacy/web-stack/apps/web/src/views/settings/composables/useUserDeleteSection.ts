import type { DeleteCurrentUserRequest } from '@haohaoxue/lexora-contracts'
import type { FormInstance, FormRules } from 'element-plus'
import type { Ref } from 'vue'
import type { UserDeleteSectionProps } from '../typing'
import { computed, reactive, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { normalizeAccountConfirmation } from '../utils/accountConfirmation'

export function useUserDeleteSection(options: {
  deleteFormRef: Ref<FormInstance | null>
  onDeleteAccount: (payload: DeleteCurrentUserRequest) => void
  props: UserDeleteSectionProps
}) {
  const { t } = useI18n({ useScope: 'global' })
  const isDialogVisible = shallowRef(false)
  const form = reactive({
    accountConfirmation: '',
    confirmationPhrase: '',
  })

  const accountLabel = computed(() =>
    options.props.confirmationMode === 'email'
      ? t('settings.user.delete.accountLabel.email')
      : t('settings.user.delete.accountLabel.displayName'),
  )
  const accountPlaceholder = computed(() =>
    options.props.confirmationMode === 'email'
      ? t('settings.user.delete.accountPlaceholder.email')
      : t('settings.user.delete.accountPlaceholder.displayName'),
  )
  const accountValidatorMessage = computed(() =>
    options.props.confirmationMode === 'email'
      ? t('settings.user.delete.accountRequired.email')
      : t('settings.user.delete.accountRequired.displayName'),
  )
  const normalizedExpectedAccount = computed(() =>
    normalizeAccountConfirmation(options.props.confirmationTarget, options.props.confirmationMode),
  )
  const isAccountConfirmationReady = computed(() =>
    normalizeAccountConfirmation(form.accountConfirmation, options.props.confirmationMode) === normalizedExpectedAccount.value,
  )
  const isPhraseConfirmationReady = computed(() => form.confirmationPhrase.trim() === options.props.confirmationPhrase)
  const isSubmitDisabled = computed(() =>
    options.props.isDeleting
    || !isAccountConfirmationReady.value
    || !isPhraseConfirmationReady.value,
  )
  const rules = computed<FormRules>(() => ({
    accountConfirmation: [
      {
        required: true,
        message: accountValidatorMessage.value,
        trigger: ['blur', 'change'],
      },
      {
        validator: (_rule, value: string, callback) => {
          if (normalizeAccountConfirmation(value, options.props.confirmationMode) !== normalizedExpectedAccount.value) {
            callback(new Error(accountValidatorMessage.value))
            return
          }

          callback()
        },
        trigger: ['blur', 'change'],
      },
    ],
    confirmationPhrase: [
      {
        required: true,
        message: t('settings.user.delete.confirmPhraseRequired', {
          phrase: options.props.confirmationPhrase,
        }),
        trigger: ['blur', 'change'],
      },
      {
        validator: (_rule, value: string, callback) => {
          if (value.trim() !== options.props.confirmationPhrase) {
            callback(new Error(t('settings.user.delete.confirmPhraseRequired', {
              phrase: options.props.confirmationPhrase,
            })))
            return
          }

          callback()
        },
        trigger: ['blur', 'change'],
      },
    ],
  }))

  function openDialog() {
    resetForm()
    isDialogVisible.value = true
  }

  function closeDialog() {
    isDialogVisible.value = false
    resetForm()
  }

  async function handleConfirm() {
    const isValid = await options.deleteFormRef.value?.validate().catch(() => false)

    if (!isValid) {
      return
    }

    options.onDeleteAccount({
      accountConfirmation: form.accountConfirmation.trim(),
      confirmationPhrase: options.props.confirmationPhrase,
    })
  }

  function resetForm() {
    form.accountConfirmation = ''
    form.confirmationPhrase = ''
    options.deleteFormRef.value?.clearValidate()
  }

  return {
    accountLabel,
    accountPlaceholder,
    form,
    handleConfirm,
    isDialogVisible,
    isSubmitDisabled,
    openDialog,
    closeDialog,
    resetForm,
    rules,
  }
}

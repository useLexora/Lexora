import type { AuthProviderName } from '@haohaoxue/lexora-contracts'
import type { FormInstance, FormItemRule, FormRules } from 'element-plus'
import type { Ref } from 'vue'
import type { UserAccountSectionProps } from '../typing'
import { AUTH_PROVIDER_VALUES } from '@haohaoxue/lexora-contracts/auth/constants'
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from '@haohaoxue/lexora-contracts/identity/constants'
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { AUTH_PROVIDER_UI_META } from '@/views/auth/utils/provider-ui'
import {
  isValidEmail,
  isValidPassword,
} from '@/views/auth/utils/rules'

const EMAIL_CODE_RE = /^\d{6}$/
type RuleValidator = NonNullable<FormItemRule['validator']>

function resolveTrimmedValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function useUserAccountSection(options: {
  code: Ref<string>
  confirmPassword: Ref<string>
  email: Ref<string>
  emailFormRef: Ref<FormInstance | null>
  newPassword: Ref<string>
  onConfirmEmail: () => void
  onDisconnectOauthBinding: (provider: AuthProviderName) => void
  onSendCode: () => void
  onStartOauthBinding: (provider: AuthProviderName) => void
  props: UserAccountSectionProps
}) {
  const { t } = useI18n({ useScope: 'global' })
  const form = reactive({
    email: options.email,
    code: options.code,
    newPassword: options.newPassword,
    confirmPassword: options.confirmPassword,
  })

  const requiresPasswordSetup = computed(() => !options.props.account.hasPasswordAuth)
  const hasEmailAccountInfo = computed(() => Boolean(options.props.account.email) || options.props.account.hasPasswordAuth)
  const showEmailStatus = computed(() => options.props.emailBindingEnabled || hasEmailAccountInfo.value)
  const normalizedEmail = computed(() => form.email.trim())
  const normalizedCode = computed(() => form.code.trim())
  const sectionDescription = computed(() => {
    if (options.props.emailBindingEnabled) {
      return t('settings.user.account.description.full')
    }

    if (hasEmailAccountInfo.value) {
      return t('settings.user.account.description.readonly')
    }

    return t('settings.user.account.description.oauthOnly')
  })

  const createEmailValidator = (): RuleValidator => (_rule, value, callback) => {
    if (!isValidEmail(resolveTrimmedValue(value))) {
      callback(new Error(t('settings.user.account.emailInvalid')))
      return
    }

    callback()
  }
  const createPasswordValidator = (fieldKey: 'password' | 'confirmPassword'): RuleValidator => (_rule, value, callback) => {
    const valueText = typeof value === 'string' ? value : ''
    const field = t(`settings.user.account.${fieldKey}`)

    if (!valueText) {
      callback()
      return
    }

    if (!isValidPassword(valueText)) {
      callback(new Error(t('settings.user.account.passwordRule', {
        field,
        min: AUTH_PASSWORD_MIN_LENGTH,
        max: AUTH_PASSWORD_MAX_LENGTH,
      })))
      return
    }

    callback()
  }
  const createConfirmPasswordValidator = (): RuleValidator => (_rule, value, callback) => {
    const valueText = typeof value === 'string' ? value : ''

    if (!valueText || valueText === form.newPassword) {
      callback()
      return
    }

    callback(new Error(t('settings.user.account.confirmPasswordMismatch')))
  }

  const emailFormRules = computed<FormRules>(() => ({
    email: [
      {
        required: true,
        message: t('settings.user.account.emailRequired'),
        transform: resolveTrimmedValue,
      },
      {
        validator: createEmailValidator(),
        trigger: ['blur', 'change'],
      },
    ],
    code: [
      {
        required: true,
        message: t('settings.user.account.codeRequired'),
      },
      {
        pattern: EMAIL_CODE_RE,
        message: t('settings.user.account.codeInvalid'),
      },
    ],
    newPassword: requiresPasswordSetup.value
      ? [
          {
            required: true,
            message: t('settings.user.account.passwordRequired', {
              field: t('settings.user.account.password'),
            }),
          },
          {
            validator: createPasswordValidator('password'),
          },
        ]
      : [],
    confirmPassword: requiresPasswordSetup.value
      ? [
          {
            required: true,
            message: t('settings.user.account.passwordRequired', {
              field: t('settings.user.account.confirmPassword'),
            }),
          },
          {
            validator: createConfirmPasswordValidator(),
          },
        ]
      : [],
  }))

  const oauthRows = computed(() => AUTH_PROVIDER_VALUES.map((provider) => {
    const account = options.props.account.oauthProviders[provider]
    const bindingState = options.props.oauthProviderBindingState[provider]

    return {
      provider,
      ...AUTH_PROVIDER_UI_META[provider],
      connected: account.connected,
      username: account.username,
      canDisconnect: bindingState.canDisconnect,
      canStartBinding: bindingState.canStartBinding,
    }
  }))

  const emailButtonText = computed(() => {
    if (requiresPasswordSetup.value) {
      return options.props.account.email
        ? t('settings.user.account.updateEmailWithPassword')
        : t('settings.user.account.bindEmailWithPassword')
    }

    return options.props.account.email ? t('settings.user.account.updateEmail') : t('settings.user.account.bindEmail')
  })
  const isSendCodeDisabled = computed(() =>
    options.props.isSendingCode || options.props.isBindingEmail || !isValidEmail(normalizedEmail.value),
  )
  const isConfirmEmailDisabled = computed(() =>
    options.props.isBindingEmail
    || options.props.isSendingCode
    || !isValidEmail(normalizedEmail.value)
    || !EMAIL_CODE_RE.test(normalizedCode.value)
    || (requiresPasswordSetup.value && !isValidPassword(form.newPassword))
    || (
      requiresPasswordSetup.value
      && (!form.confirmPassword || form.confirmPassword !== form.newPassword)
    ),
  )

  async function handleConfirmEmail() {
    const isValid = await options.emailFormRef.value?.validate().catch(() => false)

    if (!isValid) {
      return
    }

    options.onConfirmEmail()
  }

  function handleStartOauthBinding(provider: AuthProviderName) {
    const row = oauthRows.value.find(item => item.provider === provider)

    if (!row?.canStartBinding) {
      return
    }

    options.onStartOauthBinding(provider)
  }

  function handleSendCode() {
    if (isSendCodeDisabled.value) {
      return
    }

    options.onSendCode()
  }

  function handleDisconnect(provider: AuthProviderName) {
    options.onDisconnectOauthBinding(provider)
  }

  function clearEmailValidation() {
    options.emailFormRef.value?.clearValidate()
  }

  return {
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
  }
}

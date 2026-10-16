import type { AuthProviderName, SystemAuthProviderGovernance } from '@haohaoxue/lexora-contracts'
import type {
  SystemAuthGovernance,
  UpdateSystemAuthGovernanceRequest,
} from '@/apis/system-admin'
import { AUTH_PROVIDER_VALUES } from '@haohaoxue/lexora-contracts/auth/constants'
import { createSharedComposable } from '@vueuse/core'
import { computed, reactive, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getSystemAuthGovernance,
  updateSystemAuthGovernance,
  updateSystemAuthInviteCode,
} from '@/apis/system-admin'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { AUTH_PROVIDER_UI_META } from '@/views/auth/utils/provider-ui'

export type RegistrationGovernanceField = 'allowPasswordRegistration' | 'requirePasswordInviteCode' | `oauth:${AuthProviderName}:${'allowLogin' | 'allowRegistration' | 'requireInviteCode'}`

interface AuthGovernanceSwitchOption {
  key: RegistrationGovernanceField
  label: string
  description: string
}

export interface AuthGovernanceEntryCard {
  key: 'password' | AuthProviderName
  title: string
  description: string
  switches: readonly AuthGovernanceSwitchOption[]
}

function createOAuthGovernanceCards(t: ReturnType<typeof useI18n>['t']): AuthGovernanceEntryCard[] {
  return AUTH_PROVIDER_VALUES.map((provider) => {
    const title = AUTH_PROVIDER_UI_META[provider].title

    return {
      key: provider,
      title,
      description: t('admin.authGovernance.oauthDescription'),
      switches: [
        {
          key: `oauth:${provider}:allowLogin` as RegistrationGovernanceField,
          label: t('admin.authGovernance.login'),
          description: t('admin.authGovernance.loginDescription', { provider: title }),
        },
        {
          key: `oauth:${provider}:allowRegistration` as RegistrationGovernanceField,
          label: t('admin.authGovernance.register'),
          description: t('admin.authGovernance.registerProviderDescription', { provider: title }),
        },
        {
          key: `oauth:${provider}:requireInviteCode` as RegistrationGovernanceField,
          label: t('admin.authGovernance.inviteCode'),
          description: t('admin.authGovernance.requireInviteDescription'),
        },
      ],
    }
  })
}

function createDefaultOAuthProviderGovernance(): Record<AuthProviderName, SystemAuthProviderGovernance> {
  return Object.fromEntries(AUTH_PROVIDER_VALUES.map(provider => [provider, {
    allowLogin: false,
    allowRegistration: false,
    requireInviteCode: false,
  }])) as Record<AuthProviderName, SystemAuthProviderGovernance>
}

function parseOAuthGovernanceField(field: RegistrationGovernanceField): {
  provider: AuthProviderName
  option: keyof SystemAuthProviderGovernance
} {
  const [, provider, option] = field.split(':') as [
    'oauth',
    AuthProviderName,
    keyof SystemAuthProviderGovernance,
  ]

  return {
    provider,
    option,
  }
}

function buildGovernanceUpdatePayload(
  field: RegistrationGovernanceField,
  value: boolean,
): UpdateSystemAuthGovernanceRequest {
  if (field === 'allowPasswordRegistration' || field === 'requirePasswordInviteCode') {
    return { [field]: value }
  }

  const { provider, option } = parseOAuthGovernanceField(field)

  return {
    oauthProviders: {
      [provider]: {
        [option]: value,
      },
    },
  }
}

function setGovernanceSwitchValue(
  governance: SystemAuthGovernance,
  field: RegistrationGovernanceField,
  value: boolean,
) {
  if (field === 'allowPasswordRegistration' || field === 'requirePasswordInviteCode') {
    governance[field] = value
    return
  }

  const { provider, option } = parseOAuthGovernanceField(field)
  governance.oauthProviders[provider][option] = value
}

export const useAdminAuthGovernance = createSharedComposable(() => {
  const { t } = useI18n({ useScope: 'global' })
  const errorMessage = shallowRef('')
  const isInviteCodeDialogVisible = shallowRef(false)
  const isSavingInviteCode = shallowRef(false)
  const inviteCodeForm = reactive({
    inviteCode: '',
  })
  const savingGovernanceFields = reactive<Record<string, boolean>>({
    allowPasswordRegistration: false,
    requirePasswordInviteCode: false,
    ...Object.fromEntries(AUTH_PROVIDER_VALUES.flatMap(provider => [
      [`oauth:${provider}:allowLogin`, false],
      [`oauth:${provider}:allowRegistration`, false],
      [`oauth:${provider}:requireInviteCode`, false],
    ])),
  })
  const governance = reactive<SystemAuthGovernance>({
    allowPasswordRegistration: false,
    requirePasswordInviteCode: false,
    oauthProviders: createDefaultOAuthProviderGovernance(),
    hasRegistrationInviteCode: false,
    registrationInviteCode: null,
    emailServiceEnabled: false,
    systemAdminEmail: '',
    systemAdminDisplayName: null,
    systemAdminMustChangePassword: false,
    systemAdminLastLoginAt: null,
    systemAdminPasswordUpdatedAt: null,
  })
  const shouldShowMissingInviteCodeWarning = computed(() =>
    !governance.hasRegistrationInviteCode
    && (
      governance.requirePasswordInviteCode
      || AUTH_PROVIDER_VALUES.some(provider => governance.oauthProviders[provider].requireInviteCode)
    ),
  )
  const authGovernanceCards = computed<readonly AuthGovernanceEntryCard[]>(() => [
    {
      key: 'password',
      title: t('admin.authGovernance.emailPassword'),
      description: t('admin.authGovernance.emailPasswordDescription'),
      switches: [
        {
          key: 'allowPasswordRegistration',
          label: t('admin.authGovernance.register'),
          description: t('admin.authGovernance.registerDescription'),
        },
        {
          key: 'requirePasswordInviteCode',
          label: t('admin.authGovernance.inviteCode'),
          description: t('admin.authGovernance.requirePasswordInviteDescription'),
        },
      ],
    },
    ...createOAuthGovernanceCards(t),
  ])

  function applyGovernance(nextGovernance: SystemAuthGovernance) {
    Object.assign(governance, nextGovernance)
  }

  async function loadGovernance() {
    try {
      const nextGovernance = await getSystemAuthGovernance()
      applyGovernance(nextGovernance)
    }
    catch (error) {
      errorMessage.value = getRequestErrorDisplayMessage(error, t('admin.errors.loadGovernance'))
      throw error
    }
  }

  async function updateGovernanceOption(
    field: RegistrationGovernanceField,
    nextValue: boolean,
  ) {
    const previousValue = getGovernanceSwitchValue(field)
    setGovernanceSwitchValue(governance, field, nextValue)
    savingGovernanceFields[field] = true

    try {
      const nextGovernance = await updateSystemAuthGovernance(buildGovernanceUpdatePayload(field, nextValue))

      applyGovernance(nextGovernance)
      ElMessage.success(t('admin.authGovernance.updated', { field: getGovernanceFieldLabel(field) }))
    }
    catch (error) {
      setGovernanceSwitchValue(governance, field, previousValue)
      ElMessage.error(getRequestErrorDisplayMessage(error, t('admin.authGovernance.updateFailed', { field: getGovernanceFieldLabel(field) })))
    }
    finally {
      savingGovernanceFields[field] = false
    }
  }

  function shouldShowEmailServiceHint(key: RegistrationGovernanceField) {
    return key === 'allowPasswordRegistration' && !governance.emailServiceEnabled
  }

  function getGovernanceSwitchValue(key: RegistrationGovernanceField) {
    if (key === 'allowPasswordRegistration' && !governance.emailServiceEnabled) {
      return false
    }

    if (key === 'allowPasswordRegistration' || key === 'requirePasswordInviteCode') {
      return governance[key]
    }

    const field = parseOAuthGovernanceField(key)
    return governance.oauthProviders[field.provider][field.option]
  }

  function isGovernanceSwitchDisabled(key: RegistrationGovernanceField) {
    if (key === 'allowPasswordRegistration' && !governance.emailServiceEnabled) {
      return true
    }

    return savingGovernanceFields[key]
  }

  function handleGovernanceSwitchChange(
    key: RegistrationGovernanceField,
    value: string | number | boolean,
  ) {
    if (typeof value !== 'boolean') {
      return
    }

    void updateGovernanceOption(key, value)
  }

  function openInviteCodeDialog() {
    inviteCodeForm.inviteCode = governance.registrationInviteCode ?? ''
    isInviteCodeDialogVisible.value = true
  }

  async function updateInviteCode() {
    const inviteCode = inviteCodeForm.inviteCode.trim()

    if (inviteCode && inviteCode.length < 4) {
      ElMessage.error(t('admin.authGovernance.inviteCodeMin'))
      return
    }

    isSavingInviteCode.value = true

    try {
      const nextGovernance = await updateSystemAuthInviteCode({ inviteCode })
      applyGovernance(nextGovernance)
      isInviteCodeDialogVisible.value = false
      inviteCodeForm.inviteCode = ''
      ElMessage.success(inviteCode ? t('admin.authGovernance.inviteCodeUpdated') : t('admin.authGovernance.inviteCodeCleared'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('admin.authGovernance.updateInviteCodeFailed')))
    }
    finally {
      isSavingInviteCode.value = false
    }
  }

  function getGovernanceFieldLabel(field: RegistrationGovernanceField) {
    if (field === 'allowPasswordRegistration') {
      return t('admin.authGovernance.fields.allowPasswordRegistration')
    }

    if (field === 'requirePasswordInviteCode') {
      return t('admin.authGovernance.fields.requirePasswordInviteCode')
    }

    const { provider, option } = parseOAuthGovernanceField(field)
    const providerTitle = AUTH_PROVIDER_UI_META[provider].title

    if (option === 'allowLogin') {
      return t('admin.authGovernance.fields.oauthAllowLogin', { provider: providerTitle })
    }

    if (option === 'allowRegistration') {
      return t('admin.authGovernance.fields.oauthAllowRegistration', { provider: providerTitle })
    }

    return t('admin.authGovernance.fields.oauthRequireInviteCode', { provider: providerTitle })
  }

  return {
    authGovernanceCards,
    errorMessage,
    getGovernanceSwitchValue,
    governance,
    handleGovernanceSwitchChange,
    inviteCodeForm,
    isGovernanceSwitchDisabled,
    isInviteCodeDialogVisible,
    isSavingInviteCode,
    loadGovernance,
    openInviteCodeDialog,
    savingGovernanceFields,
    shouldShowEmailServiceHint,
    shouldShowMissingInviteCodeWarning,
    updateGovernanceOption,
    updateInviteCode,
  }
})

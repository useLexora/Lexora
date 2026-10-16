import type {
  AuthProviderName,
  DeleteCurrentUserRequest,
  UserSettings,
  WeixinBotBindingStatus,
  WeixinBotLoginStartResponse,
  WeixinBotLoginStatusResponse,
} from '@haohaoxue/lexora-contracts'

export type SettingsTabName = 'user' | 'preference' | 'providers'

export interface UserProfileSectionProps {
  avatarUrl: string | null
  userCode: string
  canEditAvatar: boolean
  canEditDisplayName: boolean
  isSavingDisplayName: boolean
  isUploading: boolean
}

export interface UserProfileSectionEmits {
  saveDisplayName: []
  upload: [file: File]
}

export interface UserAccountSectionProps {
  account: UserSettings['account']
  emailBindingEnabled: boolean
  isSendingCode: boolean
  isBindingEmail: boolean
  bindingProvider: AuthProviderName | null
  disconnectingProvider: AuthProviderName | null
  oauthProviderBindingState: Record<AuthProviderName, {
    canDisconnect: boolean
    canStartBinding: boolean
  }>
}

export interface UserAccountSectionEmits {
  sendCode: []
  confirmEmail: []
  startOauthBinding: [provider: AuthProviderName]
  disconnectOauthBinding: [provider: AuthProviderName]
}

export interface UserSettingsSectionHeaderProps {
  title: string
  description?: string
}

export interface BotsSectionProps {
  status: WeixinBotBindingStatus
  loginState: WeixinBotLoginStartResponse | WeixinBotLoginStatusResponse | null
  isLoading: boolean
  isStartingLogin: boolean
  isPollingLogin: boolean
  isSubmittingVerifyCode: boolean
  isStartingBot: boolean
  isStoppingBot: boolean
  isDisconnecting: boolean
}

export interface BotsSectionEmits {
  startLogin: []
  submitVerifyCode: []
  startRuntime: []
  stopRuntime: []
  disconnect: []
}

export interface UserPreferenceSectionProps {
  isSavingLanguage: boolean
  isSavingAppearance: boolean
}

export interface UserDeleteSectionProps {
  isDeleting: boolean
  confirmationTarget: string
  confirmationMode: 'email' | 'displayName'
  confirmationPhrase: DeleteCurrentUserRequest['confirmationPhrase']
}

export interface UserDeleteSectionEmits {
  deleteAccount: [payload: DeleteCurrentUserRequest]
}

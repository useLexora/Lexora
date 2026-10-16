import type {
  AppearancePreference,
  AuthProviderName,
  ConfirmBindEmailRequest,
  LanguagePreference,
  ResolvedLanguagePreference,
  SessionUser,
  UserSettings,
} from '@haohaoxue/lexora-contracts'
import type { DeepReadonly } from 'vue'
import { ROLES } from '@haohaoxue/lexora-contracts/rbac/constants'
import { APPEARANCE_PREFERENCE, LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import { resolveAppearancePreference, resolveLanguagePreference } from '@haohaoxue/lexora-shared/user'
import { usePreferredDark, usePreferredLanguages } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, reactive, readonly, shallowRef, watch } from 'vue'
import {
  confirmBindEmail,
  disconnectOauthBinding,
  getCurrentUser,
  getCurrentUserSettings,
  updateCurrentUserAvatar,
  updateCurrentUserProfile,
  updateUserPreferences,
} from '@/apis/user'
import { setI18nLocale } from '@/i18n'
import { setDayjsLocale } from '@/utils/dayjs'
import { STORAGE_KEY } from '@/utils/storage'

export const USER_PERSIST_KEY = STORAGE_KEY.user

function createDefaultPreferences(): UserSettings['preferences'] {
  return {
    language: LANGUAGE_PREFERENCE.AUTO,
    appearance: APPEARANCE_PREFERENCE.AUTO,
  }
}

function cloneCurrentUser(user: SessionUser): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    userCode: user.userCode,
    roles: [...user.roles],
    permissions: [...user.permissions],
    authMethods: [...user.authMethods],
    mustChangePassword: user.mustChangePassword,
    emailVerified: user.emailVerified,
  }
}

function clonePreferences(preferences: UserSettings['preferences']): UserSettings['preferences'] {
  return {
    language: preferences.language,
    appearance: preferences.appearance,
  }
}

function cloneUserSettings(settings: UserSettings): UserSettings {
  return {
    profile: {
      displayName: settings.profile.displayName,
      avatarUrl: settings.profile.avatarUrl,
    },
    account: {
      email: settings.account.email,
      userCode: settings.account.userCode,
      hasPasswordAuth: settings.account.hasPasswordAuth,
      emailVerified: settings.account.emailVerified,
      oauthProviders: structuredClone(settings.account.oauthProviders),
    },
    preferences: clonePreferences(settings.preferences),
  }
}

export const useUserStore = defineStore('user', () => {
  const _currentUser = shallowRef<SessionUser | null>(null)
  const _settings = shallowRef<UserSettings | null>(null)
  const _preferences = reactive<UserSettings['preferences']>(createDefaultPreferences())
  const preferredDark = usePreferredDark()
  const preferredLanguages = usePreferredLanguages()
  const isSavingLanguage = shallowRef(false)
  const isSavingAppearance = shallowRef(false)
  const currentUser = computed<DeepReadonly<SessionUser> | null>(() =>
    _currentUser.value as DeepReadonly<SessionUser> | null,
  )
  const settings = computed<DeepReadonly<UserSettings> | null>(() =>
    _settings.value as DeepReadonly<UserSettings> | null,
  )
  const preferences = readonly(_preferences) as DeepReadonly<UserSettings['preferences']>

  const systemMode = computed(() =>
    preferredDark.value ? APPEARANCE_PREFERENCE.DARK : APPEARANCE_PREFERENCE.LIGHT,
  )
  const resolvedAppearance = computed(() =>
    resolveAppearancePreference(_preferences.appearance, systemMode.value),
  )
  const resolvedLanguage = computed<ResolvedLanguagePreference>(() =>
    resolveLanguagePreference(_preferences.language, preferredLanguages.value),
  )
  const isDark = computed(() => resolvedAppearance.value === APPEARANCE_PREFERENCE.DARK)
  const isSystemAdmin = computed(() => _currentUser.value?.roles.includes(ROLES.SYSTEM_ADMIN) ?? false)
  const requiresPasswordChange = computed(() => _currentUser.value?.mustChangePassword ?? false)
  const defaultRouteName = computed(() => {
    if (requiresPasswordChange.value) {
      return 'change-password'
    }

    return 'home'
  })

  watch(resolvedAppearance, (value) => {
    if (typeof document === 'undefined') {
      return
    }

    document.documentElement.classList.toggle('dark', value === APPEARANCE_PREFERENCE.DARK)
  }, {
    immediate: true,
  })

  watch(resolvedLanguage, (value) => {
    setI18nLocale(value)
    setDayjsLocale(value)

    if (typeof document === 'undefined') {
      return
    }

    document.documentElement.lang = value
  }, {
    immediate: true,
  })

  function clear() {
    _currentUser.value = null
    _settings.value = null
    resetPreferences()
  }

  function setCurrentUser(nextUser: SessionUser) {
    _currentUser.value = cloneCurrentUser(nextUser)
  }

  function patchCurrentUserState(partial: Partial<SessionUser>) {
    if (!_currentUser.value) {
      return
    }

    _currentUser.value = cloneCurrentUser({
      ..._currentUser.value,
      ...partial,
    })
  }

  async function refreshContext() {
    const [nextUser, nextSettings] = await Promise.all([
      getCurrentUser(),
      getCurrentUserSettings(),
    ])

    setCurrentUser(nextUser)
    setSettings(nextSettings)
  }

  function hydratePreferences(nextPreferences: UserSettings['preferences']) {
    _preferences.language = nextPreferences.language
    _preferences.appearance = nextPreferences.appearance

    if (!_settings.value) {
      return
    }

    _settings.value = {
      ..._settings.value,
      preferences: clonePreferences(nextPreferences),
    }
  }

  function setSettings(nextSettings: UserSettings) {
    _settings.value = cloneUserSettings(nextSettings)
    hydratePreferences(nextSettings.preferences)
  }

  function patchSettings(mutator: (current: UserSettings) => UserSettings) {
    if (!_settings.value) {
      return
    }

    _settings.value = cloneUserSettings(mutator(cloneUserSettings(_settings.value)))
  }

  function resetPreferences() {
    hydratePreferences(createDefaultPreferences())
  }

  function setLocalLanguagePreference(nextLanguage: LanguagePreference) {
    if (_preferences.language === nextLanguage) {
      return
    }

    hydratePreferences({
      ...clonePreferences(_preferences),
      language: nextLanguage,
    })
  }

  async function refreshSettings() {
    const nextSettings = await getCurrentUserSettings()
    setSettings(nextSettings)
  }

  async function updateProfile(displayName: string) {
    const nextUser = await updateCurrentUserProfile({
      displayName,
    })

    setCurrentUser(nextUser)
    patchSettings(currentSettings => ({
      ...currentSettings,
      profile: {
        ...currentSettings.profile,
        displayName: nextUser.displayName,
      },
    }))
  }

  async function updateAvatar(file: File) {
    const result = await updateCurrentUserAvatar(file)

    patchCurrentUserState({
      avatarUrl: result.avatarUrl,
    })
    patchSettings(currentSettings => ({
      ...currentSettings,
      profile: {
        ...currentSettings.profile,
        avatarUrl: result.avatarUrl,
      },
    }))
  }

  async function updateLanguagePreference(nextLanguage: LanguagePreference) {
    if (isSavingLanguage.value || _preferences.language === nextLanguage) {
      return
    }

    const previousPreferences = clonePreferences(_preferences)
    isSavingLanguage.value = true
    hydratePreferences({
      ...previousPreferences,
      language: nextLanguage,
    })

    try {
      hydratePreferences(await updateUserPreferences({
        language: nextLanguage,
      }))
    }
    catch (error) {
      hydratePreferences(previousPreferences)
      throw error
    }
    finally {
      isSavingLanguage.value = false
    }
  }

  async function updateAppearancePreference(nextAppearance: AppearancePreference) {
    if (isSavingAppearance.value || _preferences.appearance === nextAppearance) {
      return
    }

    const previousPreferences = clonePreferences(_preferences)
    isSavingAppearance.value = true
    hydratePreferences({
      ...previousPreferences,
      appearance: nextAppearance,
    })

    try {
      hydratePreferences(await updateUserPreferences({
        appearance: nextAppearance,
      }))
    }
    catch (error) {
      hydratePreferences(previousPreferences)
      throw error
    }
    finally {
      isSavingAppearance.value = false
    }
  }

  async function bindEmail(payload: ConfirmBindEmailRequest) {
    const nextUser = await confirmBindEmail(payload)
    setCurrentUser(nextUser)
    await refreshSettings()
  }

  async function disconnectOauth(provider: AuthProviderName) {
    const nextUser = await disconnectOauthBinding(provider)
    setCurrentUser(nextUser)
    await refreshSettings()
  }

  return {
    _currentUser,
    _preferences,
    currentUser,
    settings,
    preferences,
    systemMode,
    resolvedAppearance,
    resolvedLanguage,
    isDark,
    isSystemAdmin,
    requiresPasswordChange,
    defaultRouteName,
    isSavingLanguage,
    isSavingAppearance,
    clear,
    setCurrentUser,
    setSettings,
    refreshContext,
    refreshSettings,
    resetPreferences,
    setLocalLanguagePreference,
    updateProfile,
    updateAvatar,
    updateLanguagePreference,
    updateAppearancePreference,
    bindEmail,
    disconnectOauth,
  }
}, {
  persist: {
    key: USER_PERSIST_KEY,
    pick: ['_currentUser', '_preferences'],
  },
})

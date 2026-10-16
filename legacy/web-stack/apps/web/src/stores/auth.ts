import type { RequestResponse } from '@haohaoxue/lexora-contracts'
import type { Router } from 'vue-router'
import type { TokenExchangeResponse } from '@/apis/auth'
import { SERVER_PATH } from '@haohaoxue/lexora-contracts/server'
import { useSessionStorage } from '@vueuse/core'
import rawAxios from 'axios'
import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import {
  changePassword,
  exchangeAuthCode,
  loginWithPassword,
  logoutAuthSession,
  registerWithPassword,
} from '@/apis/auth'
import { ADMIN_ROUTE_NAME } from '@/router/constants'
import { createRequestErrorFromResponseEnvelope, toRequestError } from '@/utils/request-error'
import { STORAGE_KEY } from '@/utils/storage'
import { useUiStore } from './ui'
import { useUserStore } from './user'
import { useWorkspaceStore } from './workspace'

export const AUTH_PERSIST_KEY = STORAGE_KEY.auth
export const AUTH_REDIRECT_KEY = STORAGE_KEY.authRedirect

const SESSION_REFRESH_LEEWAY_MS = 60_000
const SESSION_REFRESH_MIN_DELAY_MS = 5_000
const SESSION_REFRESH_RETRY_DELAY_MS = 30_000

const refreshClient = rawAxios.create({
  baseURL: SERVER_PATH,
  timeout: 6000 * 60,
  withCredentials: true,
})

export const useAuthStore = defineStore('auth', () => {
  const accessToken = shallowRef('')
  const accessTokenExpiresAt = shallowRef(0)
  const pendingRedirect = useSessionStorage(AUTH_REDIRECT_KEY, '')
  const userStore = useUserStore()
  const uiStore = useUiStore()
  const workspaceStore = useWorkspaceStore()
  let sessionRouter: Router | null = null
  let refreshPromise: Promise<TokenExchangeResponse | null> | null = null
  let sessionExpiryPromise: Promise<void> | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const isAuthenticated = computed(() => Boolean(accessToken.value))

  async function login(code: string) {
    const result = await exchangeAuthCode({ code })
    await applyAuthSession(result, {
      syncSettings: true,
    })
    return result
  }

  async function passwordLogin(email: string, password: string) {
    const result = await loginWithPassword({ email, password })
    await applyAuthSession(result, {
      syncSettings: true,
    })
    return result
  }

  async function passwordRegister(
    email: string,
    code: string,
    displayName: string,
    password: string,
    registrationInviteGrantToken?: string,
  ) {
    const result = await registerWithPassword({
      email,
      code,
      displayName,
      password,
      registrationInviteGrantToken,
    })
    await applyAuthSession(result, {
      syncSettings: true,
    })
    return result
  }

  async function updatePassword(currentPassword: string, newPassword: string) {
    const result = await changePassword({ currentPassword, newPassword })
    await applyAuthSession(result, {
      syncSettings: true,
    })
    return result
  }

  async function refreshToken() {
    const result = await refreshSession()

    if (!result) {
      throw new Error('Refresh session failed')
    }

    await Promise.all([
      userStore.refreshSettings().catch(() => null),
      workspaceStore.refreshVisibleWorkspaces().catch(() => null),
    ])
    return result
  }

  async function logout() {
    pendingRedirect.value = ''

    try {
      await logoutAuthSession()
    }
    catch {
    }
    finally {
      clearSession()
    }
  }

  function clearSession() {
    clearRefreshTimer()
    accessToken.value = ''
    accessTokenExpiresAt.value = 0
    pendingRedirect.value = ''
    uiStore.clearLastOpenedDocumentIds()
    workspaceStore.clear()
    userStore.clear()
  }

  async function applyAuthSession(
    result: TokenExchangeResponse,
    options: {
      syncSettings?: boolean
    } = {},
  ) {
    accessToken.value = result.accessToken
    accessTokenExpiresAt.value = Date.now() + result.expiresIn * 1000
    userStore.setCurrentUser(result.user)
    scheduleSessionRefresh(result.expiresIn)

    if (!options.syncSettings) {
      return
    }

    await Promise.all([
      userStore.refreshSettings().catch(() => null),
      workspaceStore.refreshVisibleWorkspaces().catch(() => null),
    ])
  }

  function installRouter(router: Router) {
    sessionRouter = router
  }

  async function refreshSession(): Promise<TokenExchangeResponse | null> {
    if (refreshPromise) {
      return refreshPromise
    }

    refreshPromise = requestRefreshSession()
      .then(async (result) => {
        await applyAuthSession(result)
        return result
      })
      .catch(async (error) => {
        if (isUnauthorizedRefreshError(error)) {
          await handleSessionExpired()
          return null
        }

        scheduleRefreshRetry()
        throw error
      })
      .finally(() => {
        refreshPromise = null
      })

    return refreshPromise
  }

  async function refreshSessionSilently(options: { redirectToLogin?: boolean } = {}) {
    try {
      return await refreshSession()
    }
    catch {
      return null
    }
    finally {
      if (!accessToken.value && options.redirectToLogin) {
        await navigateToLogin()
      }
    }
  }

  async function handleSessionExpired(options: { redirectPath?: string } = {}) {
    if (sessionExpiryPromise) {
      return sessionExpiryPromise
    }

    sessionExpiryPromise = (async () => {
      const redirectPath = options.redirectPath ?? resolveProtectedRedirectPath()

      clearSession()

      if (!redirectPath) {
        return
      }

      savePendingRedirect(redirectPath)
    })().finally(() => {
      sessionExpiryPromise = null
    })

    return sessionExpiryPromise
  }

  async function navigateToLogin(options: { redirectPath?: string } = {}) {
    if (!sessionRouter) {
      return
    }

    resetAdminRoute()

    const redirectPath = options.redirectPath ?? resolveProtectedRedirectPath()

    if (redirectPath) {
      savePendingRedirect(redirectPath)
    }

    if (sessionRouter.currentRoute.value.name === 'login') {
      return
    }

    await sessionRouter.replace(redirectPath
      ? {
          name: 'login',
          query: { redirect: redirectPath },
        }
      : {
          name: 'login',
        })
  }

  function savePendingRedirect(path: string) {
    pendingRedirect.value = path
  }

  function consumeRedirect() {
    const path = pendingRedirect.value || ''
    pendingRedirect.value = ''
    return path
  }

  function clearRefreshTimer() {
    if (refreshTimer == null) {
      return
    }

    clearTimeout(refreshTimer)
    refreshTimer = null
  }

  function scheduleSessionRefresh(expiresInSeconds: number) {
    const nextDelay = resolveRefreshDelay(expiresInSeconds)

    clearRefreshTimer()

    if (nextDelay == null) {
      return
    }

    refreshTimer = setTimeout(() => {
      void refreshSessionSilently({
        redirectToLogin: true,
      })
    }, nextDelay)
  }

  function scheduleRefreshRetry() {
    clearRefreshTimer()
    refreshTimer = setTimeout(() => {
      void refreshSessionSilently()
    }, SESSION_REFRESH_RETRY_DELAY_MS)
  }

  function resolveProtectedRedirectPath() {
    if (!sessionRouter) {
      return ''
    }

    const currentRoute = sessionRouter.currentRoute.value

    if (currentRoute.meta.public) {
      return ''
    }

    return currentRoute.fullPath
  }

  function resetAdminRoute() {
    if (!sessionRouter?.hasRoute(ADMIN_ROUTE_NAME)) {
      return
    }

    sessionRouter.removeRoute(ADMIN_ROUTE_NAME)
  }

  return {
    accessToken,
    accessTokenExpiresAt,
    isAuthenticated,
    installRouter,
    login,
    passwordLogin,
    passwordRegister,
    updatePassword,
    refreshToken,
    refreshSessionSilently,
    logout,
    clearSession,
    handleSessionExpired,
    navigateToLogin,
    savePendingRedirect,
    consumeRedirect,
  }
}, {
  persist: {
    key: AUTH_PERSIST_KEY,
    pick: ['accessToken'],
  },
})

function resolveRefreshDelay(expiresInSeconds: number) {
  const ttlMs = Math.max(expiresInSeconds * 1000, 0)

  if (ttlMs <= SESSION_REFRESH_MIN_DELAY_MS) {
    return null
  }

  const leewayMs = Math.min(
    SESSION_REFRESH_LEEWAY_MS,
    Math.max(Math.floor(ttlMs / 3), SESSION_REFRESH_MIN_DELAY_MS),
  )

  return Math.max(ttlMs - leewayMs, SESSION_REFRESH_MIN_DELAY_MS)
}

async function requestRefreshSession() {
  const response = await refreshClient.request<RequestResponse<TokenExchangeResponse>>({
    method: 'post',
    url: '/auth/refresh',
  })
  const responseData = response.data

  if (
    !responseData
    || (responseData.code !== 200 && responseData.code !== 201)
    || !responseData.data?.accessToken
    || !responseData.data.user
  ) {
    throw createRequestErrorFromResponseEnvelope(responseData, {
      source: 'axios',
      status: response.status,
    })
  }

  return responseData.data
}

function isUnauthorizedRefreshError(error: unknown) {
  const requestError = toRequestError(error, {
    source: 'axios',
  })

  return requestError.status === 401 || requestError.code === 401
}

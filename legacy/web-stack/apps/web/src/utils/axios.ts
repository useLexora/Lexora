import type { RequestResponse } from '@haohaoxue/lexora-contracts'
import { SERVER_PATH } from '@haohaoxue/lexora-contracts/server'
import { AUTH_ERROR_CODE } from '@haohaoxue/lexora-contracts/status-code'
import rawAxios, { AxiosHeaders } from 'axios'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { createRequestErrorFromResponseEnvelope, toRequestError } from '@/utils/request-error'

const http = rawAxios.create({
  baseURL: SERVER_PATH,
  timeout: 6000 * 60,
})

http.interceptors.request.use((config) => {
  if (config.withCookieAuth) {
    config.withCredentials = true
  }

  const headers = AxiosHeaders.from(config.headers)
  headers.set('Accept-Language', i18n.global.locale.value)
  config.headers = headers

  const authStore = useAuthStore()

  if (!authStore.accessToken) {
    return config
  }

  headers.set('Authorization', `Bearer ${authStore.accessToken}`)

  return config
})

http.interceptors.response.use(
  (response) => {
    const data = response.data as RequestResponse
    if (!data || (data.code !== 200 && data.code !== 201)) {
      return Promise.reject(createRequestErrorFromResponseEnvelope(data, {
        source: 'axios',
        status: response.status,
      }))
    }
    return data.data as any
  },
  async (error) => {
    const data = error.response?.data
    const status = error.response?.status
    const originalRequest = error.config
    let attemptedRefresh = false

    if (
      status === 401
      && originalRequest
      && !originalRequest._retry
      && !isRefreshRequest(originalRequest.url)
      && useAuthStore().accessToken
      && data?.code === AUTH_ERROR_CODE.ACCESS_TOKEN_EXPIRED
    ) {
      attemptedRefresh = true
      originalRequest._retry = true

      const refreshedSession = await useAuthStore().refreshSessionSilently({
        redirectToLogin: true,
      })

      if (refreshedSession?.accessToken) {
        const headers = AxiosHeaders.from(originalRequest.headers)
        headers.set('Authorization', `Bearer ${refreshedSession.accessToken}`)
        originalRequest.headers = headers
        return http.request(originalRequest)
      }
    }

    if (
      status === 401
      && !attemptedRefresh
      && useAuthStore().isAuthenticated
      && !isRefreshRequest(originalRequest?.url)
    ) {
      await useAuthStore().handleSessionExpired()
      await useAuthStore().navigateToLogin()
    }

    if (data != null) {
      return Promise.reject(createRequestErrorFromResponseEnvelope(data, {
        source: 'axios',
        status,
      }))
    }

    return Promise.reject(toRequestError(error, {
      source: 'axios',
      status,
    }))
  },
)

export { http as axios }

function isRefreshRequest(url?: string) {
  if (!url) {
    return false
  }

  return url.endsWith('/auth/refresh')
}

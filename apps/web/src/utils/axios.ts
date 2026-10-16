import axios from 'axios'
import { i18n, translate } from '@/i18n'

export const api = axios.create({ baseURL: '/api', timeout: 15000, headers: { 'X-Lexora-Request': 'community' } })
api.interceptors.request.use((request) => {
  request.headers.set('Accept-Language', i18n.global.locale.value)
  return request
})
export function errorMessage(error: unknown) {
  const code = axios.isAxiosError(error) ? error.response?.data?.errorCode : undefined
  const keys = {
    INVALID_INPUT: 'invalidInput',
    INVALID_MANIFEST: 'invalidInput',
    ALREADY_EXISTS: 'conflict',
    LOGIN_REQUIRED: 'signInRequired',
    ORIGIN_REJECTED: 'originRejected',
    PLUGIN_OWNED_BY_ANOTHER_PUBLISHER: 'wrongOwner',
    PLUGIN_NAMESPACE_REQUIRED: 'namespaceHint',
    HANDLE_RESERVED: 'reserved',
    PLUGIN_ID_RESERVED: 'reserved',
    OAUTH_STATE_INVALID: 'invalidState',
    ACCOUNT_ALREADY_LINKED: 'linkedElsewhere',
    HANDLE_IMMUTABLE: 'immutableHandle',
    RELEASE_STATE_CONFLICT: 'stateConflict',
    PLUGIN_NOT_FOUND: 'notFound',
    ADMIN_REQUIRED: 'adminRequired',
    PUBLISHER_REQUIRED: 'publisherNeeded',
  } as const
  return translate(keys[code as keyof typeof keys] ?? 'requestFailed')
}

import type { ApiErrorCode, RequestResponse } from '@haohaoxue/lexora-contracts'
import { API_ERROR_CODE } from '@haohaoxue/lexora-contracts/status-code'
import { translate } from '@/i18n'

export type RequestErrorKind = 'business' | 'http' | 'rate_limit' | 'network' | 'parse' | 'unknown'
export type RequestErrorSource = 'axios' | 'fetch' | 'stream' | 'unknown'

export interface RequestErrorOptions {
  source?: RequestErrorSource
  status?: number
  code?: number
  errorCode?: string
  message?: string
  data?: unknown
  bodyText?: string
  originalError?: unknown
}

const HTML_PATTERN = /<(?:!doctype|html|body|head|title|style|script|div|span|p|center|h1)\b/i
const TOO_MANY_REQUESTS_PATTERN = /\b429\b|too many requests/i
const NETWORK_ERROR_PATTERN = /network error|failed to fetch|load failed|timeout|network request failed/i
const PARSE_ERROR_PATTERN = /no response body|invalid response|unexpected token|unexpected end/i
const SERVER_ERROR_PATTERN = /bad gateway|service unavailable|gateway timeout|nginx|upstream|proxy error/i

type RequestErrorResolvedOptions = RequestErrorOptions & {
  kind: RequestErrorKind
  rawMessage: string
  detailMessage: string
  message: string
  source: RequestErrorSource
}

const API_ERROR_MESSAGE_KEY_BY_CODE: Partial<Record<ApiErrorCode, string>> = {
  [API_ERROR_CODE.AUTH_ACCESS_TOKEN_EXPIRED]: 'requestError.api.authAccessTokenExpired',
  [API_ERROR_CODE.SYSTEM_EMAIL_CONFIG_INCOMPLETE]: 'requestError.api.systemEmailConfigIncomplete',
  [API_ERROR_CODE.SYSTEM_EMAIL_PASSWORD_MISSING]: 'requestError.api.systemEmailPasswordMissing',
  [API_ERROR_CODE.SYSTEM_EMAIL_CONFIG_NOT_FOUND]: 'requestError.api.systemEmailConfigNotFound',
  [API_ERROR_CODE.SYSTEM_EMAIL_DISABLED]: 'requestError.api.systemEmailDisabled',
  [API_ERROR_CODE.EMAIL_BINDING_UNAVAILABLE]: 'requestError.api.emailBindingUnavailable',
  [API_ERROR_CODE.EMAIL_ALREADY_BOUND]: 'requestError.api.emailAlreadyBound',
  [API_ERROR_CODE.EMAIL_ALREADY_USED]: 'requestError.api.emailAlreadyUsed',
  [API_ERROR_CODE.EMAIL_CODE_RATE_LIMITED]: 'requestError.api.emailCodeRateLimited',
  [API_ERROR_CODE.EMAIL_CODE_EXPIRED]: 'requestError.api.emailCodeExpired',
  [API_ERROR_CODE.EMAIL_CODE_ATTEMPT_LIMIT_EXCEEDED]: 'requestError.api.emailCodeAttemptLimitExceeded',
  [API_ERROR_CODE.EMAIL_CODE_INVALID]: 'requestError.api.emailCodeInvalid',
  [API_ERROR_CODE.FIRST_EMAIL_BINDING_PASSWORD_REQUIRED]: 'requestError.api.firstEmailBindingPasswordRequired',
  [API_ERROR_CODE.REGISTRATION_EMAIL_EXISTS]: 'requestError.api.registrationEmailExists',
  [API_ERROR_CODE.REGISTRATION_CODE_RATE_LIMITED]: 'requestError.api.registrationCodeRateLimited',
  [API_ERROR_CODE.DISPLAY_NAME_REQUIRED]: 'requestError.api.displayNameRequired',
  [API_ERROR_CODE.NOTIFICATION_EMPTY_UPDATE]: 'requestError.api.notificationEmptyUpdate',
  [API_ERROR_CODE.NOTIFICATION_PUBLISHED_LOCKED]: 'requestError.api.notificationPublishedLocked',
  [API_ERROR_CODE.NOTIFICATION_ASSET_INVALID]: 'requestError.api.notificationAssetInvalid',
  [API_ERROR_CODE.NOTIFICATION_IMAGE_UNSUPPORTED_TYPE]: 'requestError.api.notificationImageUnsupportedType',
  [API_ERROR_CODE.NOTIFICATION_IMAGE_EMPTY]: 'requestError.api.notificationImageEmpty',
  [API_ERROR_CODE.NOTIFICATION_IMAGE_TOO_LARGE]: 'requestError.api.notificationImageTooLarge',
  [API_ERROR_CODE.NOTIFICATION_IMAGE_SIGNATURE_MISMATCH]: 'requestError.api.notificationImageSignatureMismatch',
  [API_ERROR_CODE.CHAT_MODEL_INPUT_MODALITY_UNSUPPORTED]: 'requestError.api.chatModelInputModalityUnsupported',
}

export class RequestError extends Error {
  readonly kind: RequestErrorKind
  readonly source: RequestErrorSource
  readonly status?: number
  readonly code?: number
  readonly errorCode?: string
  readonly data?: unknown
  readonly bodyText?: string
  readonly rawMessage: string
  readonly detailMessage: string
  readonly originalError?: unknown

  constructor(options: RequestErrorResolvedOptions) {
    super(options.message)
    this.name = 'RequestError'
    this.kind = options.kind
    this.source = options.source
    this.status = options.status
    this.code = options.code
    this.errorCode = options.errorCode
    this.data = options.data
    this.bodyText = options.bodyText
    this.rawMessage = options.rawMessage
    this.detailMessage = options.detailMessage
    this.originalError = options.originalError
    Object.setPrototypeOf(this, RequestError.prototype)
  }
}

export function createRequestError(options: RequestErrorOptions = {}) {
  const source = options.source ?? 'unknown'
  const status = getNumericValue(options.status)
  const code = getNumericValue(options.code) ?? getResponseCode(options.data)
  const errorCode = getStringValue(options.errorCode) ?? getResponseErrorCode(options.data)
  const rawMessage = resolveRawMessage(options)
  const detailMessage = sanitizeDetailMessage(rawMessage)
  const kind = resolveRequestErrorKind({
    status,
    code,
    errorCode,
    rawMessage,
    bodyText: options.bodyText,
  })

  return new RequestError({
    ...options,
    source,
    status,
    code,
    kind,
    rawMessage,
    detailMessage,
    message: buildTechnicalMessage(kind, status, code, detailMessage),
  })
}

export function createRequestErrorFromResponseEnvelope(
  envelope: RequestResponse | unknown,
  options: Omit<RequestErrorOptions, 'code' | 'data' | 'bodyText'> = {},
) {
  return createRequestError({
    ...options,
    code: getResponseCode(envelope),
    errorCode: getResponseErrorCode(envelope),
    data: envelope,
    bodyText: typeof envelope === 'string' ? envelope : undefined,
  })
}

export async function createRequestErrorFromHttpResponse(
  response: Response,
  options: Omit<RequestErrorOptions, 'status' | 'data' | 'bodyText'> = {},
) {
  const bodyText = await response.text()

  return createRequestError({
    ...options,
    status: response.status,
    data: parseResponseBody(bodyText) ?? undefined,
    bodyText,
  })
}

export function toRequestError(error: unknown, options: RequestErrorOptions = {}) {
  if (error instanceof RequestError) {
    return error
  }

  if (error instanceof Error) {
    const requestError = error as Error & {
      status?: unknown
      code?: unknown
      errorCode?: unknown
      data?: unknown
      bodyText?: unknown
    }

    return createRequestError({
      ...options,
      status: getNumericValue(requestError.status) ?? options.status,
      code: getNumericValue(requestError.code) ?? options.code,
      errorCode: getStringValue(requestError.errorCode) ?? options.errorCode,
      data: requestError.data ?? options.data,
      bodyText: typeof requestError.bodyText === 'string' ? requestError.bodyText : options.bodyText,
      message: requestError.message || options.message,
      originalError: error,
    })
  }

  if (error && typeof error === 'object') {
    const requestError = error as {
      status?: unknown
      code?: unknown
      errorCode?: unknown
      data?: unknown
      bodyText?: unknown
      message?: unknown
    }

    return createRequestError({
      ...options,
      status: getNumericValue(requestError.status) ?? options.status,
      code: getNumericValue(requestError.code) ?? options.code,
      errorCode: getStringValue(requestError.errorCode) ?? options.errorCode,
      data: requestError.data ?? options.data ?? error,
      bodyText: typeof requestError.bodyText === 'string' ? requestError.bodyText : options.bodyText,
      message: extractMessage(requestError.message) || options.message,
      originalError: error,
    })
  }

  return createRequestError({
    ...options,
    data: options.data ?? error,
    message: options.message,
    originalError: error,
  })
}

export function isRequestError(error: unknown): error is RequestError {
  return error instanceof RequestError
}

export function getRequestErrorDisplayMessage(error: unknown, fallback = translate('requestError.requestFailed')) {
  const requestError = toRequestError(error)
  const effectiveStatus = getEffectiveStatus(requestError.status, requestError.code)
  const apiErrorMessage = getApiErrorDisplayMessage(requestError.errorCode)

  if (apiErrorMessage) {
    return apiErrorMessage
  }

  switch (requestError.kind) {
    case 'business':
      return requestError.detailMessage || fallback
    case 'rate_limit':
      return translate('requestError.rateLimit')
    case 'network':
      return translate('requestError.network')
    case 'parse':
      return effectiveStatus && effectiveStatus >= 500
        ? translate('requestError.serverUnavailable')
        : translate('requestError.invalidResponse')
    case 'http':
      return effectiveStatus && effectiveStatus >= 500
        ? translate('requestError.serverUnavailable')
        : fallback
    default:
      return requestError.detailMessage || fallback
  }
}

function resolveRequestErrorKind(options: {
  status?: number
  code?: number
  errorCode?: string
  rawMessage: string
  bodyText?: string
}): RequestErrorKind {
  const effectiveStatus = getEffectiveStatus(options.status, options.code)
  const combinedText = collapseWhitespace([options.rawMessage, options.bodyText ?? ''].filter(Boolean).join(' '))

  if (effectiveStatus === 429 || TOO_MANY_REQUESTS_PATTERN.test(combinedText)) {
    return 'rate_limit'
  }

  if (NETWORK_ERROR_PATTERN.test(combinedText)) {
    return 'network'
  }

  if (looksLikeHtml(options.rawMessage) || looksLikeHtml(options.bodyText ?? '')) {
    return 'parse'
  }

  if (PARSE_ERROR_PATTERN.test(combinedText)) {
    return 'parse'
  }

  if (effectiveStatus && effectiveStatus >= 500) {
    return 'http'
  }

  if (SERVER_ERROR_PATTERN.test(combinedText)) {
    return 'http'
  }

  if (options.rawMessage) {
    return 'business'
  }

  if (effectiveStatus) {
    return 'http'
  }

  return 'unknown'
}

function buildTechnicalMessage(
  kind: RequestErrorKind,
  status: number | undefined,
  code: number | undefined,
  detailMessage: string,
) {
  const effectiveStatus = getEffectiveStatus(status, code)

  switch (kind) {
    case 'business':
      return detailMessage || 'Request Error'
    case 'rate_limit':
      return detailMessage || 'Too Many Requests'
    case 'network':
      return detailMessage || 'Network Error'
    case 'parse':
      return 'Invalid Response Body'
    case 'http':
      return effectiveStatus ? `HTTP ${effectiveStatus}` : 'HTTP Error'
    default:
      return detailMessage || 'Request Error'
  }
}

function resolveRawMessage(options: RequestErrorOptions) {
  const fromMessage = collapseWhitespace(extractMessage(options.message))
  if (fromMessage) {
    return fromMessage
  }

  const fromData = collapseWhitespace(extractMessage(options.data))
  if (fromData) {
    return fromData
  }

  const fromBodyText = typeof options.bodyText === 'string'
    ? collapseWhitespace(options.bodyText)
    : ''

  if (fromBodyText) {
    return fromBodyText
  }

  return ''
}

function sanitizeDetailMessage(message: string) {
  if (!message || looksLikeHtml(message)) {
    return ''
  }

  return message.length > 160 ? '' : message
}

function extractMessage(raw: unknown): string {
  if (raw instanceof Error) {
    return extractMessage(raw.message)
  }

  if (Array.isArray(raw)) {
    return raw
      .map(item => extractMessage(item))
      .filter(Boolean)
      .join('，')
  }

  if (typeof raw === 'string') {
    return raw
  }

  if (raw && typeof raw === 'object') {
    const requestError = raw as {
      error?: unknown
      message?: unknown
    }

    if (requestError.message != null) {
      return extractMessage(requestError.message)
    }

    if (requestError.error != null) {
      return extractMessage(requestError.error)
    }
  }

  return ''
}

function getEffectiveStatus(status?: number, code?: number) {
  if (isHttpErrorStatus(status)) {
    return status
  }

  if (isHttpErrorStatus(code)) {
    return code
  }

  return undefined
}

function isHttpErrorStatus(value?: number) {
  return typeof value === 'number' && value >= 400 && value <= 599
}

function getResponseCode(data: unknown) {
  if (!data || typeof data !== 'object') {
    return undefined
  }

  return getNumericValue((data as { code?: unknown }).code)
}

function getResponseErrorCode(data: unknown) {
  if (!data || typeof data !== 'object') {
    return undefined
  }

  return getStringValue((data as { errorCode?: unknown }).errorCode)
}

function getNumericValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function getStringValue(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined
}

function getApiErrorDisplayMessage(errorCode: string | undefined) {
  if (!errorCode) {
    return ''
  }

  const key = API_ERROR_MESSAGE_KEY_BY_CODE[errorCode as ApiErrorCode]

  return key ? translate(key, '') : ''
}

function collapseWhitespace(message: string) {
  return message.replace(/\s+/g, ' ').trim()
}

function looksLikeHtml(message: string) {
  return HTML_PATTERN.test(message)
}

function parseResponseBody(bodyText: string) {
  try {
    return JSON.parse(bodyText) as unknown
  }
  catch {
    return null
  }
}

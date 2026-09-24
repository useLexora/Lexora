import type { LocalRun } from '@buddy-shared/runs/runApi'

import type { BuddyI18nKey } from '@/i18n/buddyI18n'

export type ChatAgentTurnNotice
  = | { kind: 'activity', placement: 'process' }
    | { kind: 'cancelled', placement: 'result' }
    | { kind: 'failure', message: string | null, placement: 'result' }

export interface ChatAgentTurnFailurePresentation {
  detail: string | null
  message: string | null
  messageKey: BuddyI18nKey
}

const SPECIFIC_FAILURE_MESSAGE_KEYS: Readonly<Record<string, BuddyI18nKey>> = {
  AUTHENTICATION_REQUIRED: 'desktop.error.authenticationRequired',
  MODEL_NOT_SUPPORTED: 'desktop.chat.modelNotSupported',
  MODEL_INPUT_UNSUPPORTED: 'desktop.chat.modelInputUnsupported',
  MODEL_INPUT_TOO_LARGE: 'desktop.chat.modelInputTooLarge',
  RESOURCE_MATERIALIZATION_FAILED: 'desktop.chat.attachmentMaterializationFailed',
  MODEL_STREAM_INCOMPLETE: 'desktop.chat.modelStreamIncomplete',
  MODEL_REQUEST_TIMED_OUT: 'desktop.chat.modelRequestTimedOut',
  MODEL_SERVICE_UNAVAILABLE: 'desktop.chat.modelServiceUnavailable',
  MODEL_SERVICE_UNREACHABLE: 'desktop.chat.modelServiceUnreachable',
  PROVIDER_ACCESS_DENIED: 'desktop.chat.providerAccessDenied',
  PROVIDER_AUTHENTICATION_FAILED: 'desktop.chat.providerAuthenticationFailed',
  PROVIDER_RATE_LIMITED: 'desktop.chat.providerRateLimited',
  PROVIDER_UNAVAILABLE: 'desktop.error.providerUnavailable',
  SESSION_STORAGE_UNAVAILABLE: 'desktop.chat.sessionStorageUnavailable',
}

export function resolveChatAgentTurnNotice(
  status: LocalRun['status'],
  failureMessage: string | null,
): ChatAgentTurnNotice | null {
  if (status === 'queued' || status === 'running')
    return { kind: 'activity', placement: 'process' }
  if (status === 'failed')
    return { kind: 'failure', message: failureMessage, placement: 'result' }
  if (status === 'cancelled')
    return { kind: 'cancelled', placement: 'result' }
  return null
}

export function resolveChatAgentTurnFailurePresentation(
  errorCode: string | null,
  errorMessage: string | null,
): ChatAgentTurnFailurePresentation {
  const detail = errorMessage?.trim() || null
  const messageKey = errorCode ? SPECIFIC_FAILURE_MESSAGE_KEYS[errorCode] : undefined
  if (messageKey) {
    return {
      detail: detail === errorCode ? null : detail,
      message: null,
      messageKey,
    }
  }
  return {
    detail: null,
    message: detail,
    messageKey: errorCode === 'MODEL_REQUEST_FAILED'
      ? 'desktop.chat.modelRequestFailed'
      : 'desktop.chat.runFailed',
  }
}

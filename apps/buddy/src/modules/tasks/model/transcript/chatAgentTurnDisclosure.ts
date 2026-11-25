import type { ModelFailureFeedbackCode } from '@buddy-shared/providers/modelFailureFeedback'
import type { LocalRun } from '@buddy-shared/runs/runApi'

import type { BuddyI18nKey } from '@/i18n/buddyI18n'
import { modelFailureFeedback } from '@buddy-shared/providers/modelFailureFeedback'

export type ChatAgentTurnNotice
  = | { kind: 'activity', placement: 'process' }
    | { kind: 'cancelled', placement: 'result' }
    | { kind: 'failure', message: string | null, placement: 'result' }

export interface ChatAgentTurnFailurePresentation {
  detail: string | null
  message: string | null
  messageKey: BuddyI18nKey
}

const STORAGE_FAILURE_MESSAGE_KEYS = {
  MODEL_LAUNCH_NO_SPACE: 'desktop.chat.modelLaunchNoSpace',
  MODEL_LAUNCH_QUOTA_EXCEEDED: 'desktop.chat.modelLaunchQuotaExceeded',
  MODEL_STORAGE_NO_SPACE: 'desktop.chat.modelStorageNoSpace',
  MODEL_STORAGE_QUOTA_EXCEEDED: 'desktop.chat.modelStorageQuotaExceeded',
  MODEL_STORAGE_FULL: 'desktop.chat.modelStorageFull',
} satisfies Record<Exclude<ModelFailureFeedbackCode, 'MODEL_REQUEST_FAILED'>, BuddyI18nKey>

const SPECIFIC_FAILURE_MESSAGE_KEYS: Readonly<Record<string, BuddyI18nKey>> = {
  AUTHENTICATION_REQUIRED: 'desktop.error.authenticationRequired',
  MODEL_NOT_SUPPORTED: 'desktop.chat.modelNotSupported',
  MODEL_RESOURCES_CHANGED: 'desktop.chat.modelResourcesChanged',
  MODEL_RESOURCES_UNAVAILABLE: 'desktop.chat.modelResourcesUnavailable',
  MODEL_LOAD_FAILED: 'desktop.chat.modelLoadFailed',
  MODEL_ENGINE_TOO_OLD: 'desktop.chat.modelEngineTooOld',
  MODEL_ARCHITECTURE_UNSUPPORTED: 'desktop.chat.modelArchitectureUnsupported',
  MODEL_QUANTIZATION_UNSUPPORTED: 'desktop.chat.modelQuantizationUnsupported',
  MODEL_DRIVER_INCOMPATIBLE: 'desktop.chat.modelDriverIncompatible',
  MODEL_BACKEND_UNAVAILABLE: 'desktop.chat.modelBackendUnavailable',
  MODEL_RESOURCE_EXHAUSTED: 'desktop.chat.modelResourceExhausted',
  MODEL_PROCESS_EXITED: 'desktop.chat.modelProcessExited',
  MODEL_CONFIGURATION_CHANGED: 'desktop.chat.modelConfigurationChanged',
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
  launchFailure?: unknown,
): ChatAgentTurnFailurePresentation {
  const feedback = modelFailureFeedback(errorCode, launchFailure)
  if (feedback && feedback.code !== 'MODEL_REQUEST_FAILED')
    return { detail: feedback.location === 'unknown' ? null : feedback.location, message: null, messageKey: STORAGE_FAILURE_MESSAGE_KEYS[feedback.code] }
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

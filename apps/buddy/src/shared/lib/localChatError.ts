import type { BuddyLocale } from '@/i18n/buddyI18n'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'

import { translateBuddy } from '@/i18n/buddyI18n'

export function isProviderLoginCancelled(error: unknown): boolean {
  return error instanceof Error
    && parseLocalChatPublicError(error.message)?.code === 'PROVIDER_LOGIN_CANCELLED'
}

export function resolveLocalChatErrorMessage(error: unknown, language: BuddyLocale): string {
  const parsed = error instanceof Error ? parseLocalChatPublicError(error.message) : null
  if (!parsed)
    return translateBuddy(language, 'desktop.chat.unknownError')

  const keys = {
    APPROVAL_REQUIRED: 'desktop.error.approvalRequired',
    ATTACHMENT_LIMIT_EXCEEDED: 'desktop.chat.attachmentLimit',
    ATTACHMENT_UNSUPPORTED: 'desktop.chat.attachmentUnsupported',
    ATTACHMENT_TOO_LARGE: 'desktop.chat.attachmentTooLarge',
    ATTACHMENT_INVALID: 'desktop.chat.attachmentInvalid',
    ATTACHMENT_IMPORT_FAILED: 'desktop.chat.attachmentImportFailed',
    AUTOMATION_CONFLICT: 'desktop.error.automationConflict',
    AUTOMATION_INVALID_SCHEDULE: 'desktop.error.automationInvalidSchedule',
    AUTOMATION_NOT_FOUND: 'desktop.error.automationNotFound',
    AUTHENTICATION_REQUIRED: 'desktop.error.authenticationRequired',
    MCP_NAMESPACE_CONFLICT: 'desktop.mcp.error.MCP_NAMESPACE_CONFLICT',
    MCP_NAMESPACE_IMMUTABLE: 'desktop.mcp.error.MCP_NAMESPACE_IMMUTABLE',
    CONNECTOR_UNAVAILABLE: 'desktop.error.connectorUnavailable',
    CREDENTIAL_STORE_FAILURE: 'desktop.error.credentialStoreFailure',
    CREDENTIAL_STORE_UNAVAILABLE: 'desktop.error.credentialStore',
    DIRECTORY_NOT_AUTHORIZED: 'desktop.error.directoryNotAuthorized',
    DRAFT_CONFLICT: 'desktop.chat.draftChanged',
    LOCAL_CHAT_OPERATION_FAILED: 'desktop.chat.unknownError',
    MODEL_SYNC_FAILED: 'desktop.error.modelSyncFailed',
    MODEL_SYNC_UNSUPPORTED: 'desktop.error.modelSyncUnsupported',
    MODEL_INPUT_UNSUPPORTED: 'desktop.chat.modelInputUnsupported',
    MODEL_INPUT_TOO_LARGE: 'desktop.chat.modelInputTooLarge',
    PATH_OUTSIDE_GRANTED_DIRECTORY: 'desktop.error.pathOutsideDirectory',
    SKILL_NOT_FOUND: 'desktop.skills.error.SKILL_NOT_FOUND',
    SKILL_CHANGED: 'desktop.skills.error.SKILL_CHANGED',
    SKILL_INVALID: 'desktop.skills.error.SKILL_INVALID',
    SKILL_TOO_LARGE: 'desktop.skills.error.SKILL_TOO_LARGE',
    SKILL_BUSY: 'desktop.skills.error.SKILL_BUSY',
    SKILL_READ_ONLY: 'desktop.skills.error.SKILL_READ_ONLY',
    SKILL_INSTALL_FAILED: 'desktop.skills.error.SKILL_INSTALL_FAILED',
    SKILL_SOURCE_UNAVAILABLE: 'desktop.skills.error.SKILL_SOURCE_UNAVAILABLE',
    SKILL_PREVIEW_EXPIRED: 'desktop.skills.error.SKILL_PREVIEW_EXPIRED',
    SKILL_NAME_COLLISION: 'desktop.skills.error.SKILL_NAME_COLLISION',
    SPACE_HAS_ACTIVE_RUNS: 'desktop.error.spaceHasActiveRuns',
    SPACE_UNAVAILABLE: 'desktop.error.spaceUnavailable',
    PROVIDER_HAS_ACTIVE_RUNS: 'desktop.error.providerHasActiveRuns',
    PROVIDER_ID_CONFLICT: 'desktop.providers.identifierConflict',
    PROVIDER_LOGIN_CANCELLED: 'desktop.error.providerLoginCancelled',
    PROVIDER_UNAVAILABLE: 'desktop.error.providerUnavailable',
    RUNTIME_PROTOCOL_ERROR: 'desktop.error.runtimeProtocol',
    RUNTIME_UNAVAILABLE: 'desktop.error.runtimeUnavailable',
    VALIDATION_FAILED: 'desktop.error.validation',
  } as const
  return translateBuddy(language, keys[parsed.code])
}
